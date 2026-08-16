/**
 * Harness for the scheduler's wake-dead-sessions path (night 2026-07-28 item).
 * Runs ENTIRELY on a separate tmux socket (BURROW_TMUX_SOCKET=burrow_test_wake), it can
 * never see or touch the live `burrow` socket's sessions, and it arms no schedules.
 * Proves:
 *   1. startDetached() creates a session running the real `claude` TUI, and
 *      waitForPrompt() detects readiness ("? for shortcuts");
 *   2. sendKeys() after readiness lands the message in the session (visible on screen);
 *   3. a session that never shows the prompt (plain sleep) times out → caller-side skip.
 * Run: ./node_modules/.bin/tsx scripts/wake-harness.ts   (from server/)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET = "burrow_test_wake";
process.env.BURROW_TMUX_SOCKET = SOCKET;
delete process.env.BURROW_HOST_EXEC; // run tmux directly, we're already on the host

const CWD = "/tmp/burrow-wake-harness";
mkdirSync(CWD, { recursive: true });

function token(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    return /sk-ant-oat01-[A-Za-z0-9_-]+/.exec(readFileSync(join(homedir(), ".bashrc"), "utf8"))?.[0];
  } catch {
    return undefined;
  }
}

function cleanup(): void {
  try {
    execFileSync("tmux", ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
  } catch {
    /* no test server left: fine */
  }
}

async function main() {
  // Import AFTER the env override so the module-level socket constant picks it up.
  const { TerminalManager } = await import("../src/terminal.js");
  const { ensureTrusted } = await import("../src/trust.js");
  const terminals = new TerminalManager("/root", () => {});
  ensureTrusted(CWD); // the production wake path does this too, else the trust dialog blocks

  cleanup(); // stale test server from an aborted run must not fake results

  // 1) Wake: dead chat -> started detached with the REAL claude launch -> prompt appears.
  const t0 = Date.now();
  const live0 = await terminals.liveTmuxNames();
  if (live0.size !== 0) throw new Error(`test socket not empty at start: ${[...live0].join(",")}`);
  const tok = token();
  if (!tok) throw new Error("no OAuth token found (env or ~/.bashrc), can't run a real claude wake");
  const base = "claude --dangerously-skip-permissions";
  const started = await terminals.startDetached({
    project: "waketest",
    cwd: CWD,
    launchCommand: `${base} -c || ${base}; exec bash`,
    injectEnv: { CLAUDE_CODE_OAUTH_TOKEN: tok, IS_SANDBOX: "1" },
  });
  if (!started) throw new Error("startDetached failed to create the tmux session");
  const ready = await terminals.waitForPrompt("waketest", 90_000, 2_000);
  if (!ready) {
    const pane = await terminals.capturePane(terminals.tmuxName("waketest"));
    throw new Error(`prompt never became ready; screen was:\n${pane.slice(-800)}`);
  }
  console.log(`[wake] session started + prompt ready in ${Date.now() - t0}ms`);

  // 2) Inject after readiness: the message must reach the session's screen.
  const MSG = "Reply with exactly: WAKE_OK";
  if (!(await terminals.sendKeys("waketest", MSG))) throw new Error("sendKeys reported not-live");
  await new Promise((r) => setTimeout(r, 3_000));
  const pane = await terminals.capturePane(terminals.tmuxName("waketest"));
  if (!pane.includes("WAKE_OK")) throw new Error(`injected text not on screen:\n${pane.slice(-800)}`);
  console.log("[inject] message visible in the woken session");

  // 3) A pane left in COPY-MODE must still receive the message.
  //
  // Deliberately a SHELL pane, not a Claude one, because that is where the swallow is real: keys
  // sent to a scrolled-back pane are read as copy-mode commands and vanish, no trace in the
  // application, none in the scrollback. Measured, not assumed: against a live Claude TUI the
  // message lands either way, so a check written there passes with the fix removed and guards
  // nothing (2026-08-10).
  //
  // A shell pane is exactly the state a Burrow session falls into when Claude exits and
  // `exec bash` takes over: combined with a scroll, that is total silence, which is what a
  // scheduled message actually disappeared into.
  await terminals.startDetached({ project: "copymode", cwd: CWD, launchCommand: "bash --norc -i" });
  await new Promise((r) => setTimeout(r, 800));
  const copyName = terminals.tmuxName("copymode");
  execFileSync("tmux", ["-L", SOCKET, "copy-mode", "-t", copyName]);
  execFileSync("tmux", ["-L", SOCKET, "send-keys", "-t", copyName, "-X", "cursor-up"]);
  if (execFileSync("tmux", ["-L", SOCKET, "display-message", "-p", "-t", copyName, "#{pane_in_mode}"], { encoding: "utf8" }).trim() !== "1") {
    throw new Error("could not park the pane in copy-mode, this check would prove nothing");
  }
  await terminals.sendKeys("copymode", "echo COPYMODE_OK");
  await new Promise((r) => setTimeout(r, 1_200));
  const pane2 = await terminals.capturePane(copyName);
  if (!pane2.includes("COPYMODE_OK")) throw new Error(`copy-mode swallowed the message:\n${pane2.slice(-400)}`);
  console.log("[copy-mode] message still lands in a scrolled-back pane");

  // 4) Timeout path: a session that never shows Claude's prompt must return false (skip).
  const t1 = Date.now();
  await terminals.startDetached({ project: "waketimeout", cwd: CWD, launchCommand: "sleep 300" });
  const readyTimeout = await terminals.waitForPrompt("waketimeout", 6_000, 1_000);
  if (readyTimeout) throw new Error("timeout path FAILED: sleep session reported ready");
  console.log(`[timeout] non-claude session correctly timed out in ${Date.now() - t1}ms (skip path)`);

  cleanup();
  console.log("WAKE_HARNESS_OK wake=ready inject=visible copymode=lands timeout=skips");
  process.exit(0);
}

main().catch((err) => {
  console.error("WAKE_HARNESS_FAIL", err.message);
  cleanup();
  process.exit(1);
});
