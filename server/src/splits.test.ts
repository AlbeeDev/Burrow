/**
 * Saved-splits store suite. Real stakes: this file is the only copy of a
 * user's layouts, and a half-written or hand-edited entry must degrade to "that split is
 * missing", never to "the sidebar section is empty" or a crash. Temp BURROW_DATA_DIR, no
 * real ~/.burrow touched.
 */
import { afterAll, beforeAll, beforeEach, expect, describe, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSplits, writeSplits, type SavedSplit } from "./splits.js";

let tmp: string;
let saved: string | undefined;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "splits-"));
  saved = process.env.BURROW_DATA_DIR;
  process.env.BURROW_DATA_DIR = tmp;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.BURROW_DATA_DIR;
  else process.env.BURROW_DATA_DIR = saved;
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(tmp, "splits.json"), { force: true });
});

const split = (over: Partial<SavedSplit> = {}): SavedSplit => ({
  id: "s1",
  name: "Night work",
  panels: [{ project: "burrow" }, { project: null }],
...over,
});

describe("splits store", () => {
  it("round-trips a layout", async () => {
    await writeSplits([split()]);
    const back = await readSplits();
    expect(back).toEqual([split()]);
  });

  it("keeps empty, master and project panels distinguishable", async () => {
    await writeSplits([split({ panels: [null, { project: null }, { project: "alpha" }] })]);
    const [s] = await readSplits();
    expect(s!.panels).toEqual([null, { project: null }, { project: "alpha" }]);
  });

  it("does not store focus, and ignores one left by an older version", async () => {
    // Focus used to live here; a click on a panel then meant a server write. Files written
    // from older versions still carry it, and it must neither survive nor break the entry.
    await writeFile(
      join(tmp, "splits.json"),
      JSON.stringify({ splits: [{ id: "old", name: "Legacy", panels: [{ project: "a" }], focus: 3 }] }),
    );
    const [s] = await readSplits();
    expect(s).toEqual({ id: "old", name: "Legacy", panels: [{ project: "a" }] });
    await writeSplits([split()]);
    const raw = JSON.parse(await readFile(join(tmp, "splits.json"), "utf8"));
    expect(Object.keys(raw.splits[0]).sort()).toEqual(["id", "name", "panels"]);
  });

  it("survives create / rename / delete as whole-list writes", async () => {
    await writeSplits([split(), split({ id: "s2", name: "Review" })]);
    const renamed = (await readSplits()).map((s) => (s.id === "s1" ? {...s, name: "Deep work" }: s));
    await writeSplits(renamed);
    expect((await readSplits()).map((s) => s.name)).toEqual(["Deep work", "Review"]);
    await writeSplits((await readSplits()).filter((s) => s.id !== "s1"));
    expect((await readSplits()).map((s) => s.id)).toEqual(["s2"]);
  });

  it("drops broken entries instead of losing the whole file", async () => {
    await writeFile(
      join(tmp, "splits.json"),
      JSON.stringify({
        splits: [
          { id: "good", name: "Fine", panels: [{ project: "a" }] },
          null, // garbage entry
          { id: "nopanels", name: "Empty", panels: [] }, // unopenable
          { id: "good", name: "Duplicate id", panels: [{ project: "b" }] },
          { name: "No id", panels: [{ project: "c" }] }, // repaired, not dropped
        ],
      }),
    );
    const back = await readSplits();
    expect(back.map((s) => s.name)).toEqual(["Fine", "No id"]);
    expect(back[1]!.id).toBeTruthy();
  });

  it("returns [] for a missing or unparseable file", async () => {
    expect(await readSplits()).toEqual([]);
    await writeFile(join(tmp, "splits.json"), "{ not json");
    expect(await readSplits()).toEqual([]);
  });

  it("caps panels at 8 (stage + parked) and trims long names", async () => {
    await writeSplits([
      split({ panels: Array.from({ length: 20 }, (_, i) => ({ project: `p${i}` })), name: "x".repeat(200) }),
    ]);
    const [s] = await readSplits();
    expect(s!.panels.length).toBe(8);
    expect(s!.name.length).toBe(60);
  });

  it("writes a stable, human-readable file", async () => {
    await writeSplits([split()]);
    const raw = JSON.parse(await readFile(join(tmp, "splits.json"), "utf8"));
    expect(Object.keys(raw)).toEqual(["splits"]);
    expect(raw.splits[0].panels[1]).toEqual({ project: null }); // master survives JSON
  });
});
