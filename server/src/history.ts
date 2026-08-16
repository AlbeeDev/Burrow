/**
 * Reads a project's existing Claude Code conversation from disk, the same session
 * files the CLI uses (`~/.claude/projects/<encoded-cwd>/<id>.jsonl`), so Burrow mirrors
 * the real ongoing conversation instead of keeping its own copy. Read-only: Burrow never
 * writes these files; Claude Code does. Picks the most recent session, matching `claude -c`.
 */

import { homedir } from "node:os";
import { readdir, readFile, stat, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";

const MAX_MESSAGES = 500;

function projectDir(cwd: string): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(base, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * A project's session.jsonl files, newest-mtime first. Excludes `agent-*.jsonl`, those are
 * subagent (Task) sidecar transcripts living in the same dir; they can easily be the newest
 * file but are never the conversation the user means.
 */
async function sessionFilesStamped(cwd: string): Promise<{ path: string; mtime: number }[]> {
  const dir = projectDir(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  } catch {
    return [];
  }
  const stamped: { path: string; mtime: number }[] = [];
  for (const f of files) {
    try {
      stamped.push({ path: join(dir, f), mtime: (await stat(join(dir, f))).mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  return stamped.sort((a, b) => b.mtime - a.mtime);
}

async function sessionFilesByRecency(cwd: string): Promise<string[]> {
  return (await sessionFilesStamped(cwd)).map((s) => s.path);
}

/** Newest session.jsonl for a project cwd (matches `-c`'s "most recent"). */
async function latestSessionFile(cwd: string): Promise<string | null> {
  return (await sessionFilesByRecency(cwd))[0] ?? null;
}

/**
 * Current context-window usage for a project's latest session, the newest assistant turn's
 * prompt tokens (input + cached read + cached creation = everything the model re-processed).
 * This is the real number both the terminal and bubble write to the same `.jsonl`, so it drives
 * the "conversation is getting big: /compact" warning for either mode. Reads only the file's
 * tail (sessions can be tens of MB) and walks back to the last entry carrying usage.
 */
export async function latestContextTokens(
  cwd: string,
): Promise<{ tokens: number; model: string | null } | null> {
  const file = await latestSessionFile(cwd);
  if (!file) return null;
  try {
    const { size } = await stat(file);
    const readLen = Math.min(size, 512 * 1024);
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, size - readLen);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue; // partial first line of the tail, or noise, skip
        }
        // A compact resets the context: everything before this boundary is stale. If we reach it
        // before finding a post-compact turn's usage, the conversation was just compacted and no
        // new turn has landed yet: report 0 (badge hides) instead of the huge pre-compact number.
        if (e?.type === "system" && (e.subtype === "compact_boundary" || e.compactMetadata)) {
          return { tokens: 0, model: null };
        }
        const u = e?.message?.usage;
        if (u && typeof u.input_tokens === "number") {
          const tokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0);
          const model = typeof e.message?.model === "string" ? e.message.model: null;
          return { tokens, model };
        }
      }
      return null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export type HistoryMessage = { role: string; content: unknown };

/** Parse one session file into (sessionId, messages). */
async function parseSessionFile(
  file: string,
): Promise<{ sessionId: string | null; messages: HistoryMessage[] }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { sessionId: null, messages: [] };
  }
  const messages: HistoryMessage[] = [];
  let sessionId: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.sessionId === "string") sessionId = entry.sessionId;
    if ((entry.type === "user" || entry.type === "assistant") && entry.message?.content != null) {
      messages.push({ role: entry.message.role ?? entry.type, content: entry.message.content });
    }
  }
  return { sessionId, messages: messages.slice(-MAX_MESSAGES) };
}

/**
 * The project's conversation, as the bubble view should see it. Deterministic against the
 * mode-switch race: the newest-mtime file can be a just-created session
 * with no messages yet (a terminal `claude` booting/dying mid-switch), naively trusting it
 * rendered an empty chat while the real conversation sat one file down. So: walk candidates
 * newest-first and return the first that actually CONTAINS messages; only if none do,
 * report the newest (possibly empty) session as-is.
 */
export async function readHistory(
  cwd: string,
): Promise<{ sessionId: string | null; messages: HistoryMessage[] }> {
  const candidates = await sessionFilesByRecency(cwd);
  if (candidates.length === 0) return { sessionId: null, messages: [] };
  let newest: { sessionId: string | null; messages: HistoryMessage[] } | null = null;
  for (const file of candidates) {
    const parsed = await parseSessionFile(file);
    if (parsed.messages.length > 0) return parsed;
    newest ??= parsed;
  }
  return newest ?? { sessionId: null, messages: [] };
}

/**
 * `snippet` is the ±60-char window around the match (what the list shows); `full` is the whole
 * message so the palette can expand a hit in place, capped because a single message can be
 * megabytes of pasted output. Sent with the hit rather than fetched on demand: it saves giving
 * hits a stable identity and a second round trip, and the cap bounds the cost.
 */
export type SearchHit = { project: string; snippet: string; when: number; full: string; truncated: boolean };

