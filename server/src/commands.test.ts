/**
 * Slash-command listing suite. Stakes: this list IS the composer palette, and
 * it was wrong in a way nobody could see: it scanned `.claude/commands/` only, so on this box it
 * offered 1 of the 8 things a user can actually type (7 of them are skills). A palette that hides
 * most of what works is worse than no palette: it reads as "that's all there is".
 *
 * Temp CLAUDE_CONFIG_DIR throughout: the real one is never read.
 */
import { afterAll, beforeAll, expect, describe, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCommands, mergeKnown, type SlashCommand } from "./commands.js";

let cfg: string;
let proj: string;
let saved: string | undefined;

beforeAll(async () => {
  cfg = await mkdtemp(join(tmpdir(), "cmd-cfg-"));
  proj = await mkdtemp(join(tmpdir(), "cmd-proj-"));
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;

  await mkdir(join(proj, ".claude", "commands", "deploy"), { recursive: true });
  await writeFile(
    join(proj, ".claude", "commands", "ship.md"),
    "---\ndescription: ship it\n---\nbody\n",
  );
  await writeFile(join(proj, ".claude", "commands", "deploy", "staging.md"), "# Push to staging\n");

  await mkdir(join(cfg, "commands"), { recursive: true });
  await writeFile(join(cfg, "commands", "rtk.md"), "---\ndescription: token proxy\n---\n");
  await writeFile(join(cfg, "commands", "ship.md"), "---\ndescription: user version\n---\n");

  await mkdir(join(cfg, "skills", "night-build"), { recursive: true });
  await writeFile(
    join(cfg, "skills", "night-build", "SKILL.md"),
    "---\nname: night-build\ndescription: Overnight autonomous build cycle\n---\nbody\n",
  );
  await mkdir(join(cfg, "skills", "no-skill-file"), { recursive: true }); // a dir, but empty
  await mkdir(join(proj, ".claude", "skills", "local-skill"), { recursive: true });
  await writeFile(join(proj, ".claude", "skills", "local-skill", "SKILL.md"), "# Local thing\n");
});

afterAll(async () => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  await rm(cfg, { recursive: true, force: true });
  await rm(proj, { recursive: true, force: true });
});

const byName = (list: SlashCommand[]) => Object.fromEntries(list.map((c) => [c.name, c]));

describe("listCommands", () => {
  it("finds skills as well as commands, from both project and user scope", async () => {
    const found = byName(await listCommands(proj));
    expect(found["ship"]?.scope).toBe("project");
    expect(found["rtk"]?.scope).toBe("user");
    expect(found["night-build"]?.scope).toBe("skill"); // the whole point, was missing entirely
    expect(found["local-skill"]?.scope).toBe("skill");
    expect(found["deploy:staging"]?.scope).toBe("project"); // one subdir deep keeps dir:name
  });

  it("reads descriptions from frontmatter, falling back to the first line", async () => {
    const found = byName(await listCommands(proj));
    expect(found["night-build"]?.description).toBe("Overnight autonomous build cycle");
    expect(found["ship"]?.description).toBe("ship it");
    expect(found["deploy:staging"]?.description).toBe("Push to staging");
  });

  it("skips a skills directory with no SKILL.md", async () => {
    expect(byName(await listCommands(proj))["no-skill-file"]).toBeUndefined();
  });

  it("gives the project's version of a name, not the user's", async () => {
    const found = byName(await listCommands(proj));
    expect(found["ship"]?.description).toBe("ship it"); // not "user version"
  });

  it("returns sorted, unique names", async () => {
    const names = (await listCommands(proj)).map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("is empty, not broken, for a directory with nothing in it", async () => {
    const bare = await mkdtemp(join(tmpdir(), "cmd-bare-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = bare;
    expect(await listCommands(bare)).toEqual([]);
    process.env.CLAUDE_CONFIG_DIR = prev;
    await rm(bare, { recursive: true, force: true });
  });
});

describe("mergeKnown", () => {
  const scanned: SlashCommand[] = [
    { name: "ship", description: "ship it", scope: "project" },
    { name: "night-build", description: "overnight", scope: "skill" },
  ];

  it("adds the built-ins the CLI declared and we cannot see on disk", () => {
    const merged = byName(mergeKnown(scanned, ["compact", "context", "model", "ship"]));
    expect(merged["compact"]?.scope).toBe("session");
    expect(merged["context"]?.scope).toBe("session");
  });

  it("never overwrites what the scan already described", () => {
    const merged = byName(mergeKnown(scanned, ["ship", "night-build"]));
    expect(merged["ship"]?.description).toBe("ship it");
    expect(merged["ship"]?.scope).toBe("project");
    expect(merged["night-build"]?.scope).toBe("skill");
  });

  it("drops the CLI's internal plumbing", () => {
    // Real entries observed in an init frame: nobody types these.
    const names = mergeKnown(scanned, ["__remote-workflow", "compact"]).map((c) => c.name);
    expect(names).not.toContain("__remote-workflow");
    expect(names).toContain("compact");
  });

  it("dedupes a repeated name and sorts the result", () => {
    const names = mergeKnown(scanned, ["zebra", "compact", "compact", "alpha"]).map((c) => c.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("is a no-op before any session has reported (the pre-first-turn case)", () => {
    expect(mergeKnown(scanned, [])).toEqual([...scanned].sort((a, b) => a.name.localeCompare(b.name)));
  });
});
