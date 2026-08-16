/**
 * Per-project file bridge: list / download / upload, every path bounded to the project's
 * own directory. This is the safety-critical part, a client-supplied relative path must
 * never escape the project cwd. `boundPath` defeats `..` traversal
 * lexically AND symlink escape (by realpath-ing the deepest existing ancestor), so neither a
 * crafted `../../etc/passwd` nor a symlink planted inside the project can reach outside it.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { readdir, realpath, stat, mkdir, unlink } from "node:fs/promises";
import { inheritOwner } from "./hostUser.js";
import { basename, dirname, resolve, sep } from "node:path";

export type FileEntry = { name: string; type: "file" | "dir"; size: number };

/** 500 MB per upload: a sane ceiling so a bad/huge upload can't fill the VPS disk. */
const MAX_UPLOAD = 500 * 1024 * 1024;

/**
 * Resolve a client relative path to an absolute path GUARANTEED to live inside `cwd`.
 * Returns null on any escape or bad input. Works for not-yet-existing targets (uploads):
 * it realpaths the nearest existing ancestor (resolving every symlink in the real prefix)
 * and re-checks containment; the non-existent suffix is fresh path components, not links.
 */
export async function boundPath(cwd: string, rel: string): Promise<string | null> {
  const cleaned = (rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.split("/").some((s) => s === "..")) return null;
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return null;
  }
  const abs = resolve(root, cleaned);
  const within = (p: string) => p === root || p.startsWith(root + sep);
  if (!within(abs)) return null;
  // Symlink guard: realpath the deepest ancestor that exists and re-verify.
  let probe = abs;
  for (;;) {
    try {
      if (!within(await realpath(probe))) return null;
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break; // reached filesystem root without existing, allow (fresh path)
      probe = parent;
    }
  }
  return abs;
}

/** Directory listing (dirs first, then files, both alphabetical). null = bad path / not a dir. */
export async function listDir(
  cwd: string,
  rel: string,
): Promise<{ path: string; entries: FileEntry[] } | null> {
  const abs = await boundPath(cwd, rel);
  if (!abs) return null;
  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch {
    return null;
  }
  const entries: FileEntry[] = [];
  for (const d of dirents) {
    const isDir = d.isDirectory();
    let size = 0;
    if (!isDir) {
      try {
        size = (await stat(resolve(abs, d.name))).size;
      } catch {
        /* unreadable: leave size 0 */
      }
    }
    entries.push({ name: d.name, type: isDir ? "dir": "file", size });
  }
  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === "dir" ? -1: 1): a.name.localeCompare(b.name),
  );
  const path = cleanRel(rel);
  return { path, entries };
}

function cleanRel(rel: string): string {
  return (rel || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Parse an HTTP Range header against a known size.
 *
 * Returns `null` when there is no range to honor (absent or a form we don't serve, the spec says
 * ignore it and send the whole thing), or `"unsatisfiable"` when the client asked for bytes that
 * do not exist, which is a 416 and NOT a 200.
 *
 * Only `bytes` ranges, and only a single range: multipart/byteranges buys nothing for the two
 * things that actually send Range here: a `<video>` seeking and a PDF viewer fetching its
 * cross-reference table off the end of the file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (size <= 0) return "unsatisfiable";
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    // Suffix form: "the last N bytes". N larger than the file means the whole file, not an error.
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1: Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Stream a file that has ALREADY been bounded, with Range support.
 *
 * Range is what makes `<video>`/`<audio>` seekable and lets a PDF viewer read the file's index
 * without downloading all of it, so it is the reason pushed media moved off the WebSocket: base64
 * over a socket adds 33% and cannot be seeked at all.
 *
 * `inline` decides whether the browser renders it or downloads it, the difference between a video
 * element playing and the same bytes landing in the Downloads folder.
 */
export async function serveBounded(
  abs: string,
  req: import("node:http").IncomingMessage | undefined,
  res: import("node:http").ServerResponse,
  opts: { inline?: boolean; mime?: string; extraHeaders?: Record<string, string> } = {},
): Promise<void> {
  let st;
  try {
    st = await stat(abs);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (st.isDirectory()) {
    res.writeHead(400).end("is a directory");
    return;
  }
  const name = basename(abs).replace(/["\\\r\n]/g, "_");
  const headers: Record<string, string> = {
    "content-type": opts.mime ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-disposition": `${opts.inline ? "inline": "attachment"}; filename="${name}"`,
    ...opts.extraHeaders,
  };

  const range = parseRange(req?.headers?.range, st.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, {...headers, "content-range": `bytes */${st.size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
...headers,
      "content-range": `bytes ${range.start}-${range.end}/${st.size}`,
      "content-length": String(range.end - range.start + 1),
    });
    if (req?.method === "HEAD") return void res.end();
    createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, {...headers, "content-length": String(st.size) });
  if (req?.method === "HEAD") return void res.end();
  createReadStream(abs).pipe(res);
}

/**
 * Stream a bounded file to the response as an attachment. Resolves after headers/stream are
 * wired; on a bad path or missing file it writes the error itself. Caller has already
 * resolved+validated `cwd` from the project name.
 */
export async function serveDownload(
  cwd: string,
  rel: string,
  req: import("node:http").IncomingMessage | undefined,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const abs = await boundPath(cwd, rel);
  if (!abs) {
    res.writeHead(400).end("bad path");
    return;
  }
  await serveBounded(abs, req, res, { inline: false });
}

/**
 * Stream an upload body to `<rel>/<name>` inside the project, creating parent dirs as needed.
 * `name` is a single filename (no separators). Enforces MAX_UPLOAD, cleaning up on overflow.
 */
export async function receiveUpload(
  cwd: string,
  rel: string,
  name: string,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<{ ok: boolean; size: number } | null> {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    res.writeHead(400).end("bad filename");
    return null;
  }
  const dir = cleanRel(rel);
  const abs = await boundPath(cwd, dir ? `${dir}/${name}`: name);
  if (!abs) {
    res.writeHead(400).end("bad path");
    return null;
  }
  await mkdir(dirname(abs), { recursive: true });
  await inheritOwner(dirname(abs));

  return await new Promise((resolvePromise) => {
    const out = createWriteStream(abs);
    let received = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD && !failed) {
        failed = true;
        req.unpipe(out);
        out.destroy();
        void unlink(abs).catch(() => {});
        res.writeHead(413, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "file exceeds 500 MB limit" }),
        );
        req.destroy();
        resolvePromise(null);
      }
    });
    out.on("finish", () => {
      if (failed) return;
      // Uploaded as root, like everything else the gateway writes, hand it to whoever owns the
      // folder, or you cannot edit the file you just uploaded into your own project.
      void inheritOwner(abs);
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true, size: received }),
      );
      resolvePromise({ ok: true, size: received });
    });
    out.on("error", () => {
      if (failed) return;
      failed = true;
      if (!res.headersSent) res.writeHead(500).end("write error");
      resolvePromise(null);
    });
    req.pipe(out);
  });
}
