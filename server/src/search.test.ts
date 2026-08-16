/**
 * searchHistory suite (Cmd-K cross-project search). Pins: case-insensitive
 * matching with a snippet, agent-* sidecars excluded, per-project and total caps honored,
 * multi-project results. Temp CLAUDE_CONFIG_DIR, no real ~/.claude touched.
 */
import { afterAll, beforeAll, expect, describe, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchHistory } from "./history.js";

let tmp: string;
let savedEnv: string | undefined;

function entry(type: "user" | "assistant", text: string): string {
  return JSON.stringify({ type, sessionId: "s1", message: { role: type, content: text } }) + "\n";
}

async function seedProject(cwd: string, file: string, lines: string): Promise<void> {
  const dir = join(tmp, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), lines);
}

const PROJECTS = [
  { name: "alpha", cwd: "/root/alpha" },
  { name: "beta", cwd: "/root/beta" },
];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "search-"));
  savedEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;

  await seedProject(
    "/root/alpha",
    "a.jsonl",
    entry("user", "let us discuss the Flux Capacitor wiring") + entry("assistant", "plain other text"),
  );
  // agent sidecar containing the needle must NOT count
  await seedProject("/root/alpha", "agent-x.jsonl", entry("assistant", "flux capacitor in a sidecar"));
  await seedProject("/root/beta", "b.jsonl", entry("assistant", "FLUX CAPACITOR again, different project"));
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  await rm(tmp, { recursive: true, force: true });
});

describe("searchHistory", () => {
  it("matches case-insensitively across projects with snippets", async () => {
    const { hits } = await searchHistory(PROJECTS, "flux capacitor");
    expect(hits.map((h) => h.project).sort()).toEqual(["alpha", "beta"]);
    expect(hits.find((h) => h.project === "alpha")!.snippet).toContain("Flux Capacitor wiring");
    expect(hits.every((h) => h.when > 0)).toBe(true); // session date rides along
  });

  it("carries the whole message for expand-in-place, capped", async () => {
    // The palette expands a hit without a second round trip, so the hit has to carry the full
    // message, and a single message can be a megabyte of pasted output, hence the cap.
    const long = "x".repeat(9000);
    await seedProject("/root/alpha", "long.jsonl", entry("user", `before the marker42 ${long}`));
    const { hits } = await searchHistory([PROJECTS[0]!], "marker42");
    const hit = hits.find((h) => h.full.includes("marker42"))!;
    expect(hit.snippet.length).toBeLessThan(200); // the list still shows a one-liner
    expect(hit.full.length).toBe(4000);
    expect(hit.truncated).toBe(true);

    const short = await searchHistory([PROJECTS[0]!], "flux capacitor wiring");
    const plain = short.hits.find((h) => h.project === "alpha")!;
    expect(plain.full).toBe("let us discuss the Flux Capacitor wiring"); // whole message, untruncated
    expect(plain.truncated).toBe(false);
  });

  it("ignores agent-* sidecar transcripts", async () => {
    const { hits } = await searchHistory([PROJECTS[0]!], "sidecar");
    expect(hits).toEqual([]);
  });

  it("returns nothing for a project with no sessions or an empty query", async () => {
    expect((await searchHistory([{ name: "ghost", cwd: "/root/ghost" }], "flux")).hits).toEqual([]);
    expect((await searchHistory(PROJECTS, "")).hits).toEqual([]);
  });

  it("honors per-project and total caps", async () => {
    const many = Array.from({ length: 10 }, (_, i) => entry("user", `needle number ${i}`)).join("");
    await seedProject("/root/alpha", "many.jsonl", many);
    const perProject = await searchHistory([PROJECTS[0]!], "needle");
    expect(perProject.hits.length).toBe(3); // capPerProject
    const total = await searchHistory(PROJECTS, "needle", { capTotal: 2, capPerProject: 3 });
    expect(total.hits.length).toBe(2); // capTotal
  });

  // The Cmd-K continuation: reach past the old "3 newest files per project" bound.
  it("finds text that exists only in an OLD session file", async () => {
    for (let i = 0; i < 8; i++) {
      await seedProject("/root/alpha", `filler-${i}.jsonl`, entry("user", `filler chatter ${i}`));
    }
    // Make the needle's file the oldest of the project's ~11 sessions.
    await seedProject("/root/alpha", "ancient.jsonl", entry("assistant", "the buried treasure map"));
    await utimes(join(tmp, "projects", "-root-alpha", "ancient.jsonl"), new Date(0), new Date(0));
    const { hits, scanned, total } = await searchHistory([PROJECTS[0]!], "buried treasure");
    expect(hits.map((h) => h.snippet.includes("buried treasure"))).toEqual([true]);
    expect(total).toBeGreaterThan(3); // the old bound would have stopped at 3
    expect(scanned).toBe(total); // and it reported honestly how far it got
  });

  it("reports coverage without pretending it searched everything", async () => {
    const { scanned, total } = await searchHistory(PROJECTS, "nothing-matches-this", { budgetMs: 0 });
    expect(total).toBeGreaterThan(0);
    expect(scanned).toBeLessThan(total); // budget exhausted → honest partial coverage
  });

  it("only matches conversation text, not transcript metadata", async () => {
    await seedProject("/root/beta", "meta.jsonl", JSON.stringify({
      type: "user",
      sessionId: "zz-uniquemarker-zz",
      message: { role: "user", content: "unrelated words" },
    }) + "\n");
    const { hits } = await searchHistory([PROJECTS[1]!], "uniquemarker");
    expect(hits).toEqual([]);
  });
});
