/**
 * Per-session memory + age sampling.
 *
 * Why this exists: a single Claude session once reached 6.3 GB and took the whole host
 * down, and nothing on this box could say WHICH session it was. Two separate post-mortems each
 * produced a confident, well-evidenced, wrong root cause before per-second netdata data settled
 * it. The missing thing was never analysis, it was data.
 *
 * Burrow is the only component that knows which process belongs to which session, so this is
 * Burrow's to collect:
 *
 *  - `tmux list-panes -a` gives session name → pane pid (authoritative; the same inherited-process
 *    identity the MCP image push relies on, since tmux drops `-e` env on reattach).
 *  - The container runs with `pid: host`, so `/proc` here IS the host's process table, no nsenter
 *    needed to read it, and a pane's whole subtree (shell → claude → its children) is visible.
 *
 * Two honest caveats, stated rather than hidden:
 *  - Summing RSS over a subtree double-counts pages shared between parent and child. Measured on
 *    a real 13-process session: RSS-sum 1567 MB vs PSS 992 MB, so the overstatement
 *    is real and can approach 1.5×. PSS would be exact, but it costs a `smaps_rollup` read per
 *    process (the kernel walks page tables to answer it) where `stat` is nearly free. RSS-sum is
 *    kept deliberately: it is the conventional signal, it never UNDERstates, and the question here
 *    is "which session is eating the box, and since when", a ranking question, not an accounting
 *    one. Anyone reading absolute numbers off this should know they are an upper bound.
 *  - Only `burrow_*` sessions are reported. The tmux unit's `_keepalive` session is a systemd
 *    artifact holding the server open, not somebody's work, and listing it as a session would be
 *    a small lie in a place whose whole value is being trustworthy after an incident.
 */

import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One pane as tmux reports it. `createdSec` is the SESSION's creation time, not the pane's. */
export type Pane = { session: string; pid: number; createdSec: number };

/** One row of the host process table, reduced to what a subtree sum needs. */
export type ProcRow = { pid: number; ppid: number; rssBytes: number };

export type SessionStat = {
  /** tmux session name, e.g. `burrow_burrow`. */
  session: string;
  /** What to show a human: the project name, "master", or the raw tmux name if it maps to neither. */
  name: string;
  /** Project key for UI matching. null = the master shell, or a session with no matching project. */
  project: string | null;
  /** Summed resident bytes of the pane's process subtree (see the double-counting caveat above). */
  rssBytes: number;
  /** How many processes that sum covers: a session with 40 procs is its own kind of interesting. */
  procs: number;
  /** Age of the tmux session. */
  ageMs: number;
};

export type StatsSample = { at: number; sessions: SessionStat[] };

/** Linux page size on every architecture this runs on. `/proc/<pid>/stat` reports RSS in pages. */
const PAGE_BYTES = 4096;

/**
 * ~14 days at one sample per minute. The incident this was built for had a one-second onset and a
 * seven-minute climb, so per-minute resolution is the requirement and an hourly roll-up would have
 * missed it entirely.
 */
const MAX_SAMPLES = 20_160;

/** Rewrite (rather than append) once this many appends have happened, to bound the file. */
const TRIM_EVERY = 500;

export function statsFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "session-stats.jsonl");
}

/**
 * Parse one `/proc/<pid>/stat` line. The comm field is parenthesised and may itself contain spaces
 * and parentheses (`(tmux: server)`), so everything is anchored on the LAST `)` rather than split
 * on whitespace: the classic way to get this wrong.
 *
 * Field numbers are 1-based per proc(5): 4 = ppid, 24 = rss (pages).
 */
export function parseStatLine(line: string): ProcRow | null {
  const close = line.lastIndexOf(")");
  const open = line.indexOf("(");
  if (close < 0 || open < 0 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  if (!Number.isFinite(pid)) return null;
  // After the comm, field 3 is state, so rest[0] = field 3 and rest[n] = field n+3.
  const rest = line.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(ppid) || !Number.isFinite(rssPages)) return null;
  return { pid, ppid, rssBytes: rssPages * PAGE_BYTES };
}

/**
 * Sum resident bytes over `root` and every descendant. Breadth-first with a visited set, so a
 * corrupt or cyclic parent chain costs one pass rather than hanging the gateway.
 */
export function sumSubtree(root: number, rows: ProcRow[]): { rssBytes: number; procs: number } {
  const byParent = new Map<number, ProcRow[]>();
  const byPid = new Map<number, ProcRow>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const kids = byParent.get(r.ppid);
    if (kids) kids.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const start = byPid.get(root);
  if (!start) return { rssBytes: 0, procs: 0 };
  const seen = new Set<number>([root]);
  let rssBytes = start.rssBytes;
  let procs = 1;
  const queue: number[] = [root];
  while (queue.length) {
    const pid = queue.shift()!;
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      rssBytes += kid.rssBytes;
      procs++;
      queue.push(kid.pid);
    }
  }
  return { rssBytes, procs };
}

/** tmux `list-panes -F '#{session_name} #{pane_pid} #{session_created}'` output → panes. */
export function parsePanes(stdout: string): Pane[] {
  const out: Pane[] = [];
  for (const line of String(stdout).split("\n")) {
    const [session, pid, created] = line.trim().split(/\s+/);
    if (!session || !pid) continue;
    const n = Number(pid);
    if (!Number.isFinite(n)) continue;
    out.push({ session, pid: n, createdSec: Number(created) || 0 });
  }
  return out;
}

