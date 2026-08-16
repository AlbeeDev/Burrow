/**
 * Claude → Burrow push (the gateway half of the `burrow` MCP server).
 *
 * A headless `claude` can describe a chart, a report or a recording but never show one. This
 * module opens a unix socket that the stdio MCP server (`server/mcp/burrow-mcp.mjs`, copied to
 * ~/.burrow at startup) connects to; a `show` call arrives with the caller's cwd and a file path,
 * and the gateway announces it to every connected browser.
 *
 * v2: metadata on the socket, bytes over HTTP. The event now carries only
 * "this arrived, here is its id and kind"; the browser fetches the file from `/push/<id>/<name>`,
 * which streams with Range support. That is what makes video and audio possible at all, base64
 * over a WebSocket adds 33% and cannot be seeked, and it is why the size cap could go up 64×.
 *
 * Two decisions worth knowing:
 *
 * - Identity is the cwd, not an env var. The MCP server is a child of `claude`, so it
 *   inherits the session's working directory; that maps back to a project the same way the
 *   rest of the gateway does. Env injection was rejected because tmux ignores `-e` on
 *   reattach (terminal.ts): every already-running session would have been left out.
 * - A unix socket, not HTTP. `claude` runs on the host, the gateway in the container, and
 *   compose publishes no host ports. `/root:/root` is bind-mounted at the same path on both
 *   sides, so the socket file is the one place they can meet. (This assumes BURROW_DATA_DIR
 *   stays inside that shared mount: the default, ~/.burrow, does.)
 *
 * Bytes are bounded by the same `boundPath()` the file bridge uses, so a push cannot escape
 * the project directory. History keeps metadata only and re-reads on demand, a browser
 * reload or a late attach still gets the item, without the gateway ever holding its bytes.
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdir, copyFile, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { inheritOwner } from "./hostUser.js";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { boundPath } from "./files.js";
import { audit } from "./audit.js";

/**
 * 512 MB. Was 8 MB while bytes crossed the WebSocket base64'd; since v2 they stream over the
 * bounded HTTP route with Range support, so the cap is about not handing the browser something
 * absurd rather than about what a socket frame can carry. Matches files.ts's upload ceiling.
 */
const MAX_BYTES = 512 * 1024 * 1024;
/**
 * No cap. Entries are metadata (~200 bytes), not bytes, so ten thousand pushes is about 2 MB, and
 * ones whose file has been deleted or moved prune themselves when the list is read. Curation is a
 * thing the model does on request (`unshow`), not a number that silently drops your history.
 */
export function historyFile(): string {
  return join(dataDir(), "pushes.json");
}

/**
 * What Burrow can put on screen, and how it renders it. The path carries the answer, which is why
 * there is ONE `show` tool rather than one per type, every extra tool is one more thing the model
 * has to choose correctly between, and it already knows the file it means.
 */
export type PushKind = "image" | "markdown" | "video" | "audio" | "pdf" | "html";

const TYPES: Record<string, { kind: PushKind; mime: string }> = {
  ".png": { kind: "image", mime: "image/png" },
  ".jpg": { kind: "image", mime: "image/jpeg" },
  ".jpeg": { kind: "image", mime: "image/jpeg" },
  ".gif": { kind: "image", mime: "image/gif" },
  ".webp": { kind: "image", mime: "image/webp" },
  ".svg": { kind: "image", mime: "image/svg+xml" },
  ".bmp": { kind: "image", mime: "image/bmp" },
  ".avif": { kind: "image", mime: "image/avif" },
  ".md": { kind: "markdown", mime: "text/markdown; charset=utf-8" },
  ".markdown": { kind: "markdown", mime: "text/markdown; charset=utf-8" },
  ".mp4": { kind: "video", mime: "video/mp4" },
  ".m4v": { kind: "video", mime: "video/mp4" },
  ".webm": { kind: "video", mime: "video/webm" },
  ".mov": { kind: "video", mime: "video/quicktime" },
  ".mp3": { kind: "audio", mime: "audio/mpeg" },
  ".m4a": { kind: "audio", mime: "audio/mp4" },
  ".wav": { kind: "audio", mime: "audio/wav" },
  ".ogg": { kind: "audio", mime: "audio/ogg" },
  ".flac": { kind: "audio", mime: "audio/flac" },
  ".pdf": { kind: "pdf", mime: "application/pdf" },
  ".html": { kind: "html", mime: "text/html; charset=utf-8" },
  ".htm": { kind: "html", mime: "text/html; charset=utf-8" },
};
const EXTENSIONS = Object.keys(TYPES).join(", ");

