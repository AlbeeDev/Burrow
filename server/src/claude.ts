/**
 * Claude mode: drives a real Claude Code session per project and streams its structured
 * events to the client, so Burrow renders the session in its own chat design instead of the
 * native terminal TUI.
 *
 * PERSISTENT SESSIONS: one long-lived `claude --input-format stream-json`
 * process per project conversation, instead of a fresh process per message. stdin stays open;
 * each user message is one stream-json line; each turn's end is the CLI's `result` event (the
 * process no longer exits between turns). Buys: instant turn starts (no CLI boot + --resume
 * per message), interrupt via the stream-json control protocol instead of SIGTERM, and a
 * channel for interactive control requests (surfaced to the UI as real buttons). An idle
 * process is reaped after IDLE_MS and transparently respawned on the next message with
 * `--resume <sessionId>`: same conversation, nothing lost.
 *
 * Why not the Agent SDK: the SDK spawns Claude *inside* the Burrow container (no host
 * `docker`, container namespaces). Instead we spawn the real `claude` binary on the HOST via
 * nsenter (when BURROW_HOST_EXEC=1): the exact same environment and tool freedom as the
 * Terminal tab. The CLI's stream-json output is the same message shape the SDK yielded, so
 * the client reducer is unchanged. Session files land in the shared ~/.claude, so bubble,
 * terminal, and desktop CLI all continue one another via --resume/--continue.
 *
 * Auth: the active account's OAuth token is passed to the child via CLAUDE_CODE_OAUTH_TOKEN.
 */

import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Event } from "./protocol.js";
import type { EmitToConn } from "./terminal.js";
import type { AccountManager } from "./accounts.js";
import type { McpManager } from "./mcp.js";
import { asUser } from "./hostUser.js";

// Run the real `claude` on the HOST (host docker/PATH/namespaces) when host-exec is enabled,
// exactly like the terminal. NOTE the missing `-p` on nsenter: the container already runs
// `pid: host`, so entering the host pid namespace is redundant, and omitting it lets nsenter
// exec() straight into claude, so child.kill() reliably reaches claude itself.
const HOST_EXEC = process.env.BURROW_HOST_EXEC === "1";
function hostCmd(file: string, args: string[], cwd: string): { file: string; args: string[] } {
  if (!HOST_EXEC) return { file, args };
  // `--wdns=<cwd>` sets the working directory *inside the target namespace*. Without it,
  // entering the host mount ns invalidates the caller's cwd handle and claude falls back to
  // `/`, so every session lands in ~/.claude/projects/-/ (all projects colliding) and tools
  // run from `/` instead of the project (every project collides in one session dir).
  // As a real user when BURROW_HOST_USER says so, for the same reason the terminal does it: the
  // container's PATH is not this machine's. The cwd is handed to `asUser` as well as to `--wdns`,
  // because a login shell starts in the user's home, setting it only out here would be discarded
  // on the way in, and every project would collide in ~/.claude/projects/-/ again.
  const inner = asUser(file, args, cwd);
  return {
    file: "nsenter",
    args: ["-t", "1", "-m", "-u", "-i", "-n", `--wdns=${cwd}`, "--", inner.file, ...inner.args],
  };
}