/**
 * Fold panes + the process table into one sample. A session with several panes sums all of them.
 * `resolve` maps a tmux session name to its display name and project key; returning null drops the
 * session from the sample (that is how `_keepalive` and any non-Burrow session stay out).
 */
export function buildSample(
  panes: Pane[],
  rows: ProcRow[],
  nowMs: number,
  resolve: (session: string) => { name: string; project: string | null } | null,
): StatsSample {
  const bySession = new Map<string, { pids: number[]; createdSec: number }>();
  for (const p of panes) {
    const entry = bySession.get(p.session);
    if (entry) {
      entry.pids.push(p.pid);
      if (p.createdSec) entry.createdSec = Math.min(entry.createdSec || p.createdSec, p.createdSec);
    } else {
      bySession.set(p.session, { pids: [p.pid], createdSec: p.createdSec });
    }
  }
  const sessions: SessionStat[] = [];
  for (const [session, { pids, createdSec }] of bySession) {
    const who = resolve(session);
    if (!who) continue;
    let rssBytes = 0;
    let procs = 0;
    for (const pid of pids) {
      const sub = sumSubtree(pid, rows);
      rssBytes += sub.rssBytes;
      procs += sub.procs;
    }
    sessions.push({
      session,
      name: who.name,
      project: who.project,
      rssBytes,
      procs,
      ageMs: createdSec ? Math.max(0, nowMs - createdSec * 1000): 0,
    });
  }
  sessions.sort((a, b) => b.rssBytes - a.rssBytes);
  return { at: nowMs, sessions };
}

/** Keep only the newest `max` lines. Exported for the test, trimming is where a log silently dies. */
export function trimLines(lines: string[], max: number): string[] {
  return lines.length <= max ? lines: lines.slice(lines.length - max);
}

/**
 * Walk a process's parent chain, closest ancestor first. Pure, `parentOf` supplies the lookup, so
 * the walk is testable without a process table.
 *
 * This backs "is this caller one of ours": the `burrow` MCP server is a child of `claude`, which is
 * a child of either a tmux pane Burrow started or a bubble process it spawned. Env vars can't
 * answer that question (tmux drops `-e` on reattach) but the parent chain always can.
 *
 * Bounded and cycle-safe: a corrupt chain costs one short walk rather than hanging the gateway.
 */
export function walkAncestry(
  pid: number,
  parentOf: (pid: number) => number | null,
  max = 32,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = pid;
  for (let i = 0; i < max; i++) {
    const parent = parentOf(cur);
    if (parent === null || parent <= 0 || seen.has(parent)) break;
    seen.add(parent);
    chain.push(parent);
    if (parent === 1) break; // init: nothing above it is meaningful
    cur = parent;
  }
  return chain;
}

/** `/proc/<pid>/stat` → ppid, or null if the process is gone or unreadable. */
export function procParent(pid: number, procRoot = "/proc"): number | null {
  try {
    const row = parseStatLine(readFileSync(join(procRoot, String(pid), "stat"), "utf8"));
    return row ? row.ppid: null;
  } catch {
    return null;
  }
}

/** Read the host process table. Unreadable/vanished pids are skipped, never fatal. */
export async function readProcTable(procRoot = "/proc"): Promise<ProcRow[]> {
  let names: string[];
  try {
    names = await readdir(procRoot);
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  await Promise.all(
    names.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      try {
        const row = parseStatLine(await readFile(join(procRoot, name, "stat"), "utf8"));
        if (row) rows.push(row);
      } catch {
        /* process exited between readdir and read, normal, ignore */
      }
    }),
  );
  return rows;
}

/**
 * Owns the sampling tick, the in-memory latest sample, and the rolling on-disk log.
 *
 * The gateway serves `latest()` straight from memory, so a client polling `sessions.active` every
 * 5s costs nothing: the /proc walk happens once a minute regardless of how many browsers are open.
 */
export class SessionSampler {
  private sample: StatsSample = { at: 0, sessions: [] };
  private appends = 0;

  constructor(
    private readonly listPanes: () => Promise<Pane[]>,
    private readonly resolve: (session: string) => { name: string; project: string | null } | null,
  ) {}

  /** The most recent sample. `at: 0` means nothing has been sampled yet. */
  latest(): StatsSample {
    return this.sample;
  }

  /** One sampling pass: tmux + /proc → memory → disk. Never throws. */
  async tick(now = Date.now()): Promise<StatsSample> {
    try {
      const [panes, rows] = await Promise.all([this.listPanes(), readProcTable()]);
      this.sample = buildSample(panes, rows, now, this.resolve);
      await this.persist(this.sample);
    } catch {
      /* a failed sample must never take the gateway's poll loop down */
    }
    return this.sample;
  }

  private async persist(sample: StatsSample): Promise<void> {
    const file = statsFile();
    const line = JSON.stringify(sample) + "\n";
    try {
      await mkdir(dirname(file), { recursive: true });
      if (this.appends >= TRIM_EVERY || this.appends === 0) {
        // Bound the file: read what's there, keep the newest MAX_SAMPLES, rewrite.
        let existing: string[] = [];
        try {
          existing = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        } catch {
          /* first run: no file yet */
        }
        existing.push(JSON.stringify(sample));
        await writeFile(file, trimLines(existing, MAX_SAMPLES).join("\n") + "\n");
        this.appends = 1;
      } else {
        await appendFile(file, line);
        this.appends++;
      }
    } catch {
      /* disk full / read-only: the in-memory sample still works, which is the visible half */
    }
  }
}