/** Extension → kind + mime. Exported for the route, which must never trust a client-sent mime. */
export function typeOf(path: string): { kind: PushKind; mime: string } | null {
  return TYPES[extname(path).toLowerCase()] ?? null;
}

function dataDir(): string {
  return process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
}

export function socketPath(): string {
  return process.env.BURROW_MCP_SOCK?.trim() || join(dataDir(), "mcp.sock");
}

/** Where the stdio script is copied to: must be a path the HOST can see and execute. */
export function scriptPath(): string {
  return join(dataDir(), "burrow-mcp.mjs");
}

/**
 * One item the model pushed. No bytes, since v2 the client fetches them from
 * `/push/<id>/<name>`, which streams with Range support. Base64 over the socket added 33% and
 * could not be seeked, which made video impossible and large PDFs painful.
 */
export type PushedItem = {
  id: string;
  name: string;
  rel: string;
  kind: PushKind;
  mime: string;
  size: number;
  caption?: string;
  at: number;
  /**
   * The file's mtime. An item keeps its `id` when the same path is written again, that is what
   * makes it stay put in the strip instead of jumping to the front, but it means the byte URL
   * `/push/<id>/<name>` is unchanged too, so a browser that already rendered it never asks again
   * and you keep seeing the old content. `no-store` cannot help: no request is ever made. The
   * client puts this in the query string, so new bytes mean a new URL.
   */
  ver: number;
};

/** Stored form: the project dir is kept so the file can be re-bounded on every request. */
type Stored = PushedItem & { cwd: string };
type Answer = { ok: boolean; message: string };

/** What the stdio script advertises. It hardcodes none of this, it asks the gateway. */
export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * A resolved caller, which project it belongs to, the project's directory, and the caller's OWN
 * working directory. `cwd` matters: a session started in `burrow/server` must have `notes.md`
 * mean `burrow/server/notes.md`, not `burrow/notes.md`. v2 resolved that in the stdio script; v3
 * does it here, so the script can stay ignorant of what any tool means.
 */
type Where = {
  project: string | null;
  dir: string;
  cwd: string;
  /**
   * Who is asking. The read-before-write guard is per caller, so one session reading the list does
   * not license a different session to overwrite it. The MCP server process is long-lived per
   * `claude` session, which makes its pid a stable session key; callers without one (a pre-v2
   * script) share a single bucket, which is the old behaviour and no worse than it was.
   */
  callerId: string;
};

/**
 * THE REGISTRY. Adding a tool is one entry here and nothing else, no script edit, no second
 * dispatch table, no redeploying `burrow-mcp.mjs` to every host session.
 *
 * That is the whole point of v3. Before this, a tool was declared in four places across two files and a new one could
 * not reach a session that was already running.
 *
 * Every entry gets a caller already resolved to a project and already checked for ownership, so no
 * tool re-implements identity or containment.
 */
type ToolSpec = {
  def: ToolDef;
  run: (bridge: ImageBridge, where: Where, args: Record<string, unknown>) => Promise<Answer>;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim(): "");

