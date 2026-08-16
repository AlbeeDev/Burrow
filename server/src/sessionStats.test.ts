/**
 * Session memory sampling: the parts where being wrong is silent.
 *
 * This log's whole value is being trustworthy after an incident, when nobody can go back and
 * re-measure. Three ways it could lie without anyone noticing:
 *
 *  - `/proc/<pid>/stat` parsing: the comm field is parenthesised and may contain spaces AND
 *    parentheses, so a naive whitespace split reads the wrong column and reports a plausible
 *    wrong number. `(tmux: server)` is a real process name on this box.
 *  - subtree summing: a session's memory lives in `claude`, a CHILD of the pane's shell. Miss the
 *    walk and every session reads as ~4 MB, which looks like healthy data.
 *  - trimming: the rolling log is the only record; an off-by-one that drops the newest line
 *    instead of the oldest destroys exactly the sample you came back for.
 */

import { describe, it, expect } from "vitest";
import { parseStatLine, sumSubtree, parsePanes, buildSample, trimLines, walkAncestry, type ProcRow } from "./sessionStats.js";

const PAGE = 4096;

describe("parseStatLine", () => {
  it("reads ppid and rss from a normal line", () => {
    // fields: pid (comm) state ppid... rss is field 24 → index 21 after the comm
    const rest = ["S", "1000", ...Array(19).fill("0"), "512"].join(" ");
    expect(parseStatLine(`4242 (bash) ${rest}`)).toEqual({
      pid: 4242,
      ppid: 1000,
      rssBytes: 512 * PAGE,
    });
  });

  it("survives a comm containing spaces and a colon", () => {
    const rest = ["S", "1", ...Array(19).fill("0"), "1024"].join(" ");
    const row = parseStatLine(`7 (tmux: server) ${rest}`);
    expect(row).toEqual({ pid: 7, ppid: 1, rssBytes: 1024 * PAGE });
  });

  it("anchors on the LAST paren, so a comm with parens inside still parses", () => {
    const rest = ["R", "3", ...Array(19).fill("0"), "8"].join(" ");
    const row = parseStatLine(`9 (weird (name)) ${rest}`);
    expect(row).toEqual({ pid: 9, ppid: 3, rssBytes: 8 * PAGE });
  });

  it("returns null rather than a wrong number on garbage", () => {
    expect(parseStatLine("")).toBeNull();
    expect(parseStatLine("no parens here at all")).toBeNull();
    expect(parseStatLine("12 (sh) S")).toBeNull(); // truncated: no rss column
  });
});

describe("sumSubtree", () => {
  const rows: ProcRow[] = [
    { pid: 100, ppid: 1, rssBytes: 4_000_000 }, // pane shell
    { pid: 101, ppid: 100, rssBytes: 900_000_000 }, // claude, where the memory actually is
    { pid: 102, ppid: 101, rssBytes: 20_000_000 }, // a tool it spawned
    { pid: 200, ppid: 1, rssBytes: 7_000_000 }, // an unrelated session
  ];

  it("sums the whole subtree, not just the root", () => {
    expect(sumSubtree(100, rows)).toEqual({ rssBytes: 924_000_000, procs: 3 });
  });

  it("does not reach sideways into another session", () => {
    expect(sumSubtree(200, rows).rssBytes).toBe(7_000_000);
  });

  it("reports zero for a pid that has already exited", () => {
    expect(sumSubtree(999, rows)).toEqual({ rssBytes: 0, procs: 0 });
  });

  it("terminates on a cyclic parent chain instead of hanging the gateway", () => {
    const cyclic: ProcRow[] = [
      { pid: 1, ppid: 2, rssBytes: 10 },
      { pid: 2, ppid: 1, rssBytes: 20 },
    ];
    expect(sumSubtree(1, cyclic)).toEqual({ rssBytes: 30, procs: 2 });
  });
});

describe("parsePanes", () => {
  it("parses tmux's three columns and skips noise", () => {
    const out = parsePanes("burrow_a 111 1785513935\n_keepalive 222 1785513394\n\nbroken line\n");
    expect(out).toEqual([
      { session: "burrow_a", pid: 111, createdSec: 1785513935 },
      { session: "_keepalive", pid: 222, createdSec: 1785513394 },
    ]);
  });
});

