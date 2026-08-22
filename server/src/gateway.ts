/**
 * Gateway: accepts WebSocket connections and dispatches protocol frames.
 *
 * Simplified from OpenClaw's src/gateway/server/ws-connection.ts +
 * src/gateway/server-methods.ts (MIT): a per-connection closure holds the socket and
 * auth state, a `send` helper serializes frames, and a method switch routes each req.
 * We drop the reference's nonce challenge, device tokens, and TLS pinning, Burrow
 * runs inside the Tailnet, so a single shared token on connect is enough.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { WebSocket, WebSocketServer } from "ws";
import {
  ErrorCode,
  Event,
  isReqFrame,
  Method,
  PROTOCOL_VERSION,
  type EventFrame,
  type ResFrame,
} from "./protocol.js";
import { listProjects, resolveProjectCwd, createProject, renameProject, deleteProject } from "./projects.js";
import { listDir, serveDownload, serveBounded, receiveUpload } from "./files.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readGroups, writeGroups } from "./groups.js";
import { readSettings, patchSettings } from "./settings.js";
import { setServe, tailscaleState } from "./tailscale.js";
import { isPersistent, setPersistent, readPersistent } from "./persistence.js";
import { readSchedules, writeSchedules, normalizeRows, dueRows, fmtToday, keptChats } from "./schedule.js";
import { readSplits, writeSplits } from "./splits.js";
import { listCommands, mergeKnown } from "./commands.js";
import { claudeLaunchCommand } from "./launch.js";
import { readUsage } from "./usage.js";
import { readHistory, latestContextTokens, searchHistory } from "./history.js";
import { ensureTrusted } from "./trust.js";
import { AccountManager } from "./accounts.js";
import { McpManager } from "./mcp.js";
import { TerminalManager } from "./terminal.js";
import { ClaudeManager } from "./claude.js";
import { ImageBridge, socketPath, typeOf } from "./images.js";
import { SessionSampler, walkAncestry, procParent } from "./sessionStats.js";
import { audit } from "./audit.js";

type Conn = {
  id: string;
  authed: boolean;
  send: (frame: ResFrame | EventFrame) => void;
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value): fallback;
}

export function createGateway(opts: { token: string; projectsRoot: string; port: number }) {
  const conns = new Map<string, Conn>();

  const emitToConn = (connId: string, event: string, payload: unknown) => {
    conns.get(connId)?.send({ type: "event", event, payload });
  };
  // Unprompted and not tied to one client: every authed browser gets it.
  const broadcast = (event: string, payload: unknown) => {
    for (const conn of conns.values()) if (conn.authed) conn.send({ type: "event", event, payload });
  };
  const terminals = new TerminalManager(opts.projectsRoot, emitToConn);
  const accounts = new AccountManager();
  const mcp = new McpManager();
  const claude = new ClaudeManager(emitToConn, accounts, mcp);

  /**
   * "Is this `show` caller a session Burrow is running?"
   *
   * The MCP server is registered at user scope, so every `claude` on this box has the tool, 
   * including a plain ssh session. The cwd check says WHERE the caller is, never WHOSE it is.
   *
   * Ancestry answers both modes with one mechanism, which is why it beats the obvious `TMUX` env
   * check (bubble mode has no tmux at all) and a per-session secret (it would have to arrive by
   * environment, and tmux drops `-e` on reattach). The container runs `pid: host`, so the parent
   * chain of a host process is readable from here.
   */
  const ownsProcess = async (pid: number): Promise<boolean> => {
    const owned = new Set<number>(claude.livePids());
    for (const pane of await terminals.listPanes()) owned.add(pane.pid);
    if (owned.has(pid)) return true;
    return walkAncestry(pid, (p) => procParent(p)).some((a) => owned.has(a));
  };

  // Claude → Burrow push. Starting the socket also materializes the stdio script the host's
  // `claude` runs, which is why registration waits for it: registering a path that isn't there
  // yet would give every session a broken MCP server.
  const images = new ImageBridge(
    opts.projectsRoot,
    (project, image) => broadcast(Event.ImagePush, { project, image }),
    ownsProcess,
    (project) => broadcast(Event.PushChanged, { project }),
  );
  void images
.start()
.then((script) => {
      mcp.registerBurrow(script);
      audit("image_bridge_up", { socket: socketPath(), script });
    })