const TOOLS: ToolSpec[] = [
  {
    def: {
      name: "list_media",
      title: "List what is on the human's screen",
      description:
        "Read the media list for this project: everything currently on the human's screen in the " +
        "Burrow UI, in order, with the id and kind of each. Call this before `write_media`: writing " +
        "is refused unless you have read the current list first, because a write replaces the whole " +
        "list and you cannot safely rewrite something you have not seen. Entries whose file has " +
        "since been deleted or moved are not listed, the list only ever contains things that " +
        "still exist.",
      inputSchema: { type: "object", properties: {} },
    },
    run: async (bridge, where) => {
      const { items, version } = await bridge.readMedia(where);
      const head = `Media on screen for ${where.project ?? "the master shell"} (version ${version}):`;
      if (items.length === 0) return { ok: true, message: `${head}\n  (empty)` };
      const lines = items.map((i, n) => {
        const age = Math.round((Date.now() - i.at) / 60_000);
        const when = age < 60 ? `${age}m ago`: `${Math.round(age / 60)}h ago`;
        return `  ${n + 1}. ${i.rel}  [${i.kind}]${i.caption ? `, ${i.caption}`: ""}  (${when})`;
      });
      return { ok: true, message: `${head}\n${lines.join("\n")}` };
    },
  },
  {
    def: {
      name: "write_media",
      title: "Set what is on the human's screen",
      description:
        "Put something on the human's screen, or take it off. Reach for this when they want to " +
        "look at something rather than be told about it, and when what you have made is a file, " +
        "a screenshot, a chart, a report, a page, rather than a sentence. Repeated here because " +
        "some clients show tool descriptions but not the server's own instructions.\n\n" +
        "Replace the media list for this project with exactly what you pass. This is how you add, " +
        "remove and reorder: one call, any number of changes. Anything you leave out is taken off " +
        "the screen; the FILES ARE NEVER TOUCHED, only the list. Files must live inside the current " +
        "project directory. You must call `list_media` first and the list must not have changed " +
        "since, or the write is refused: pass `[]` to clear everything. Newly added entries open " +
        "themselves on the human's screen; entries that were already there keep their position in " +
        "the reading order and the time they arrived.",
      inputSchema: {
        type: "object",
        properties: {
          media: {
            type: "array",
            description: "The complete list, in the order it should appear. Pass [] to clear.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Absolute, or relative to the current directory." },
                caption: { type: "string", description: "Optional one-line caption." },
              },
              required: ["path"],
            },
          },
        },
        required: ["media"],
      },
    },
    run: (bridge, where, args) => bridge.writeMedia(where, args.media),
  },
];

/** The list the stdio script advertises, fetched at initialize. */
export function toolDefs(): ToolDef[] {
  return TOOLS.map((t) => t.def);
}

/** Drop the internal cwd: the client never needs a host path it could not fetch anyway. */
function forClient(row: Stored): PushedItem {
  const { cwd: _cwd, ...rest } = row;
  return rest;
}

/** What the strip would look like on screen. Equal signatures = nothing to tell the browser. */
function signature(rows: Stored[]): string {
  return rows.map((r) => `${r.id}:${r.ver}:${r.caption ?? ""}`).join("|");
}

/**
 * Map a caller's cwd back to a Burrow project. The projects root itself is master (null);
 * anything below a project directory resolves to that project, so `cd`-ing into a subfolder
 * before starting the session still works. Anywhere else is not a Burrow session.
 */
async function projectOf(
  projectsRoot: string,
  cwd: string,
): Promise<{ project: string | null; dir: string } | null> {
  let root: string;
  let here: string;
  try {
    root = await realpath(projectsRoot);
    here = await realpath(cwd);
  } catch {
    return null;
  }
  if (here === root) return { project: null, dir: root };
  if (!here.startsWith(root + sep)) return null;
  let dir = here;
  while (dirname(dir) !== root) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return { project: basename(dir), dir };
}

