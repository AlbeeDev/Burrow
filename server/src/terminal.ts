/**
 * Terminal session manager.
 *
 * Each open spawns a PTY attached to a per-project tmux session
 * (`tmux new-session -A -s <name>`), so a dropped connection detaches rather than
 * kills: reconnecting reattaches with the shell and any running processes intact.
 * This is Burrow's "connection drops don't kill your work" guarantee.
 *
 * Pattern mirrors OpenClaw's src/gateway/terminal/session-manager.ts (MIT): PTY
 * onData chunks become `terminal.data` events, tagged with a per-session seq counter.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { spawnPty, type PtyHandle } from "./pty.js";
import { Event } from "./protocol.js";
import { isPersistent } from "./persistence.js";
import { parsePanes, type Pane } from "./sessionStats.js";
import { drainVerdict, Holds } from "./drain.js";
import { audit } from "./audit.js";
import { asUser, inLoginShell } from "./hostUser.js";
import { composerHolds, looksReady } from "./inject.js";

/** Pushes an event to one client connection. */
export type EmitToConn = (connId: string, event: string, payload: unknown) => void;

type Session = {
  id: string;
  connId: string;
  project: string | null;
  tmux: string;
  pty: PtyHandle;
  seq: number;
};

// When BURROW_HOST_EXEC=1, run tmux (and therefore the `claude`/shell inside it) in the
// HOST's namespaces via nsenter instead of inside the container. This gives real tool
// parity with a native SSH session (host's docker, python, PATH, everything) AND moves the
// tmux server onto the host, so sessions survive Burrow container rebuilds. Requires the
// container to run privileged with pid:host (see docker-compose.yml). Flag off = the
// original in-container behavior, so this is fully reversible.
const HOST_EXEC = process.env.BURROW_HOST_EXEC === "1";