describe("buildSample", () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, rssBytes: 100_000_000 },
    { pid: 11, ppid: 10, rssBytes: 6_200_000_000 }, // the runaway
    { pid: 20, ppid: 1, rssBytes: 300_000_000 },
    { pid: 30, ppid: 1, rssBytes: 5_000_000 },
  ];
  const now = 1_800_000_000_000;
  const resolve = (s: string) =>
    s.startsWith("burrow_") ? { name: s.slice(7), project: s.slice(7) }: null;

  it("orders by resident size, so the problem is the first row", () => {
    const sample = buildSample(
      [
        { session: "burrow_small", pid: 20, createdSec: now / 1000 - 600 },
        { session: "burrow_big", pid: 10, createdSec: now / 1000 - 3600 },
      ],
      rows,
      now,
      resolve,
    );
    expect(sample.sessions.map((s) => s.name)).toEqual(["big", "small"]);
    expect(sample.sessions[0]!.rssBytes).toBe(6_300_000_000);
    expect(sample.sessions[0]!.procs).toBe(2);
    expect(sample.sessions[0]!.ageMs).toBe(3_600_000);
  });

  it("sums every pane of a multi-pane session", () => {
    const sample = buildSample(
      [
        { session: "burrow_x", pid: 20, createdSec: now / 1000 - 60 },
        { session: "burrow_x", pid: 30, createdSec: now / 1000 - 60 },
      ],
      rows,
      now,
      resolve,
    );
    expect(sample.sessions).toHaveLength(1);
    expect(sample.sessions[0]!.rssBytes).toBe(305_000_000);
  });

  it("drops sessions the resolver refuses, _keepalive is not somebody's work", () => {
    const sample = buildSample(
      [{ session: "_keepalive", pid: 30, createdSec: now / 1000 - 60 }],
      rows,
      now,
      resolve,
    );
    expect(sample.sessions).toEqual([]);
  });

  it("reports age 0 rather than a nonsense age when tmux gives no creation time", () => {
    const sample = buildSample(
      [{ session: "burrow_x", pid: 30, createdSec: 0 }],
      rows,
      now,
      resolve,
    );
    expect(sample.sessions[0]!.ageMs).toBe(0);
  });
});

describe("trimLines", () => {
  it("keeps the NEWEST lines when over the cap", () => {
    expect(trimLines(["a", "b", "c", "d"], 2)).toEqual(["c", "d"]);
  });

  it("leaves a short log alone", () => {
    expect(trimLines(["a", "b"], 5)).toEqual(["a", "b"]);
  });
});

/**
 * Ancestry: the mechanism behind "is this `show` caller one of ours".
 *
 * The `burrow` MCP server is registered at USER scope, so every `claude` on this box has the tool,
 * including a plain ssh session Burrow knows nothing about. The obvious answers both fail: the
 * `TMUX` env var is absent in bubble mode (no tmux at all), and a per-session secret would have to
 * arrive by environment, which tmux drops on reattach. The parent chain works for both.
 */
describe("walkAncestry", () => {
  const tree: Record<number, number> = {
    // mcp → claude → shell(pane) → tmux server → init
    500: 400,
    400: 300,
    300: 200,
    200: 1,
  };
  const parentOf = (pid: number) => tree[pid] ?? null;

  it("walks from the caller to init, closest first", () => {
    expect(walkAncestry(500, parentOf)).toEqual([400, 300, 200, 1]);
  });

  it("finds a Burrow-owned ancestor for a TERMINAL session (pane pid two hops up)", () => {
    const owned = new Set([300]); // the tmux pane's shell
    expect(walkAncestry(500, parentOf).some((p) => owned.has(p))).toBe(true);
  });

  it("finds a Burrow-owned ancestor for a BUBBLE session (the spawned claude itself)", () => {
    // Bubble has no tmux; the spawn execs into `claude`, so its pid IS the ancestor to match.
    const owned = new Set([400]);
    expect(walkAncestry(500, parentOf).some((p) => owned.has(p))).toBe(true);
  });

  it("finds nothing for a session Burrow did not start", () => {
    const stray: Record<number, number> = { 900: 800, 800: 1 }; // sshd → init
    const owned = new Set([300, 400]);
    expect(walkAncestry(900, (p) => stray[p] ?? null).some((a) => owned.has(a))).toBe(false);
  });

  it("stops at a process that has already exited", () => {
    expect(walkAncestry(500, (p) => (p === 500 ? 400: null))).toEqual([400]);
  });

  it("terminates on a cycle instead of hanging the gateway", () => {
    const loop: Record<number, number> = { 1: 2, 2: 1 };
    expect(walkAncestry(1, (p) => loop[p] ?? null)).toEqual([2]);
  });

  it("respects the hop limit", () => {
    // A long chain must not become an unbounded walk of the whole process table.
    expect(walkAncestry(100, (p) => p + 1, 3)).toEqual([101, 102, 103]);
  });
});