export class ImageBridge {
  private server?: Server;
  private readonly history = new Map<string, Stored[]>();
  /** Per project, bumped on every change: the version a writer must have read. */
  private readonly versions = new Map<string, number>();
  /** caller+project → the version that caller last read. Absent = never read. */
  private readonly seen = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly projectsRoot: string,
    /** Called once per accepted push; the gateway broadcasts it to every client. */
    private readonly onPush: (project: string | null, item: PushedItem) => void,
    /**
     * "Is this caller a session Burrow is running?", given the calling process's pid.
     *
     * The `burrow` MCP server is registered at USER scope in `~/.claude.json`, so EVERY `claude`
     * on this box gets the `show` tool, including a plain ssh or desktop session Burrow knows
     * nothing about. The cwd check only asks *where* the caller is, never *whose* it is, so a
     * native session started inside a project directory would land its file in whatever browser
     * happens to be watching that project.
     *
     * Omitted (undefined) means no verification, used by the unit tests and by any embedder that
     * has no process table to consult.
     */
    private readonly verifyOrigin?: (pid: number) => Promise<boolean>,
    /**
     * The strip changed without anything new arriving, an `unshow`. Separate from `onPush`
     * because a push OPENS the lightbox and a removal must not; clients just refetch.
     */
    private readonly onChange: (project: string | null) => void = () => {},
  ) {}

  /**
   * Materialize the stdio script somewhere the host can run it, then listen. Returns the
   * script path so the caller can register it with the CLI.
   */
  async start(): Promise<string> {
    const dir = dataDir();
    await mkdir(dir, { recursive: true });
    // ~/.burrow is created by the gateway (root) inside somebody's home, but the MCP server runs
    // out on the host AS them: a root-owned data dir is a socket they cannot bind.
    await inheritOwner(dir);
    // The strip outlives the gateway now: a rebuild used to wipe it, which was the one place the
    // push feature broke Burrow's "everything survives except the container" promise.
    await this.load();
    const script = scriptPath();
    // Overwrite every start, so a gateway upgrade also upgrades the script the host runs.
    await copyFile(fileURLToPath(new URL("../mcp/burrow-mcp.mjs", import.meta.url)), script);

    const path = socketPath();
    await unlink(path).catch(() => {}); // a stale socket from a previous process
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    /*
     * The other end of this socket is the MCP server, which runs on the HOST as a person, while
     * the gateway binding it is root. A unix socket needs the WRITE bit to connect, and root binds
     * at 0755, so "other" gets r-x and every push fails with EACCES. Handing the
     * socket to whoever owns the data directory is enough: the owner has rwx, and root was never
     * going to be stopped by a permission bit anyway. Widening the mode instead would open the
     * screen to every account on the machine, which is a bigger promise than this needs to make.
     */
    await inheritOwner(path);
    // The script too: it is copied in as root and executed by that same person.
    await inheritOwner(script);
    this.server = server;
    return script;
  }

  async stop(): Promise<void> {
    this.server?.close();
    this.server = undefined;
    await unlink(socketPath()).catch(() => {});
  }

  /**
   * This project's pushes, newest first. Entries whose file has since been deleted, moved, or
   * turned into a symlink pointing outside the project drop out, the bounding is re-checked here
   * rather than trusted from push time.
   */
  async recent(project: string | null): Promise<PushedItem[]> {
    const rows = this.history.get(project ?? "") ?? [];
    const out: PushedItem[] = [];
    // Stored order, NOT reverse-chronological, since `write_media` takes the whole list, the order
    // is something the caller chose, and reordering is one of the things a write is for.
    for (const row of rows) {
      const abs = await boundPath(row.cwd, row.rel);
      if (!abs) continue;
      try {
        // The stat is here anyway to drop deleted entries; taking `ver` from it means a reload
        // reflects the file as it is right now, even if it changed with no push behind it.
        const st = await stat(abs);
        out.push({...forClient(row), size: st.size, ver: Math.floor(st.mtimeMs) });
      } catch {
        /* deleted or moved since: the history entry simply stops resolving */
      }
    }
    return out;
  }

  /**
   * Resolve a pushed item and a path relative to ITS DIRECTORY to an absolute file, or null.
   *
   * `sub` is what follows `/push/<id>/` in the URL. For the item itself that is just its filename;
   * for an HTML page it is also how the page's own stylesheet and images resolve, because the
   * document's URL sits one level down and relative links land back here. Everything goes through
   * `boundPath` against the project directory, so a page cannot walk out with `../../etc/passwd`
   * any more than a push can.
   */
  async resolve(id: string, sub: string): Promise<{ abs: string; item: PushedItem } | null> {
    for (const rows of this.history.values()) {
      const row = rows.find((r) => r.id === id);
      if (!row) continue;
      const dir = dirname(row.rel);
      const rel = dir === "." ? sub: `${dir}/${sub}`;
      const abs = await boundPath(row.cwd, rel);
      return abs ? { abs, item: forClient(row) }: null;
    }
    return null;
  }

  private serve(socket: Socket): void {
    let buffer = "";
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) {
        if (buffer.length > 64 * 1024) socket.destroy(); // not a request; don't buffer forever
        return;
      }
      const line = buffer.slice(0, nl);
      buffer = "";
      let req: any;
      try {
        req = JSON.parse(line);
      } catch {
        socket.end(JSON.stringify({ ok: false, message: "malformed request" }) + "\n");
        return;
      }
      void this.call(req).then((answer) => socket.end(JSON.stringify(answer) + "\n"));
    });
  }

  /**
   * The socket protocol. Three ops, and only one of them knows about tools:
   *
   *   { op: "tools" }                                 → the list the script advertises
   *   { op: "call", name, arguments, cwd, pid }       → run a tool
   *   { op: "show" | "show_image", cwd, path, … }     → v1/v2 direct call, kept for old scripts
   *
   * The legacy ops exist because a `claude` that was already running when the gateway upgraded
   * still holds whichever script it loaded at session start. They are a translation into the
   * registry, not a second implementation: v3 exists precisely so this stays the LAST special
   * case rather than the first of many.
   */
  async call(req: any): Promise<Answer | { ok: true; tools: ToolDef[] }> {
    if (req?.op === "tools") return { ok: true, tools: toolDefs() };

    const legacy = req?.op === "show" || req?.op === "show_image";
    if (req?.op !== "call" && !legacy) {
      return { ok: false, message: `unknown op: ${req?.op}` };
    }

    const cwd = str(req?.cwd);
    if (!cwd) return { ok: false, message: "cwd is required." };
    const name = legacy ? "show": str(req?.name);
    const args: Record<string, unknown> = legacy
      ? { path: req?.path, caption: req?.caption }: (req?.arguments && typeof req.arguments === "object" ? req.arguments: {});

    /*
     * Whose session is this? The cwd check below answers "where", not "whose".
     *
     * A pid arrives from v2's script onward. Its ABSENCE means a `claude` that was already running
     * when the gateway upgraded and still holds v1's script, allowed through with an audit line
     * rather than broken, because v1's script only ever existed here. Checked ONCE, here, so no
     * tool has to remember to do it.
     */
    const pid = typeof req?.pid === "number" && Number.isFinite(req.pid) ? req.pid: null;
    if (this.verifyOrigin && pid !== null && !(await this.verifyOrigin(pid))) {
      audit("push_refused_foreign", { pid, cwd, tool: name }, "warn");
      return {
        ok: false,
        message:
          `Refused: this session isn't managed by Burrow, so there is no screen to act on. ` +
          `Burrow's tools only work from a terminal or bubble session started by Burrow, this one ` +
          `was started outside it (a plain shell or another client). Nothing happened; tell the ` +
          `human what you would have shown them instead.`,
      };
    }
    if (this.verifyOrigin && pid === null) audit("push_origin_unverified", { cwd, tool: name }, "warn");

    // Identity, resolved once for every tool rather than per tool.
    const found = await projectOf(this.projectsRoot, cwd);
    const where = found ? {...found, cwd, callerId: pid === null ? "legacy": String(pid) }: null;
    if (!where) {
      return {
        ok: false,
        message:
          `Not running inside a Burrow session: ${cwd} is not under Burrow's projects root, so ` +
          `there is no browser view to act on. Nothing happened.`,
      };
    }

    /*
     * A v1/v2 script calls `show` with one path and cannot read the list first, so it can never
     * satisfy the read-before-write guard. Route it to a plain append instead, the guard exists to
     * stop a WHOLE-LIST rewrite dropping entries, and an append cannot drop anything.
     */
    if (legacy) return await this.appendOne(where, str(args.path), str(args.caption).slice(0, 300));

    const tool = TOOLS.find((t) => t.def.name === name);
    if (!tool) {
      return {
        ok: false,
        message: `Unknown tool: ${name || "(none given)"}. Burrow offers: ${toolDefs().map((d) => d.name).join(", ")}.`,
      };
    }
    return await tool.run(this, where, args);
  }

  /**
   * The whole decision path for one push. Every rejection returns a DIFFERENT sentence: the
   * model acts on this text, and a vague or falsely-successful answer would have it tell the
   * human to look at something that isn't there.
   */
  /**
   * Read the list, and remember that this caller has seen it at this version.
   *
   * The read is not a convenience: `writeMedia` refuses without it. A write replaces the whole
   * list, so writing one you have not read is how you delete something by forgetting it.
   */
  async readMedia(where: Where): Promise<{ items: PushedItem[]; version: number }> {
    const items = await this.recent(where.project);
    const version = this.versionOf(where.project);
    this.seen.set(this.token(where), version);
    return { items, version };
  }

  /**
   * Replace a project's list with exactly what was passed.
   *
   * Three properties worth knowing, all deliberate:
   *
   *  - Read-before-write, version checked. Refused if this caller has not read the list, OR if
   *    it changed since they did. The second half matters as much as the first: a stale read is
   *    just as capable of dropping an entry as no read at all.
   *  - Surviving entries keep their identity. Matched by resolved path, so an item that was
   *    already there keeps its id and its arrival time, a rewrite does not make everything look
   *    like it just landed.
   *  - One bad entry does not fail the write. Each path is validated on its own; the good ones
   *    go up and the message says exactly which were refused and why. Failing all six because the
   *    third was a `.txt` would be the least useful possible behaviour.
   */
  async writeMedia(where: Where, raw: unknown): Promise<Answer> {
    if (!Array.isArray(raw)) {
      return { ok: false, message: "`media` must be an array (pass [] to clear the screen). Nothing changed." };
    }
    const key = where.project ?? "";
    const current = this.versionOf(where.project);
    const seenAt = this.seen.get(this.token(where));
    if (seenAt === undefined) {
      return {
        ok: false,
        message:
          "Refused: call `list_media` first. `write_media` replaces the whole list, so it will not " +
          "write one you have not read: that is how something gets dropped by being forgotten. " +
          "Nothing changed.",
      };
    }
    if (seenAt !== current) {
      return {
        ok: false,
        message:
          `Refused: the list changed since you read it (you saw version ${seenAt}, it is now ` +
          `${current}). Call \`list_media\` again and rewrite from what is actually there. ` +
          `Nothing changed.`,
      };
    }

    const existing = this.history.get(key) ?? [];
    const byAbs = new Map(existing.map((r) => [join(r.cwd, r.rel), r]));
    const next: Stored[] = [];
    const refused: string[] = [];
    const added: Stored[] = [];

    for (const entry of raw) {
      const path = str((entry as any)?.path);
      const caption = str((entry as any)?.caption).slice(0, 300);
      if (!path) {
        refused.push("(an entry with no path)");
        continue;
      }
      const resolved = await this.resolveEntry(where, path, caption, byAbs);
      if ("error" in resolved) {
        refused.push(`${path}: ${resolved.error}`);
        continue;
      }
      if (next.some((r) => join(r.cwd, r.rel) === join(resolved.row.cwd, resolved.row.rel))) continue; // dedupe
      next.push(resolved.row);
      if (resolved.isNew) added.push(resolved.row);
    }

    if (next.length) this.history.set(key, next);
    else this.history.delete(key);
    this.bump(where.project);
    this.seen.set(this.token(where), this.versionOf(where.project)); // the writer knows the new state
    await this.persist();

    // Newly added entries open themselves; anything that was already there does not. One rule,
    // derived from the diff, instead of "show always opens and unshow never does".
    for (const row of added) this.onPush(where.project, forClient(row));
    // Anything the browser would render differently is a change worth telling it about, not just
    // items appearing and disappearing. Counting rows missed the two cases that look identical
    // from outside: a surviving item whose FILE changed, and a reorder. Both left the strip stale.
    if (signature(next) !== signature(existing)) this.onChange(where.project);
    audit("media_written", { project: where.project, count: next.length, added: added.length, refused: refused.length });

    const summary = next.length
      ? `${next.length} item(s) on screen for ${where.project ?? "the master shell"}${added.length ? `, ${added.length} newly shown`: ""}.`: `Screen cleared for ${where.project ?? "the master shell"}.`;
    return {
      ok: refused.length === 0,
      message: refused.length
        ? `${summary} ${refused.length} refused:\n  ${refused.join("\n  ")}`: summary,
    };
  }

  /** Append one item, no read required. Only reachable from a pre-v3 script's `show`. */
  private async appendOne(where: Where, path: string, caption: string): Promise<Answer> {
    if (!path) return { ok: false, message: "A `path` is required. Nothing was shown." };
    const key = where.project ?? "";
    const existing = this.history.get(key) ?? [];
    const byAbs = new Map(existing.map((r) => [join(r.cwd, r.rel), r]));
    const resolved = await this.resolveEntry(where, path, caption, byAbs);
    if ("error" in resolved) {
      return { ok: false, message: `Refused: ${path}, ${resolved.error}. Nothing was shown.` };
    }
    if (!resolved.isNew) return { ok: true, message: `${resolved.row.name} is already on screen.` };
    this.history.set(key, [...existing, resolved.row]);
    this.bump(where.project);
    await this.persist();
    this.onPush(where.project, forClient(resolved.row));
    return {
      ok: true,
      message: `Shown in Burrow: ${resolved.row.name} is now on screen for ${where.project ?? "the master shell"}.`,
    };
  }

  /** Validate one entry and turn it into a stored row, reusing the existing one when unchanged. */
  private async resolveEntry(
    where: Where,
    path: string,
    caption: string,
    byAbs: Map<string, Stored>,
  ): Promise<{ row: Stored; isNew: boolean } | { error: string }> {
    const abs0 = isAbsolute(path) ? path: resolvePath(where.cwd, path);
    const rel = relative(where.dir, abs0);
    const abs = rel && !rel.startsWith("..") ? await boundPath(where.dir, rel): null;
    if (!abs) return { error: `outside this project (${where.dir})` };

    const type = typeOf(abs);
    if (!type) return { error: `not a displayable type. Supported: ${EXTENSIONS}` };

    let size: number;
    let ver: number;
    try {
      const st = await stat(abs);
      if (st.isDirectory()) return { error: "is a directory, not a file" };
      size = st.size;
      ver = Math.floor(st.mtimeMs);
    } catch {
      return { error: "no such file" };
    }
    const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (size > MAX_BYTES) return { error: `${mb(size)} exceeds Burrow's ${mb(MAX_BYTES)} limit` };

    const prior = byAbs.get(abs);
    if (prior) {
      // Already on screen: keep its id and arrival time, but re-read what can have changed under
      // it: size, mtime, caption. Dropping `ver` here is the whole bug: the row survives, so the
      // URL survives, so the browser goes on showing bytes that are no longer on disk.
      return { row: {...prior, size, ver, ...(caption ? { caption }: {}) }, isNew: false };
    }
    return {
      row: {
        id: `push-${Date.now().toString(36)}-${this.seq++}`,
        name: basename(abs),
        rel: relative(where.dir, abs),
        cwd: where.dir,
        kind: type.kind,
        mime: type.mime,
        size,
        ver,
        at: Date.now(),
...(caption ? { caption }: {}),
      },
      isNew: true,
    };
  }

  private token(where: Where): string {
    return `${where.callerId}:${where.project ?? ""}`;
  }
  private versionOf(project: string | null): number {
    return this.versions.get(project ?? "") ?? 0;
  }
  private bump(project: string | null): void {
    this.versions.set(project ?? "", this.versionOf(project) + 1);
  }

  /** Load the persisted strip. Corrupt or absent file = start empty; never fatal. */
  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(historyFile(), "utf8")) as Record<string, Stored[]>;
      for (const [key, rows] of Object.entries(raw)) {
        if (Array.isArray(rows)) this.history.set(key, rows.filter((r) => r && typeof r.id === "string"));
      }
    } catch {
      /* first run, or a file we can't read: an empty strip is the right fallback */
    }
  }

  /**
   * Write the strip to disk. Unbounded on purpose: entries are metadata only, so ten thousand pushes is about 2 MB, and stale
   * ones prune themselves on read when their file is gone. Curation is `unshow`'s job, not a cap's.
   */
  private async persist(): Promise<void> {
    try {
      const out: Record<string, Stored[]> = {};
      for (const [key, rows] of this.history) out[key] = rows;
      await mkdir(dataDir(), { recursive: true });
      await writeFile(historyFile(), JSON.stringify(out));
    } catch {
      /* best-effort: an unwritable disk must not break a push that otherwise worked */
    }
  }
}