.catch((err: unknown) => {
      // Not fatal: everything else in the gateway works without it. The MCP tool then tells
      // the model the gateway is unreachable, which is the truth.
      audit("image_bridge_failed", { message: err instanceof Error ? err.message: String(err) }, "error");
    });

  // Periodic snapshot of live sessions + connected clients, so the audit log carries a
  // timeline of state (useful for spotting leaks/churn patterns over days of use).
  setInterval(() => {
    void terminals.liveTmuxNames().then((live) =>
      audit("heartbeat", { live: [...live], clients: conns.size }),
    );
  }, 10 * 60_000);

  // Per-session memory + age. Sampled on the same 60s tick as the auth scan (per-minute
  // resolution is the requirement: a real runaway's onset was a single second), cached in
  // memory and appended to a rolling log so "which session grew, starting when" is answerable
  // after the fact instead of only while it is happening.
  const tmuxToProject = new Map<string, string | null>();
  const sampler = new SessionSampler(
    () => terminals.listPanes(),
    (session) => {
      if (tmuxToProject.has(session)) {
        const project = tmuxToProject.get(session)!;
        return { name: project ?? "master", project };
      }
      // A live session whose project was renamed or deleted still holds real memory, so it is
      // reported under its raw name rather than quietly dropped. Anything not ours is dropped.
      if (session.startsWith("burrow_")) return { name: session.slice("burrow_".length), project: null };
      return null;
    },
  );
  const sampleSessions = async () => {
    try {
      const projects = await listProjects(opts.projectsRoot);
      tmuxToProject.clear();
      tmuxToProject.set(terminals.tmuxName(null), null);
      for (const p of projects) tmuxToProject.set(terminals.tmuxName(p.name), p.name);
    } catch {
      /* keep the previous mapping: a stale name beats no sample */
    }
    await sampler.tick();
  };
  void sampleSessions();

  // Auth-failure detector: scan live session screens for Claude auth errors and log each new
  // one with a timestamp. Turns the intermittent 401/login issue into a readable record, 
  // grep the audit log for `auth_failure_detected` after a few days of use. Deduped per
  // session so a static error isn't re-logged every minute.
  const AUTH_ERR =
    /401|invalid[ _]?(api[ _]?key|bearer|token|x-api-key)|authentication_error|unauthorized|please run \/login|oauth token (?:has )?expired|api error: 4\d\d/i;
  const lastAuthHit = new Map<string, string>();
  setInterval(() => {
    void terminals.liveTmuxNames().then(async (live) => {
      for (const name of live) {
        const pane = await terminals.capturePane(name);
        const hit = pane
.split("\n")
.reverse()
.find((l) => AUTH_ERR.test(l))
          ?.trim()
.slice(0, 200);
        if (hit && lastAuthHit.get(name) !== hit) {
          lastAuthHit.set(name, hit);
          audit("auth_failure_detected", { session: name, line: hit }, "warn");
        } else if (!hit) {
          lastAuthHit.delete(name);
        }
      }
    });
    void sampleSessions();
  }, 60_000);

  // Scheduled loop broadcast: once per minute-ish, check whether the armed schedule's time has
  // arrived and, if so, inject its message into each selected chat's terminal session. One
  // message per session; the session's own `/loop` takes over from there. A dead chat is WOKEN
  // first (started detached + polled for prompt readiness); only a readiness timeout skips it, 
  // the message is never injected blind. The lastFired date guard makes it fire at most once per
  // day. 30s interval → at least one tick lands inside every target minute.
  async function tickSchedule(): Promise<void> {
    const rows = await readSchedules();
    const now = new Date();
    const due = dueRows(rows, now); // pure decision: enabled + time + day + once-per-day guard
    if (due.length === 0) return;
    /*
     * Persistence decides who is eligible, and it is re-read here rather than trusted from when the
     * schedule was saved. Read BEFORE the stamp write, because a chat that is no longer persistent
     * is now DROPPED from the row in that same write.
     *
     * Dropping rather than skipping-forever: the modal only offers persistent chats, so a name that
     * has stopped being one can no longer be seen or unchecked, it was invisible, uncounted, and
     * carried through every save, quietly turning into a permanent `skipped` entry. "Was due, and
     * was not eligible" is a real moment to act on, unlike the modal merely being opened.
     *
     * It is one-way. Turn persistence off for an afternoon, have a schedule fire overnight, and the
     * chat is gone from that row: turning persistence back on does not bring it back. That is the
     * intended behaviour, and the audit line below is how it stays visible rather than silent.
     */
    const persistent = await readPersistent();
    const pruned: Record<string, string[]> = {};
    for (const row of due) {
      const drop = row.chats.filter((c) => !persistent.has(c));
      if (drop.length) {
        pruned[row.id] = drop;
        row.chats = keptChats(row.chats, persistent);
        audit("schedule_pruned", { id: row.id, time: row.time, dropped: drop }, "warn");
      }
    }

    // Stamp BEFORE injecting so an overlapping tick within the same minute can't double-fire. The
    // pruned chat lists ride along in the same write, one read, one write, no second pass.
    const today = fmtToday(now);
    const dueById = new Map(due.map((r) => [r.id, r]));
    await writeSchedules(
      rows.map((r) => {
        const hit = dueById.get(r.id);
        return hit ? {...r, chats: hit.chats, lastFired: today }: r;
      }),
    );

    // A dead chat is woken (started + readiness-polled) before injecting; wake failure or timeout →
    // skip, never inject blind. Sequential on purpose, waking N sessions staggers their cold
    // starts instead of spiking the CPU at once.
    for (const row of due) {
      const fired: string[] = [];
      const skipped: string[] = [];
      for (const chat of row.chats) {
        if (!persistent.has(chat)) {
          skipped.push(chat);
          continue;
        }
        /*
         * Readiness is checked for a LIVE session too, which it was not before: `live || wake`
         * short-circuited, so a session that merely existed was typed into blind, the exact
         * opposite of what the comment above promised. A live pane can be a shell, a dialog, or
         * scrolled back, and none of those take a message.
         */
        const live = (await terminals.liveTmuxNames()).has(terminals.tmuxName(chat));
        const ready = live ? await terminals.waitForPrompt(chat, 10_000): await wakeChat(chat);
        if (ready && (await terminals.sendKeys(chat, row.message))) fired.push(chat);
        else skipped.push(chat);
      }
      audit("schedule_fire", { id: row.id, time: row.time, message: row.message, fired, skipped }, skipped.length ? "warn": "info");
    }
  }
  setInterval(() => void tickSchedule(), 30_000);

  // Resolve a project name (or null = master) to a working directory under the root.
  async function resolveCwd(project: string | null): Promise<string | null> {
    if (!project) return opts.projectsRoot;
    return resolveProjectCwd(opts.projectsRoot, project);
  }

  /**
   * The Claude launch for a project's terminal session, shared by terminal.open and the
   * scheduler's wake path so both spawn identically. Master (null) gets a plain shell ({}).
   */
  async function claudeLaunchFor(
    project: string | null,
  ): Promise<{ launchCommand?: string; injectEnv?: Record<string, string> }> {
    if (!project) return {};
    const token = accounts.activeToken();
    return {
      launchCommand: claudeLaunchCommand(),
      // Inject the active account's token into the tmux pane via `-e` (see terminal.open)
      // so `claude` authenticates with it instead of prompting login.
...(token ? { injectEnv: { CLAUDE_CODE_OAUTH_TOKEN: token } }: {}),
    };
  }

  /**
   * Scheduler wake path: start a dead chat's session detached and wait for Claude's prompt.
   * Returns true only when the session is up AND ready for input; a timeout skips (the
   * caller never injects blind). Audited either way.
   */
  async function wakeChat(chat: string): Promise<boolean> {
    const started = Date.now();
    const cwd = await resolveCwd(chat);
    if (!cwd) {
      audit("schedule_wake", { chat, ok: false, reason: "no such project" }, "warn");
      return false;
    }
    ensureTrusted(cwd);
    const launch = await claudeLaunchFor(chat);
    if (!(await terminals.startDetached({ project: chat, cwd, ...launch }))) {
      audit("schedule_wake", { chat, ok: false, reason: "tmux spawn failed" }, "warn");
      return false;
    }
    const ready = await terminals.waitForPrompt(chat);
    audit(
      "schedule_wake",
      { chat, ok: ready, ms: Date.now() - started, ...(ready ? {}: { reason: "prompt readiness timeout" }) },
      ready ? "info": "warn",
    );
    return ready;
  }

  function attach(wss: WebSocketServer): void {
    wss.on("connection", (socket) => handleConnection(socket));
  }

  /**
   * HTTP side of the file bridge (`/files/list|download|upload`). Returns true if it handled
   * the request. Auth mirrors the WebSocket: if a token is configured it must match `?token=`,
   * otherwise we rely on the network perimeter (Tailscale sidecar). Everything is bounded to
   * the named project's directory by files.ts.
   */
  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://burrow");
    const isPush = url.pathname.startsWith("/push/");
    if (!url.pathname.startsWith("/files/") && !isPush) return false;

    if (opts.token && url.searchParams.get("token") !== opts.token) {
      res.writeHead(401).end("unauthorized");
      return true;
    }

    /*
     * `/push/<id>/<sub>`: the bytes behind a pushed item.
     *
     * The subpath is deliberate rather than cosmetic: the item itself is `/push/<id>/<name>`, so a
     * pushed HTML page's own `style.css` resolves to `/push/<id>/style.css` and lands right back
     * here. Serving it at a bare `/push/<id>` would break every relative link in the page. Both go
     * through the bridge, which re-bounds the path against the project directory on every request.
     *
     * The mime comes from the extension on THIS side; nothing a client sends is trusted, because
     * the answer decides whether a browser executes the file as a document.
     */
    if (isPush) {
      const [, , id, ...rest] = url.pathname.split("/");
      const sub = rest.map(decodeURIComponent).join("/");
      const found = id && sub ? await images.resolve(id, sub): null;
      if (!found) {
        res.writeHead(404).end("no such push");
        return true;
      }
      const type = typeOf(found.abs);
      // The pushed HTML iframe is sandboxed without allow-same-origin, but a sandbox does not
      // govern network egress: a scripted page could still open a WebSocket back to the gateway
      // and drive it (root RCE in a token-less deployment). `connect-src 'none'` blocks
      // fetch/XHR/WebSocket/EventSource while leaving scripts, styles and images working, so a
      // legitimate pushed page still renders. nosniff stops a non-HTML asset being run as a
      // document; form-action/base-uri close the tricks the sandbox's allow-forms leaves open.
      const guard: Record<string, string> = {
        "x-content-type-options": "nosniff",
        "content-security-policy": "connect-src 'none'; form-action 'none'; base-uri 'none'",
      };
      if (!type) {
        // A relative asset of an HTML page can be any type; only the item itself is kind-checked
        // at push time. Serve unknown types as bytes the browser will not run.
        await serveBounded(found.abs, req, res, { inline: false, extraHeaders: guard });
        return true;
      }
      await serveBounded(found.abs, req, res, { inline: true, mime: type.mime, extraHeaders: guard });
      return true;
    }
    const project = url.searchParams.get("project") ?? "";
    const cwd = project ? await resolveProjectCwd(opts.projectsRoot, project): null;
    if (!cwd) {
      res.writeHead(404).end("no such project");
      return true;
    }
    const rel = url.searchParams.get("path") ?? "";

    try {
      if (url.pathname === "/files/list" && req.method === "GET") {
        const listing = await listDir(cwd, rel);
        if (!listing) {
          res.writeHead(400).end("bad path");
          return true;
        }
        res
.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
.end(JSON.stringify(listing));
      } else if (url.pathname === "/files/download" && req.method === "GET") {
        await serveDownload(cwd, rel, req, res);
        audit("file_download", { project, path: rel });
      } else if (url.pathname === "/files/upload" && req.method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        const result = await receiveUpload(cwd, rel, name, req, res);
        if (result) audit("file_upload", { project, path: rel, name, size: result.size });
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message: "internal error";
      audit("file_error", { path: url.pathname, message }, "error");
      if (!res.headersSent) res.writeHead(500).end("error");
    }
    return true;
  }

  function handleConnection(socket: WebSocket): void {
    const id = randomUUID();
    const conn: Conn = {
      id,
      authed: false,
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      },
    };
    conns.set(id, conn);

    audit("client_connect", { connId: id });
    socket.on("message", (raw) => void handleMessage(conn, raw.toString()));
    socket.on("close", () => {
      audit("client_disconnect", { connId: id });
      terminals.detachConn(id);
      conns.delete(id);
    });
    socket.on("error", () => {
      /* a close event follows; cleanup happens there */
    });
  }

  async function handleMessage(conn: Conn, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // ignore non-JSON noise
    }
    if (!isReqFrame(parsed)) return;

    const { id, method } = parsed;
    const params = parsed.params ?? {};
    const ok = (payload: unknown) => conn.send({ type: "res", id, ok: true, payload });
    const fail = (code: string, message: string) =>
      conn.send({ type: "res", id, ok: false, error: { code, message } });

    if (method === Method.Connect) {
      // No token configured → rely on network-level security (bind to the Tailnet).
      // Token configured → it must match.
      if (!opts.token || (typeof params.token === "string" && params.token === opts.token)) {
        conn.authed = true;
        ok({ protocol: PROTOCOL_VERSION });
      } else {
        fail(ErrorCode.Unauthorized, "invalid token");
      }
      return;
    }

    if (!conn.authed) {
      fail(ErrorCode.Unauthorized, "connect first");
      return;
    }

    try {
      switch (method) {
        case Method.ProjectsList: {
          ok({ projects: await listProjects(opts.projectsRoot) });
          return;
        }

        case Method.ProjectsCreate: {
          const name = typeof params.name === "string" ? params.name: "";
          const description = typeof params.description === "string" ? params.description: undefined;
          const group = typeof params.group === "string" ? params.group: undefined;
          try {
            const project = await createProject(opts.projectsRoot, name, description);
            /*
             * Record the group HERE, as part of creating the project.
             *
             * The client used to do it afterwards with its own `groups.set`, then immediately
             * re-read with `groups.get`, and frames are dispatched concurrently (`void
             * handleMessage`), so the read could land while the write was still in flight and come
             * back with the project ungrouped. The file ended up correct and the screen did not,
             * until a reload: "creates the project but doesn't label it".
             *
             * Doing it in one operation removes the race rather than narrowing it, and is the
             * truer shape anyway: a project is created *into* a group.
             */
            if (group) {
              const existing = await readGroups();
              if (existing.groups.includes(group)) {
                await writeGroups({
...existing,
                  assignments: {...existing.assignments, [project.name]: group },
                });
              }
            }
            audit("project_create", { name: project.name });
            ok({ project });
          } catch (err) {
            fail(ErrorCode.InvalidRequest, err instanceof Error ? err.message: "could not create project");
          }
          return;
        }

        case Method.ProjectsRename: {
          const name = typeof params.name === "string" ? params.name: "";
          const newName = typeof params.newName === "string" ? params.newName: "";
          // A project's session auto-opens when you view it, so the one you're renaming is
          // usually live. Close it ourselves (the running claude sits in the old cwd + old
          // tmux name), then rename; the client reopens the new name and `claude -c` resumes
          // from the moved history folder.
          const live = await terminals.liveTmuxNames();
          const closedSession = live.has(terminals.tmuxName(name));
          if (closedSession) await terminals.killProjectSession(name);
          try {
            const project = await renameProject(opts.projectsRoot, name, newName);
            // Remap Burrow's name-keyed state onto the new name.
            const groups = await readGroups();
            if (groups.assignments[name]) {
              groups.assignments[project.name] = groups.assignments[name]!;
              delete groups.assignments[name];
              await writeGroups(groups);
            }
            const persistent = await readPersistent();
            if (persistent.has(name)) {
              await setPersistent(name, false);
              await setPersistent(project.name, true);
            }
            audit("project_rename", { from: name, to: project.name, closedSession });
            ok({ project });
          } catch (err) {
            fail(ErrorCode.InvalidRequest, err instanceof Error ? err.message: "rename failed");
          }
          return;
        }

        case Method.ProjectsDelete: {
          const name = typeof params.name === "string" ? params.name: "";
          const live = await terminals.liveTmuxNames();
          if (live.has(terminals.tmuxName(name))) await terminals.killProjectSession(name);
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            await deleteProject(opts.projectsRoot, name, stamp);
            // Clean Burrow's name-keyed state.
            const g = await readGroups();
            if (g.assignments[name]) {
              delete g.assignments[name];
              await writeGroups(g);
            }
            if ((await readPersistent()).has(name)) await setPersistent(name, false);
            audit("project_delete", { name, stamp });
            ok({});
          } catch (err) {
            fail(ErrorCode.InvalidRequest, err instanceof Error ? err.message: "delete failed");
          }
          return;
        }

        case Method.GroupsGet: {
          ok(await readGroups());
          return;
        }

        case Method.GroupsSet: {
          const assignments = params.assignments;
          if (typeof assignments !== "object" || assignments === null) {
            fail(ErrorCode.InvalidRequest, "assignments object required");
            return;
          }
          const groups = Array.isArray(params.groups) ? (params.groups as string[]): [];
          const colors =
            params.colors && typeof params.colors === "object"
              ? (params.colors as Record<string, string>): {};
          await writeGroups({ groups, assignments: assignments as Record<string, string>, colors });
          ok({});
          return;
        }

        case Method.TerminalOpen: {
          const project = typeof params.project === "string" ? params.project: null;
          let cwd = opts.projectsRoot;
          if (project) {
            const resolved = await resolveProjectCwd(opts.projectsRoot, project);
            if (!resolved) {
              fail(ErrorCode.NotFound, `no such project: ${project}`);
              return;
            }
            cwd = resolved;
          }
          // Per-project terminals auto-launch Claude (continue latest, else fresh, then
          // drop to a shell on exit). The master terminal stays a plain root shell.
          if (project) ensureTrusted(cwd); // skip Claude's folder-trust prompt on auto-launch
          const claudeLaunch = await claudeLaunchFor(project);
          const opened = await terminals.open({
            connId: conn.id,
            project,
            cwd,
            cols: positiveInt(params.cols, 80),
            rows: positiveInt(params.rows, 24),
...claudeLaunch,
          });
          ok({...opened, persistent: await isPersistent(project) });
          return;
        }

        case Method.SessionsActive: {
          const live = await terminals.liveTmuxNames();
          const projects = await listProjects(opts.projectsRoot);
          const active = projects
.filter((p) => live.has(terminals.tmuxName(p.name)))
.map((p) => p.name);
          // `stats` rides along from the sampler's cache, no work per request, so the client's
          // 5s poll costs nothing and the /proc walk still happens once a minute.
          const snapshot = sampler.latest();
          ok({
            active,
            master: live.has(terminals.tmuxName(null)),
            persistent: [...(await readPersistent())],
            stats: snapshot.sessions,
            statsAt: snapshot.at,
          });
          return;
        }

        case Method.TerminalSetPersistent: {
          const project = typeof params.project === "string" ? params.project: null;
          if (!project) {
            fail(ErrorCode.InvalidRequest, "project required");
            return;
          }
          await setPersistent(project, params.persistent === true);
          audit("set_persistent", { project, value: params.persistent === true });
          ok({ persistent: params.persistent === true });
          return;
        }

        case Method.TerminalInput: {
          const { sessionId, data } = params;
          if (typeof sessionId !== "string" || typeof data !== "string") {
            fail(ErrorCode.InvalidRequest, "sessionId and data required");
            return;
          }
          terminals.input(sessionId, data) ? ok({}): fail(ErrorCode.NotFound, "no such session");
          return;
        }

        case Method.TerminalResize: {
          const { sessionId } = params;
          if (typeof sessionId !== "string") {
            fail(ErrorCode.InvalidRequest, "sessionId required");
            return;
          }
          terminals.resize(sessionId, positiveInt(params.cols, 80), positiveInt(params.rows, 24))
            ? ok({}): fail(ErrorCode.NotFound, "no such session");
          return;
        }

        case Method.TerminalClose: {
          const { sessionId } = params;
          if (typeof sessionId !== "string") {
            fail(ErrorCode.InvalidRequest, "sessionId required");
            return;
          }
          terminals.close(sessionId) ? ok({}): fail(ErrorCode.NotFound, "no such session");
          return;
        }

        // Holds: the client tells the gateway which sessions its layout still wants. Keyed by a
        // client-chosen view id, scoped to this connection, a hold dies with the socket.
        case Method.TerminalHold: {
          const { viewId, project } = params;
          if (typeof viewId !== "string" || (typeof project !== "string" && project !== null)) {
            fail(ErrorCode.InvalidRequest, "viewId and project required");
            return;
          }
          terminals.hold(conn.id, viewId, project);
          ok({});
          return;
        }

        case Method.TerminalRelease: {
          const { viewId } = params;
          if (typeof viewId !== "string") {
            fail(ErrorCode.InvalidRequest, "viewId required");
            return;
          }
          await terminals.release(conn.id, viewId);
          ok({});
          return;
        }

        // Hard-end a project's terminal session, even a persistent one. Used by the mode
        // toggle: leaving the terminal kills it so returning relaunches `claude -c` fresh
        // (always current with anything the bubble chat wrote to the same session).
        case Method.TerminalKill: {
          const project = typeof params.project === "string" ? params.project: null;
          await terminals.killProjectSession(project);
          ok({});
          return;
        }

        // Danger zone (settings): end every burrow session at once.
        case Method.SessionsKillAll: {
          const killed = await terminals.killAllSessions();
          audit("kill_all_sessions", { killed });
          ok({ killed });
          return;
        }

        case Method.ClaudeSend: {
          const project = typeof params.project === "string" ? params.project: null;
          const message = params.message;
          if (typeof message !== "string" || !message.trim()) {
            fail(ErrorCode.InvalidRequest, "message required");
            return;
          }
          const cwd = await resolveCwd(project);
          if (!cwd) {
            fail(ErrorCode.NotFound, `no such project: ${project}`);
            return;
          }
          const model = typeof params.model === "string" && params.model ? params.model: undefined;
          const fresh = params.fresh === true;
          // Ack immediately; the turn streams back as claude.event events.
          ok({});
          void claude.send({ connId: conn.id, project, cwd, message, model, fresh });
          return;
        }

        case Method.CommandsList: {
          const project = typeof params.project === "string" ? params.project: null;
          const cwd = await resolveCwd(project);
          if (!cwd) {
            fail(ErrorCode.NotFound, `no such project: ${project}`);
            return;
          }
          // Disk scan first (it works before any turn), then whatever the CLI itself declared
          // in the last bubble session's init frame, built-ins and plugin commands live there.
          ok({ commands: mergeKnown(await listCommands(cwd), claude.knownSlashCommands(project)) });
          return;
        }

        case Method.ClaudeAbort: {
          const project = typeof params.project === "string" ? params.project: null;
          ok({});
          void claude.abort(project);
          return;
        }

        case Method.ClaudeControl: {
          const project = typeof params.project === "string" ? params.project: null;
          const requestId = typeof params.requestId === "string" ? params.requestId: "";
          if (!requestId) {
            fail(ErrorCode.InvalidRequest, "requestId required");
            return;
          }
          ok({ delivered: await claude.respondControl(project, requestId, params.response) });
          return;
        }

        case Method.ClaudeHistory: {
          const project = typeof params.project === "string" ? params.project: null;
          const cwd = await resolveCwd(project);
          if (!cwd) {
            fail(ErrorCode.NotFound, `no such project: ${project}`);
            return;
          }
          ok(await readHistory(cwd));
          return;
        }

        case Method.ContextSize: {
          const project = typeof params.project === "string" ? params.project: null;
          const cwd = await resolveCwd(project);
          if (!cwd) {
            fail(ErrorCode.NotFound, `no such project: ${project}`);
            return;
          }
          ok((await latestContextTokens(cwd)) ?? { tokens: null, model: null });
          return;
        }

        case Method.OnboardingGet: {
          const s = readSettings();
          ok({
            tourDone: s.tourDone === true,
            hintsSeen: Array.isArray(s.hintsSeen) ? (s.hintsSeen as string[]): [],
          });
          return;
        }

        case Method.OnboardingSeen: {
          // Two independent things through one method: the tour as a whole, and one hint by id.
          const s = readSettings();
          const patch: Record<string, unknown> = {};
          // Reset puts the install back to never-having-seen-anything, which is what Settings'
          // "show the tour again" needs: a real first run, not a simulated one.
          if (params.reset === true) {
            patchSettings({ tourDone: false, hintsSeen: [] });
            ok({});
            return;
          }
          if (params.tour === true) patch.tourDone = true;
          const hint = typeof params.hint === "string" ? params.hint.trim().slice(0, 64): "";
          if (hint) {
            const seen = new Set(Array.isArray(s.hintsSeen) ? (s.hintsSeen as string[]): []);
            seen.add(hint);
            patch.hintsSeen = [...seen];
          }
          if (Object.keys(patch).length) patchSettings(patch);
          ok({});
          return;
        }

        case Method.TailscaleState: {
          ok(await tailscaleState(opts.port));
          return;
        }

        case Method.TailscaleServe: {
          // Publishing Burrow on a tailnet is a change in who can reach a root shell, so it is
          // audited either way: the answer carries the failure rather than throwing, because
          // "not installed" and "not signed in" are normal states the settings row must render.
          const on = params.on === true;
          const result = await setServe(opts.port, on);
          audit("tailscale_serve", { on, ok: result.ok, message: result.message }, result.ok ? "info": "warn");
          ok(result);
          return;
        }

        case Method.UsageGet: {
          // Cached inside readUsage (README: don't poll per render). A failed read answers ok
          // with `ok: false` rather than an error frame, "usage unknown" is a normal state the
          // header has to render, not a request failure.
          ok(await readUsage());
          return;
        }

        case Method.ClaudeAccounts: {
          ok({ accounts: accounts.ids(), active: accounts.activeId() });
          return;
        }

        case Method.ClaudeSetAccount: {
          const account = params.account;
          if (typeof account !== "string" || !accounts.setActive(account)) {
            fail(ErrorCode.InvalidRequest, "unknown account");
            return;
          }
          ok({ active: accounts.activeId() });
          return;
        }

        case Method.McpList: {
          const project = typeof params.project === "string" ? params.project: null;
          const cwd = (await resolveCwd(project)) ?? opts.projectsRoot;
          ok({ servers: mcp.servers(cwd), disabled: mcp.disabled(cwd) });
          return;
        }

        // Per-project: saves this project's disable list and recycles its bubble process so
        // the next turn spawns with the new --disallowed-tools set (--resume keeps the chat).
        case Method.McpSetDisabled: {
          const project = typeof params.project === "string" ? params.project: null;
          const disabled = params.disabled;
          if (!Array.isArray(disabled)) {
            fail(ErrorCode.InvalidRequest, "disabled array required");
            return;
          }
          const cwd = (await resolveCwd(project)) ?? opts.projectsRoot;
          mcp.setDisabled(cwd, disabled as string[]);
          claude.recycle(project);
          audit("mcp_set_disabled", { project, cwd, disabled });
          ok({ disabled: mcp.disabled(cwd) });
          return;
        }

        // Cmd-K: full-text search across every project's session histories.
        case Method.SearchHistory: {
          const query = typeof params.query === "string" ? params.query.trim(): "";
          if (query.length < 2) {
            ok({ hits: [] });
            return;
          }
          const projects = await listProjects(opts.projectsRoot);
          const targets = projects.map((p) => ({ name: p.name, cwd: join(opts.projectsRoot, p.name) }));
          ok(await searchHistory(targets, query));
          return;
        }

        case Method.ImagesRecent: {
          // What Claude has pushed for this project, bytes re-read now, so a reload or a
          // browser that attached late still sees the image instead of having missed the event.
          const project = typeof params.project === "string" ? params.project: null;
          ok({ images: await images.recent(project) });
          return;
        }

        case Method.ScheduleGet: {
          ok({ schedules: await readSchedules() });
          return;
        }

        case Method.ScheduleSet: {
          const next = normalizeRows(params.schedules, await readSchedules());
          await writeSchedules(next);
          audit("schedule_set", {
            rows: next.map((r) => ({ id: r.id, enabled: r.enabled, time: r.time, chats: r.chats })),
          });
          ok({ schedules: next });
          return;
        }

        case Method.SplitsGet: {
          ok({ splits: await readSplits() });
          return;
        }

        case Method.SplitsSet: {
          // Whole-list set (same shape as groups/schedule): create, rename, delete and
          // layout edits are all just a new list. Sessions are untouched, a split is a
          // view config, so deleting one never ends a terminal.
          const next = await writeSplits(params.splits);
          audit("splits_set", { count: next.length, ids: next.map((s) => s.id) });
          ok({ splits: next });
          return;
        }

        default:
          fail(ErrorCode.UnknownMethod, `unknown method: ${method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message: "internal error";
      audit("method_error", { method, message }, "error");
      fail(ErrorCode.Internal, message);
    }
  }

  return { attach, handleHttp };
}
