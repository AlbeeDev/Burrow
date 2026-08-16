/**
 * Harness for the persistent bubble session (night 2026-07-27, approved item).
 * Proves, against the REAL host `claude` CLI (no gateway, no tmux, no live sessions):
 *   1. one process serves MULTIPLE turns (pid identical across turns, alive in between);
 *   2. a second turn completes on the same process;
 *   3. abort() interrupts a running turn and reports whether the process survived
 *      (control-protocol ack) or needed the SIGTERM fallback.
 * Run: npx tsx scripts/bubble-harness.ts   (from server/; needs CLAUDE_CODE_OAUTH_TOKEN in env)
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeManager } from "../src/claude.js";

const CWD = "/tmp/burrow-bubble-harness";
mkdirSync(CWD, { recursive: true });

// Same token source production uses (AccountManager reads ~/.bashrc); env fallback for CI-ish runs.
function token(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    return /sk-ant-oat01-[A-Za-z0-9_-]+/.exec(readFileSync(join(homedir(), ".bashrc"), "utf8"))?.[0];
  } catch {
    return undefined;
  }
}

type Ev = { type: string; [k: string]: unknown };
const events: Ev[] = [];
const emit = (_conn: string, _event: string, payload: any) => {
  const m = payload?.message;
  if (m?.type) events.push(m);
};

const manager = new ClaudeManager(emit as any, { activeToken: token } as any, {
  disallowedTools: () => [],
} as any);

function waitFor(pred: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 200);
  });
}

/** PIDs of live `claude -p --output-format stream-json` children of this process. */
function claudeChildren(): number[] {
  const out: number[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.split(") ")[1]?.split(" ")[1]);
      if (ppid !== process.pid) continue;
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8");
      if (cmd.includes("stream-json")) out.push(Number(d));
    } catch {
      /* proc vanished mid-scan */
    }
  }
  return out;
}

function counts(): Record<string, number> {
  return events.reduce<Record<string, number>>((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
}

/** The result event of turn N (0-based among result events); must be a real, non-error success. */
function assertRealResult(n: number, expect: string): void {
  const results = events.filter((e) => e.type === "result") as any[];
  const r = results[n];
  if (!r) throw new Error(`no result event for turn ${n + 1}`);
  if (r.is_error) throw new Error(`turn ${n + 1} result is an ERROR: ${String(r.result).slice(0, 120)}`);
  if (typeof r.result === "string" && !r.result.includes(expect)) {
    throw new Error(`turn ${n + 1} result missing "${expect}": ${String(r.result).slice(0, 120)}`);
  }
}

async function main() {
  const t0 = Date.now();

  // Turn 1
  await manager.send({ connId: "h", project: "harness", cwd: CWD, message: "Reply with exactly: ALPHA", fresh: true });
  await waitFor(() => events.some((e) => e.type === "turn_end"), 90_000, "turn 1 end");
  assertRealResult(0, "ALPHA");
  const pidsAfter1 = claudeChildren();
  console.log(`[turn1] done in ${Date.now() - t0}ms; live claude pids after: ${pidsAfter1.join(",") || "NONE"}`);
  if (pidsAfter1.length !== 1) throw new Error(`expected exactly 1 persistent process, got ${pidsAfter1.length}`);

  // Turn 2: must reuse the SAME process.
  const t1 = Date.now();
  const endsBefore = events.filter((e) => e.type === "turn_end").length;
  await manager.send({ connId: "h", project: "harness", cwd: CWD, message: "Reply with exactly: BETA" });
  await waitFor(() => events.filter((e) => e.type === "turn_end").length > endsBefore, 90_000, "turn 2 end");
  assertRealResult(1, "BETA");
  const pidsAfter2 = claudeChildren();
  console.log(`[turn2] done in ${Date.now() - t1}ms; pids after: ${pidsAfter2.join(",") || "NONE"}`);
  if (pidsAfter2.length !== 1 || pidsAfter2[0] !== pidsAfter1[0]) {
    throw new Error(`process not persistent across turns: ${pidsAfter1[0]} -> ${pidsAfter2.join(",")}`);
  }

  // Turn 3: interrupt mid-turn. Only count events that arrive AFTER this point.
  const t2 = Date.now();
  const mark = events.length;
  const endsBefore3 = events.filter((e) => e.type === "turn_end").length;
  await manager.send({ connId: "h", project: "harness", cwd: CWD, message: "Count slowly from 1 to 40, one number per line, no shortcuts." });
  await waitFor(
    () => events.slice(mark).some((e) => e.type === "stream_event" || e.type === "assistant"),
    60_000,
    "turn 3 streaming",
  );
  await manager.abort("harness");
  await waitFor(() => events.filter((e) => e.type === "turn_end").length > endsBefore3, 15_000, "turn 3 end after abort");
  const pidsAfter3 = claudeChildren();
  const survived = pidsAfter3.length === 1 && pidsAfter3[0] === pidsAfter1[0];
  console.log(
    `[turn3] aborted, ended in ${Date.now() - t2}ms; process ${survived ? "SURVIVED (control-protocol interrupt)": "was killed (SIGTERM fallback)"}`,
  );

  // Turns 4+5: mid-turn send QUEUES and auto-delivers FIFO (night 2026-07-28 item).
  // Fire GAMMA, then immediately send DELTA while GAMMA's turn is running; both must
  // complete, in order, without an "already running" error.
  const t3 = Date.now();
  const mark4 = events.length;
  const endsBefore4 = events.filter((e) => e.type === "turn_end").length;
  await manager.send({ connId: "h", project: "harness", cwd: CWD, message: "Reply with exactly: GAMMA" });
  await manager.send({ connId: "h", project: "harness", cwd: CWD, message: "Reply with exactly: DELTA" });
  await waitFor(() => events.filter((e) => e.type === "turn_end").length >= endsBefore4 + 2, 180_000, "queued turns end");
  const tail = events.slice(mark4);
  if (tail.some((e) => e.type === "error")) {
    throw new Error(`queueing produced an error event: ${JSON.stringify(tail.find((e) => e.type === "error"))}`);
  }
  const qResults = tail.filter((e) => e.type === "result") as any[];
  if (qResults.length !== 2) throw new Error(`expected 2 queued-phase results, got ${qResults.length}`);
  for (const [i, expect] of [[0, "GAMMA"], [1, "DELTA"]] as const) {
    const r = qResults[i];
    if (r.is_error) throw new Error(`queued turn ${i + 1} result is an ERROR: ${String(r.result).slice(0, 120)}`);
    if (typeof r.result === "string" && !r.result.includes(expect)) {
      throw new Error(`queue order broken: result ${i + 1} missing "${expect}": ${String(r.result).slice(0, 120)}`);
    }
  }
  console.log(`[queue] GAMMA then DELTA delivered FIFO in ${Date.now() - t3}ms`);

  console.log(`[events] ${JSON.stringify(counts())}`);
  console.log("HARNESS_OK multi-turn=1-process interrupt=" + (survived ? "graceful": "fallback") + " queue=fifo");
  process.exit(0);
}

main().catch((err) => {
  console.error("HARNESS_FAIL", err.message);
  console.error(`[events] ${JSON.stringify(counts())}`);
  process.exit(1);
});