/** Wrap a command so it runs on the host (via nsenter) when host-exec is enabled. */
function hostCmd(file: string, args: string[]): { file: string; args: string[] } {
  if (!HOST_EXEC) return { file, args };
  // …and as a real user, with their own login shell, when BURROW_HOST_USER says who. Without it we
  // arrive as root holding the container's PATH, which points at directories that are empty out
  // here. See hostUser.ts. Unset leaves this exactly as it was.
  const inner = asUser(file, args);
  return { file: "nsenter", args: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", inner.file, ...inner.args] };
}

// All tmux traffic goes to a NAMED socket (`-L <socket>`) that a host systemd service owns
// (deploy/burrow-tmux.service), instead of the default socket. That service starts the tmux
// server inside the host's OWN cgroup (system.slice/…), making it a SIBLING of the burrow-app
// container's cgroup rather than a child of it. Consequence: recreating/rebuilding the container
// no longer tears down the tmux server, so terminal sessions (and the running `claude` inside
// them) survive a deploy. If the service isn't running, `tmux -L <socket>` still auto-starts a
// server (in the container's cgroup, as before), so this is never worse than the old behavior,
// it just unlocks rebuild-survival once the host service pre-owns the socket.
const TMUX_SOCKET = process.env.BURROW_TMUX_SOCKET?.trim() || "burrow";

/** Build a tmux command on Burrow's shared socket, host-exec-wrapped when enabled. */
function tmuxCmd(args: string[]): { file: string; args: string[] } {
  return hostCmd("tmux", ["-L", TMUX_SOCKET, ...args]);
}


/**
 * Best-effort kill of a tmux session by name (it may already be gone).
 * Safety guard: refuses to kill anything not named `burrow_*`, so a logic bug can never
 * reap a session Burrow didn't create. A refusal is logged loudly, it should never fire.
 */
function killTmuxSession(name: string, reason: string): void {
  if (!name.startsWith("burrow_")) {
    audit("kill_refused", { name, reason }, "error");
    return;
  }
  audit("session_kill", { name, reason });
  const { file, args } = tmuxCmd(["kill-session", "-t", name]);
  execFile(file, args, () => {});
}

/**
 * Last output activity of a tmux session, in epoch ms, or null if it's gone.
 * tmux updates `session_activity` on pane output even with no client attached, so this
 * tells us whether a detached session is still doing work. (Older tmux reports seconds,
 * newer ms; normalize.)
 */
function tmuxActivityMs(name: string): Promise<number | null> {
  const { file, args } = tmuxCmd(["display-message", "-p", "-t", name, "#{session_activity}"]);
  return new Promise((resolve) => {
    execFile(file, args, (err, stdout) => {
      if (err) return resolve(null);
      const n = parseInt(String(stdout).trim(), 10);
      if (!Number.isFinite(n)) return resolve(null);
      resolve(n > 1e12 ? n: n * 1000);
    });
  });
}

// An ephemeral session isn't killed the instant its browser leaves, it's watched, and
// killed only once it's been silent (no output) for QUIET_MS, so a mid-turn task or a
// flaky connection never loses work. Reconnecting cancels the pending kill.
const QUIET_MS = 90_000;
const POLL_MS = 5_000;

/** tmux session names may not contain `.` or `:`; keep it to a safe charset. */
function tmuxSessionName(project: string | null): string {
  const base = project && project.trim() ? project.trim(): "master";
  return "burrow_" + base.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Per-session tmux options, applied ON CREATE by both open() and startDetached(). They must
// match: a scheduler-started session is later reattached by open() (`-A` skips creation, so
// options set here are all it ever gets).
const SESSION_OPTIONS = [
  ";", "set-option", "status", "off",
  ";", "set-window-option", "aggressive-resize", "on",
  // Disable the tmux command prefix (Ctrl-b). Burrow uses tmux purely as an invisible
  // persistence layer: the user never runs tmux commands, so a pasted Ctrl-b must NOT
  // be interpreted as a prefix. This is the ROOT fix for paste-splits-the-pane (proven:
  // Ctrl-b " splits with a prefix, does nothing without). Covers every paste path.
  ";", "set-option", "prefix", "None",
  ";", "set-option", "prefix2", "None",
  // Forward apps' OSC 52 clipboard writes (Claude's /login code, etc.) out to the
  // browser terminal, which turns them into real system-clipboard writes. tmux
  // defaults to "external" which does NOT forward; set per-session (not -g) so the
  // host's global tmux is untouched.
  ";", "set-option", "set-clipboard", "on",
  // Mouse mode: wheel scrolls tmux history, drag-select copies (via OSC 52 above).
  ";", "set-option", "mouse", "on",
  // Puppet hardening: tmux is a dumb pipe for Claude, strip everything else:
  ";", "set-option", "-s", "escape-time", "0", // no ESC-key lag in Claude's TUI
  ";", "set-option", "-g", "focus-events", "on", // Claude's TUI requests this
  ";", "set-option", "-g", "bell-action", "none", // no bell noise
  ";", "set-option", "-g", "visual-bell", "off",
  ";", "unbind-key", "-n", "MouseDown3Pane", // no tmux right-click menu (client pastes)
  ";", "unbind-key", "-n", "MouseDown2Pane", // no middle-click raw paste
];

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  // tmux name → timer for an in-flight "drain then kill" watch of a detached ephemeral session.
  private readonly pendingKills = new Map<string, ReturnType<typeof setTimeout>>();
  // Who is keeping each session alive (see drain.ts). A session drains when nothing holds it.
  private readonly holds = new Holds();

  constructor(
    private readonly projectsRoot: string,
    private readonly emit: EmitToConn,
  ) {}

  /**
   * Open (or reattach to) a project's tmux session and stream its output to `connId`.
   * `project` = null opens the master terminal at the projects root.
   */
  async open(params: {
    connId: string;
    project: string | null;
    cwd: string;
    cols: number;
    rows: number;
    launchCommand?: string;
    env?: Record<string, string>;
    injectEnv?: Record<string, string>;
  }): Promise<{ sessionId: string; pid: number; tmux: string }> {
    const name = tmuxSessionName(params.project);
    this.cancelDrain(name, "reopened"); // reopening this session cancels any pending drain-kill
    // tmux is an invisible persistence layer here, not a UI. Hide its status bar and
    // let it resize to the attached client so it doesn't fight xterm's rendering.
    // A launchCommand (e.g. `claude -c`) runs as the session's shell-command on first
    // create; on reattach (`-A`) tmux ignores it and reattaches the live session.
    const args = ["new-session", "-A", "-s", name, "-c", params.cwd];
    // tmux gives a new pane the SERVER's environment, not this client command's env, so
    // per-session values (the Claude OAuth token) don't reach `claude` and it falls back
    // to cached creds / prompts login. `-e KEY=VAL` injects them straight into the pane.
    // (Ignored by tmux on reattach, which is fine, only the first `claude` launch needs it.)
    for (const [k, v] of Object.entries(params.injectEnv ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    if (params.launchCommand) args.push(inLoginShell(params.launchCommand));
    args.push(...SESSION_OPTIONS);
    const spawn = tmuxCmd(args);
    const pty = await spawnPty({
      file: spawn.file,
      args: spawn.args,
      cols: params.cols,
      rows: params.rows,
...(params.env ? { env: params.env }: {}),
    });

    const session: Session = {
      id: randomUUID(),
      connId: params.connId,
      project: params.project,
      tmux: name,
      pty,
      seq: 0,
    };
    this.sessions.set(session.id, session);
    audit("session_open", { project: params.project, tmux: name, sessionId: session.id });

    pty.onData((chunk) => {
      this.emit(session.connId, Event.TerminalData, {
        sessionId: session.id,
        seq: session.seq++,
        data: chunk,
      });
    });

    pty.onExit(({ exitCode }) => {
      this.sessions.delete(session.id);
      audit("session_exit", { tmux: name, sessionId: session.id, exitCode });
      this.emit(session.connId, Event.TerminalExit, { sessionId: session.id, exitCode });
    });

    return { sessionId: session.id, pid: pty.pid, tmux: name };
  }

  /** The tmux session name Burrow uses for a project (null = master). */
  tmuxName(project: string | null): string {
    return tmuxSessionName(project);
  }

  /** Names of all live tmux sessions on Burrow's (container) server. */
  liveTmuxNames(): Promise<Set<string>> {
    const { file, args } = tmuxCmd(["list-sessions", "-F", "#{session_name}"]);
    return new Promise((resolve) => {
      execFile(file, args, (err, stdout) => {
        if (err) return resolve(new Set()); // no server / no sessions
        resolve(new Set(String(stdout).split("\n").map((s) => s.trim()).filter(Boolean)));
      });
    });
  }

  /**
   * Every pane on Burrow's socket with its pid and its session's creation time, the input to
   * per-session memory sampling. Read-only: it never touches a session, only asks tmux about one.
   */
  listPanes(): Promise<Pane[]> {
    const { file, args } = tmuxCmd([
      "list-panes",
      "-a",
      "-F",
      "#{session_name} #{pane_pid} #{session_created}",
    ]);
    return new Promise((resolve) => {
      execFile(file, args, (err, stdout) => {
        resolve(err ? []: parsePanes(String(stdout)));
      });
    });
  }

  /** Current visible text of a session's pane (for the auth-failure detector). */
  capturePane(name: string): Promise<string> {
    const { file, args } = tmuxCmd(["capture-pane", "-t", name, "-p"]);
    return new Promise((resolve) => {
      execFile(file, args, (err, stdout) => resolve(err ? "": String(stdout)));
    });
  }

  /** Run one `tmux send-keys` on the host and resolve when it returns. */
  private tmuxSend(name: string, keyArgs: string[]): Promise<void> {
    const { file, args } = tmuxCmd(["send-keys", "-t", name, ...keyArgs]);
    return new Promise((resolve) => execFile(file, args, () => resolve()));
  }

  /**
   * Inject a line of input into a live tmux session as if typed: the literal text, then Enter
   * (sent separately, after a short beat, so the TUI registers the text before the submit).
   * Returns false if the session isn't live, the caller (scheduler) skips absent chats.
   * Used ONLY by the scheduled loop broadcast; normal input goes through input().
   */
  /**
   * Start a project's tmux session DETACHED (no PTY, no client), the scheduler's wake path
   * for a chat that isn't running at fire time. Same launch command and session options as
   * open(), so a browser attaching later gets an identical session.
   */
  startDetached(params: {
    project: string | null;
    cwd: string;
    launchCommand?: string;
    injectEnv?: Record<string, string>;
  }): Promise<boolean> {
    const name = tmuxSessionName(params.project);
    const args = ["new-session", "-d", "-s", name, "-c", params.cwd];
    for (const [k, v] of Object.entries(params.injectEnv ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    if (params.launchCommand) args.push(inLoginShell(params.launchCommand));
    args.push(...SESSION_OPTIONS);
    const { file, args: cmd } = tmuxCmd(args);
    return new Promise((resolve) => {
      execFile(file, cmd, (err) => {
        audit("session_start_detached", { project: params.project, tmux: name, ok: !err });
        resolve(!err);
      });
    });
  }

  /**
   * Poll a session's screen until Claude's input prompt is up. Ready markers are the TUI's
   * footer lines: "? for shortcuts" (normal mode) or "bypass permissions on" (how Burrow
   * launches). Deliberately narrow: a login/trust/error screen never matches, so a
   * not-ready session times out and the caller SKIPS instead of injecting blind.
   */
  async waitForPrompt(project: string | null, timeoutMs = 90_000, pollMs = 2_000): Promise<boolean> {
    const name = tmuxSessionName(project);
    const start = Date.now();
    for (;;) {
      const pane = await this.capturePane(name);
      if (looksReady(pane)) return true;
      if (Date.now() - start >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Leave copy-mode, if the pane is in it.
   *
   * A pane in copy-mode swallows `send-keys` whole. The keys are read as copy-mode commands
   * instead of being delivered, so an injected message vanishes: nothing in Claude's history,
   * nothing in a shell, nothing in the scrollback. Mouse mode is on for every Burrow session, so
   * one turn of the wheel puts a pane there, and it stays until something cancels it.
   *
   * Interactive typing hides this, because tmux cancels the mode on a keypress from an attached
   * client. Only the programmatic path is affected, the one path with nobody watching, which is
   * how a scheduled message went missing with a success in the log.
   *
   * Here rather than at the call site so every present and future caller inherits it. A no-op when
   * the pane is not in a mode.
   */
  private async cancelCopyMode(name: string): Promise<void> {
    await this.tmuxSend(name, ["-X", "cancel"]);
  }

  /**
   * Type a line into a live session, then confirm it went in.
   *
   * The old version pressed Enter and declared success, so every way this can silently fail (a
   * pane in copy-mode, a shell where Claude used to be, a dialog) was recorded as a delivered
   * message. That is what made one missed schedule cost a morning of theories: the log could not
   * tell a success from a failure, so there was nothing to read.
   */
  async sendKeys(project: string | null, text: string): Promise<boolean> {
    const name = this.tmuxName(project);
    if (!(await this.liveTmuxNames()).has(name)) return false;
    await this.cancelCopyMode(name);
    await this.tmuxSend(name, ["-l", "--", text]); // -l = literal, don't interpret key names
    await new Promise((r) => setTimeout(r, 150));
    await this.tmuxSend(name, ["Enter"]);

    /*
     * Did it land? A composer still holding the text means the Enter did not submit, worth one
     * more Enter, since the cause is usually the TUI still ingesting a long paste. The check is
     * the FIRST 40 characters: a submitted message is echoed back into the transcript above, so
     * looking for the whole string would match a success too.
     */
    await new Promise((r) => setTimeout(r, 400));
    const probe = text.trim().slice(0, 40);
    let pane = await this.capturePane(name);
    let stuck = composerHolds(pane, probe);
    if (stuck) {
      await this.tmuxSend(name, ["Enter"]);
      await new Promise((r) => setTimeout(r, 600));
      pane = await this.capturePane(name);
      stuck = composerHolds(pane, probe);
    }
    if (stuck) {
      // The screen itself is the evidence, and the reason this failure will be diagnosable in one
      // reading next time instead of by experiment.
      audit(
        "schedule_inject_failed",
        { tmux: name, project, chars: text.length, screen: pane.split("\n").slice(-6).join(" | ").slice(0, 400) },
        "error",
      );
      return false;
    }
    audit("schedule_inject", { tmux: name, project, chars: text.length });
    return true;
  }

  /**
   * Immediately end a project's session and await the kill. Used by rename, which can't run
   * under a live session (the running claude sits in the old cwd + old tmux name).
   */
  killProjectSession(project: string | null): Promise<void> {
    const name = this.tmuxName(project);
    this.cancelDrain(name);
    for (const s of [...this.sessions.values()]) {
      if (s.tmux === name) {
        s.pty.kill();
        this.sessions.delete(s.id);
      }
    }
    return new Promise((resolve) => {
      if (!name.startsWith("burrow_")) return resolve();
      audit("session_kill", { name, reason: "rename" });
      const { file, args } = tmuxCmd(["kill-session", "-t", name]);
      execFile(file, args, () => resolve());
    });
  }

  /**
   * End EVERY live burrow session (settings danger zone). Same per-session path as
   * killProjectSession; the burrow_* guard protects strangers on the socket (e.g. the
   * systemd _keepalive session). Returns how many were killed.
   */
  async killAllSessions(): Promise<number> {
    const names = [...(await this.liveTmuxNames())].filter((n) => n.startsWith("burrow_"));
    for (const name of names) {
      this.cancelDrain(name);
      for (const s of [...this.sessions.values()]) {
        if (s.tmux === name) {
          s.pty.kill();
          this.sessions.delete(s.id);
        }
      }
      killTmuxSession(name, "kill_all");
    }
    return names.length;
  }

  input(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.pty.resize(cols, rows);
    return true;
  }

  /**
   * Detach a session's PTY, then decide what happens to the underlying tmux session:
   *  - persistent project → leave it running for reattach (device-independence guarantee);
   *  - ephemeral project  → don't kill it outright (that could cut a task mid-turn on a
   *    flaky connection): watch it and kill only once it's gone quiet (see scheduleDrain).
   * The pref is read fresh from disk so a just-flipped toggle is honored even on an
   * abrupt browser disconnect.
   */
  private async teardown(session: Session): Promise<void> {
    session.pty.kill();
    /*
     * Never leave a session parked in copy-mode. Scrolling up to read something and then closing
     * the tab is an ordinary thing to do, and it leaves a pane that silently eats every injected
     * message until somebody attaches and presses a key. `sendKeys` cancels the mode too, and that
     * is the fix; this is so the condition does not sit there waiting for the next thing that
     * forgets to.
     */
    void this.cancelCopyMode(session.tmux);
    if (await isPersistent(session.project)) {
      audit("session_detach_keep", { tmux: session.tmux, project: session.project });
      return;
    }
    // The lifetime model: detaching is not dying. A panel that scrolled out of view, or a view
    // being remounted, still HOLDS this session, only the last hold going starts the countdown.
    if (this.holds.isHeld(session.tmux)) {
      audit("session_detach_held", {
        tmux: session.tmux,
        project: session.project,
        holders: this.holds.count(session.tmux),
      });
      return;
    }
    audit("session_drain_scheduled", { tmux: session.tmux, project: session.project });
    this.scheduleDrain(session.tmux);
  }

  /**
   * Register a hold: "this view exists and expects this session to be here". Idempotent, so a
   * client may re-send its whole hold set on reconnect without counting anything twice.
   */
  hold(connId: string, viewId: string, project: string | null): void {
    const name = tmuxSessionName(project);
    const displaced = this.holds.add(`${connId}:${viewId}`, name, project);
    this.cancelDrain(name, "held"); // a pending countdown is off the moment something holds it again
    // A view that switched project just released whatever it held before. Without this the old
    // session has no holder AND no countdown: it would live until the gateway restarted.
    if (displaced?.last) void this.drainIfUnheld(displaced.name, displaced.project);
  }

  /**
   * Release one hold. When it was the last one and nothing is attached, the normal ephemeral drain
   * starts here, which is the whole point: closing the layout is what begins dying, not scrolling
   * away from it.
   */
  async release(connId: string, viewId: string): Promise<void> {
    const gone = this.holds.remove(`${connId}:${viewId}`);
    if (!gone?.last) return;
    await this.drainIfUnheld(gone.name, gone.project);
  }

  /** Shared tail of release/detachConn: start the countdown only if truly nothing wants it. */
  private async drainIfUnheld(name: string, project: string | null): Promise<void> {
    if (this.holds.isHeld(name) || this.hasLiveSession(name)) return;
    if (await isPersistent(project)) return; // persistent projects never drain
    audit("session_drain_scheduled", { tmux: name, project, cause: "last_hold_released" });
    this.scheduleDrain(name);
  }

  private hasLiveSession(name: string): boolean {
    for (const s of this.sessions.values()) if (s.tmux === name) return true;
    return false;
  }

  private cancelDrain(name: string, reason?: string): void {
    const timer = this.pendingKills.get(name);
    if (timer) {
      clearTimeout(timer);
      this.pendingKills.delete(name);
      if (reason) audit("drain_canceled", { tmux: name, reason });
    }
  }

  /**
   * Poll a detached ephemeral session's tmux activity; kill it once it's been silent for
   * QUIET_MS (its turn finished), never while it's still producing output. Aborts if the
   * session reappears (reattached elsewhere) or is already gone.
   */
  private scheduleDrain(name: string): void {
    if (this.pendingKills.has(name)) return;
    const tick = async () => {
      // Gather the two facts, then let drain.ts decide. The ordering that matters, 
      // reattached beats gone beats idle: lives there, with its tests.
      const reattached = this.hasLiveSession(name);
      const verdict = drainVerdict({
        reattached,
        // Skip the tmux round-trip when the verdict cannot depend on it, reattached wins anyway,
        // and the original code returned before making this call.
        activityMs: reattached ? null: await tmuxActivityMs(name),
        now: Date.now(),
        quietMs: QUIET_MS,
      });
      if (verdict.action === "cancel") {
        return this.cancelDrain(name, verdict.reason === "reattached" ? "reattached": undefined);
      }
      if (verdict.action === "kill") {
        killTmuxSession(name, `idle_${verdict.idleMs}ms`);
        return this.cancelDrain(name);
      }
      this.pendingKills.set(name, setTimeout(tick, POLL_MS)); // still busy, keep watching
    };
    this.pendingKills.set(name, setTimeout(tick, POLL_MS));
  }

  /** Called when the client explicitly leaves a terminal (switches project/mode). */
  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    void this.teardown(session);
    return true;
  }

  /**
   * Detach every session owned by a connection (called when its socket closes) and drop every hold
   * it owned. Holds go FIRST: a browser that vanished is holding nothing, and leaving its holds in
   * place would keep its sessions alive forever, the zombie case the ephemeral default exists to
   * prevent. Sessions another browser still holds are untouched.
   */
  detachConn(connId: string): void {
    for (const released of this.holds.removeConn(connId)) {
      void this.drainIfUnheld(released.name, released.project);
    }
    for (const session of this.sessions.values()) {
      if (session.connId === connId) {
        this.sessions.delete(session.id);
        void this.teardown(session);
      }
    }
  }
}