/** process.env with undefined values dropped, plus the active account's token. */
function turnEnv(token: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/**
 * Does this project already have Claude Code session history on disk? If so, the first spawn
 * continues the most recent one (shared with the terminal + desktop CLI) rather than starting
 * fresh. Never deletes or modifies existing sessions.
 */
function hasExistingSession(cwd: string): boolean {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const dir = join(base, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  try {
    return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

// Reap an idle bubble process after this long; the next message respawns with --resume.
// Keeps RAM bounded (each live claude is a real Node process) without losing conversations.
const IDLE_MS = 15 * 60_000;
// If the CLI doesn't acknowledge an interrupt control request in this window, hard-kill.
const INTERRUPT_GRACE_MS = 3_000;

type BubbleSession = {
  proc?: ChildProcess;
  sessionId?: string;
  busy: boolean;
  aborted: boolean;
  connId: string; // latest client driving this project (reconnects update it)
  model?: string; // model the live proc was spawned with, change forces a respawn
  idleTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  reqSeq: number; // outgoing control_request ids
  queue: SendParams[]; // messages sent mid-turn, delivered FIFO as turns end
  recycleAfterTurn?: boolean; // settings changed mid-turn, respawn before the next turn
};

type SendParams = {
  connId: string;
  project: string | null;
  cwd: string;
  message: string;
  model?: string;
  fresh?: boolean;
};

export class ClaudeManager {
  // One conversation per project.
  private readonly sessions = new Map<string, BubbleSession>();
  // Slash commands the CLI declared for this project, read off its `system/init` frame. Kept
  // outside the session so an idle reap doesn't lose it, the list belongs to the CLI install
  // and the project, not to one process.
  private readonly slashCommands = new Map<string, string[]>();

  constructor(
    private readonly emit: EmitToConn,
    private readonly accounts: AccountManager,
    private readonly mcp: McpManager,
  ) {}

  private key(project: string | null): string {
    return project ?? " master";
  }

  /**
   * Pids of the bubble processes Burrow currently has running. Used to answer "is this MCP caller
   * one of ours" by ancestry: the `burrow` MCP server is a child of `claude`, and for a bubble
   * that `claude` is exactly this pid (the spawn execs into it, see the header note).
   */
  livePids(): number[] {
    const pids: number[] = [];
    for (const s of this.sessions.values()) if (s.proc?.pid) pids.push(s.proc.pid);
    return pids;
  }

  /** What the CLI declared for this project's last bubble session; empty until one has run. */
  knownSlashCommands(project: string | null): string[] {
    return this.slashCommands.get(this.key(project)) ?? [];
  }

  private push(s: BubbleSession, project: string | null, message: unknown): void {
    this.emit(s.connId, Event.ClaudeEvent, { project, message });
  }

  /** End a session's process gracefully: close stdin, then SIGTERM if it lingers. */
  private reap(s: BubbleSession, reason: string): void {
    const proc = s.proc;
    if (!proc) return;
    s.proc = undefined;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    try {
      proc.stdin?.end();
    } catch {
      /* already gone */
    }
    const hardKill = setTimeout(() => proc.kill("SIGTERM"), 5_000);
    proc.once("close", () => clearTimeout(hardKill));
    void reason; // (kept for future audit hooks)
  }

  private armIdleTimer(s: BubbleSession): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      if (!s.busy) this.reap(s, "idle");
    }, IDLE_MS);
  }

  /**
   * Spawn the long-lived CLI process for a session. stdin stays OPEN, messages are written
   * as stream-json lines; the process serves turn after turn until reaped or dead.
   */
  private spawnProc(
    s: BubbleSession,
    params: { project: string | null; cwd: string; model?: string; fresh?: boolean },
  ): void {
    const cliArgs = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode", "bypassPermissions", // v1: drives the user's own VPS
    ];
    if (params.model) cliArgs.push("--model", params.model);
    const disallowed = this.mcp.disallowedTools(params.cwd);
    if (disallowed.length) cliArgs.push("--disallowed-tools", ...disallowed);
    // Continue our own thread once started; else continue the project's most recent existing
    // session (terminal/desktop↔bubble continuity); else start fresh. `fresh` forces new.
    if (!params.fresh) {
      if (s.sessionId) cliArgs.push("--resume", s.sessionId);
      else if (hasExistingSession(params.cwd)) cliArgs.push("--continue");
    }

    const { file, args } = hostCmd("claude", cliArgs, params.cwd);
    const child = spawn(file, args, {
      cwd: params.cwd,
      env: turnEnv(this.accounts.activeToken()),
      stdio: ["pipe", "pipe", "pipe"],
    });
    s.proc = child;
    s.model = params.model;

    // Each stdout line is one JSON event. Forward everything the client renders verbatim;
    // handle turn boundaries (`result`) and the control protocol here.
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        const t = line.trim();
        if (!t) return;
        let msg: any;
        try {
          msg = JSON.parse(t);
        } catch {
          return;
        }
        if (msg.session_id) s.sessionId = msg.session_id;
        // The init frame is the only place the CLI says what slash commands this mode has, 
        // built-ins, plugin commands and skills included. It re-emits on `/clear`.
        if (msg.type === "system" && msg.subtype === "init" && Array.isArray(msg.slash_commands)) {
          this.slashCommands.set(
            this.key(params.project),
            msg.slash_commands.filter((c: unknown): c is string => typeof c === "string"),
          );
        }
        if (msg.type === "control_response") {
          // Ack of OUR interrupt (or other request), cancel the pending hard-kill.
          if (s.killTimer) {
            clearTimeout(s.killTimer);
            s.killTimer = undefined;
          }
          return; // protocol plumbing, not a chat event
        }
        this.push(s, params.project, msg);
        // `result` marks the end of a turn in a persistent process. Free the turn AFTER
        // forwarding result, then announce turn_end (same ordering the client expects).
        if (msg.type === "result") {
          s.busy = false;
          if (s.aborted) s.queue.length = 0; // Stop means stop, don't fire what's waiting
          s.aborted = false;
          this.push(s, params.project, { type: "turn_end" });
          if (s.recycleAfterTurn) {
            s.recycleAfterTurn = false;
            this.reap(s, "settings-change"); // next send respawns with --resume + new args
          }
          // Deliver the next queued message (FIFO); idle-reap only once the queue is dry.
          const next = s.queue.shift();
          if (next) void this.send(next);
          else if (s.proc) this.armIdleTimer(s);
        }
      });
    }

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
    });

    child.on("error", (err) => {
      if (s.proc === child) s.proc = undefined;
      if (s.busy) {
        s.busy = false;
        this.push(s, params.project, { type: "error", error: err.message });
        this.push(s, params.project, { type: "turn_end" });
      }
    });
    child.on("close", (code) => {
      if (s.proc === child) s.proc = undefined; // (reap() already cleared it for planned exits)
      if (s.killTimer) {
        clearTimeout(s.killTimer);
        s.killTimer = undefined;
      }
      // Dying mid-turn without an intentional abort is a real failure, surface it.
      if (s.busy) {
        s.busy = false;
        if (!s.aborted) {
          this.push(s, params.project, { type: "error", error: stderr.trim() || `claude exited with code ${code}` });
        } else {
          s.queue.length = 0;
        }
        s.aborted = false;
        this.push(s, params.project, { type: "turn_end" });
        // A crash doesn't strand what's queued: the next send respawns with --resume.
        const next = s.queue.shift();
        if (next) void this.send(next);
      }
    });
  }

  /** Run one user turn on the persistent process (spawning/respawning it if needed). */
  async send(params: SendParams): Promise<void> {
    const key = this.key(params.project);
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = { busy: false, aborted: false, connId: params.connId, reqSeq: 0, queue: [] }));
    s.connId = params.connId; // events follow the most recent client

    // Mid-turn sends queue instead of erroring; the result handler delivers them in order.
    if (s.busy) {
      s.queue.push(params);
      return;
    }

    // Recycle the live process when the conversation must change shape: a fresh chat (new
    // session) or a model switch (model is fixed at spawn). Respawn picks up --resume/fresh.
    if (s.proc && (params.fresh || (params.model && params.model !== s.model))) {
      this.reap(s, params.fresh ? "fresh": "model-change");
    }
    if (params.fresh) s.sessionId = undefined;

    s.busy = true;
    s.aborted = false;
    this.push(s, params.project, { type: "turn_start" });

    if (!s.proc) this.spawnProc(s, params);
    if (s.idleTimer) clearTimeout(s.idleTimer); // no reaping mid-turn

    s.proc?.stdin?.write(
      JSON.stringify({ type: "user", message: { role: "user", content: params.message } }) + "\n",
    );
    // stdin intentionally left OPEN: this is what keeps the process (and the next turn) warm.
  }

  /**
   * Recycle a project's persistent process so the next turn picks up changed spawn args
   * (per-project MCP disables). Idle → reap now; mid-turn → after the turn ends. The next
   * send respawns with --resume, so the conversation itself is untouched.
   */
  recycle(project: string | null): void {
    const s = this.sessions.get(this.key(project));
    if (!s?.proc) return;
    if (s.busy) s.recycleAfterTurn = true;
    else this.reap(s, "settings-change");
  }

  /**
   * Interrupt the in-flight turn (the Stop button). Sends the stream-json `interrupt` control
   * request: the CLI stops the turn and emits its result, and the process SURVIVES for the
   * next message. Falls back to SIGTERM if the CLI doesn't ack in time (next send respawns
   * with --resume, so even the hard path loses nothing).
   */
  async abort(project: string | null): Promise<void> {
    const s = this.sessions.get(this.key(project));
    if (!s?.proc || !s.busy) return;
    s.aborted = true;
    s.queue.length = 0; // Stop also drops anything waiting behind the turn
    const proc = s.proc;
    try {
      proc.stdin?.write(
        JSON.stringify({
          type: "control_request",
          request_id: `burrow_int_${++s.reqSeq}`,
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    } catch {
      proc.kill("SIGTERM");
      return;
    }
    if (s.killTimer) clearTimeout(s.killTimer);
    s.killTimer = setTimeout(() => {
      s.killTimer = undefined;
      proc.kill("SIGTERM");
    }, INTERRUPT_GRACE_MS);
  }

  /**
   * Answer a control request the CLI sent US (surfaced in the UI as buttons, e.g. a
   * permission/question prompt in a future non-bypass mode). Generic passthrough: the UI
   * hands back the request_id plus an arbitrary response object.
   */
  async respondControl(project: string | null, requestId: string, response: unknown): Promise<boolean> {
    const s = this.sessions.get(this.key(project));
    if (!s?.proc?.stdin) return false;
    try {
      s.proc.stdin.write(
        JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n",
      );
      return true;
    } catch {
      return false;
    }
  }
}