const FULL_MAX = 4000;

/** Flatten a message's content (string or block array) to searchable plain text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
.map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text: ""))
.join(" ");
  return "";
}

const SCAN_CHUNK = 1 << 20; // 1 MiB reads, memory stays flat on a 40 MB session file

/** One matching line → a hit, or null if the needle only matched metadata (uuids, paths…). */
function hitFromLine(line: string, needle: string, project: string, when: number): SearchHit | null {
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry?.type !== "user" && entry?.type !== "assistant") return null;
  const text = contentText(entry.message?.content);
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return null;
  const from = Math.max(0, at - 60);
  const snippet =
    (from > 0 ? "…": "") +
    text.slice(from, at + needle.length + 60).replace(/\s+/g, " ").trim() +
    (at + needle.length + 60 < text.length ? "…": "");
  const trimmed = text.trim();
  return {
    project,
    snippet,
    when,
    full: trimmed.slice(0, FULL_MAX),
    truncated: trimmed.length > FULL_MAX,
  };
}

/**
 * Scan ONE session file for the needle, streaming in chunks.
 *
 * The cost that used to bound this search was JSON.parse over every line of every candidate
 * file. Here each chunk is substring-tested first, and only lines inside a matching chunk are
 * parsed, so a non-matching 40 MB session costs one pass of `indexOf` and no parsing at all.
 * That is what buys the reach beyond the old 3-newest-files limit.
 */
async function scanFile(
  file: string,
  needle: string,
  cap: number,
  project: string,
  when: number,
): Promise<SearchHit[]> {
  const out: SearchHit[] = [];
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return out;
  }
  try {
    const buf = Buffer.alloc(SCAN_CHUNK);
    const decoder = new StringDecoder("utf8"); // chunk edges can split a multi-byte char
    let carry = "";
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, SCAN_CHUNK, null);
      if (bytesRead === 0) break;
      const text = carry + decoder.write(buf.subarray(0, bytesRead));
      const lastNl = text.lastIndexOf("\n");
      const complete = lastNl === -1 ? "": text.slice(0, lastNl);
      carry = lastNl === -1 ? text: text.slice(lastNl + 1);
      if (complete.toLowerCase().includes(needle)) {
        for (const line of complete.split("\n")) {
          if (out.length >= cap) break;
          if (!line.toLowerCase().includes(needle)) continue;
          const hit = hitFromLine(line, needle, project, when);
          if (hit) out.push(hit);
        }
      }
      if (out.length >= cap) break;
    }
    if (out.length < cap && carry.toLowerCase().includes(needle)) {
      const hit = hitFromLine(carry, needle, project, when);
      if (hit) out.push(hit);
    }
  } catch {
    /* unreadable mid-file: return what we have */
  } finally {
    await fh.close();
  }
  return out;
}

export type SearchOutcome = {
  hits: SearchHit[];
  scanned: number; // session files actually read
  total: number; // session files available across the given projects
};

/**
 * Case-insensitive full-text search across the given projects' session histories (Cmd-K).
 *
 * Walks ALL session files, not just the newest few, old conversations are exactly what you
 * reach for a palette to find. Two things keep that affordable: the streaming scan above, and
 * a wall-clock budget. Files are visited round-robin by depth (every project's newest, then
 * every project's second-newest, …) so a project with a hundred sessions can't starve the
 * others when the budget runs out. `scanned`/`total` are returned so the UI can say what was
 * actually covered instead of implying it searched everything.
 */
export async function searchHistory(
  projects: { name: string; cwd: string }[],
  query: string,
  opts: { capTotal?: number; capPerProject?: number; budgetMs?: number } = {},
): Promise<SearchOutcome> {
  const capTotal = opts.capTotal ?? 20;
  const capPerProject = opts.capPerProject ?? 3;
  const budgetMs = opts.budgetMs ?? 3000;
  const needle = query.toLowerCase();
  if (!needle) return { hits: [], scanned: 0, total: 0 };

  const lists = await Promise.all(
    projects.map(async (p) => ({ project: p, files: await sessionFilesStamped(p.cwd) })),
  );
  const total = lists.reduce((n, l) => n + l.files.length, 0);
  const deepest = lists.reduce((n, l) => Math.max(n, l.files.length), 0);
  const perProject = new Map<string, number>();
  const hits: SearchHit[] = [];
  const started = Date.now();
  let scanned = 0;

  outer: for (let depth = 0; depth < deepest; depth++) {
    for (const { project, files } of lists) {
      const f = files[depth];
      if (!f) continue;
      const already = perProject.get(project.name) ?? 0;
      if (already >= capPerProject) continue;
      if (hits.length >= capTotal) break outer;
      if (Date.now() - started > budgetMs) break outer;
      scanned++;
      const found = await scanFile(f.path, needle, capPerProject - already, project.name, f.mtime);
      if (found.length) {
        perProject.set(project.name, already + found.length);
        hits.push(...found.slice(0, capTotal - hits.length));
      }
    }
  }
  return { hits, scanned, total };
}
