/**
 * Image-push suite. Real stakes on two axes:
 *
 * 1. Containment. A push names a file by path and the gateway reads it with the browser's
 *    privileges. If that path can escape the project, the MCP tool becomes a read-anything
 *    primitive for anyone who can prompt the model.
 * 2. Honest failures. Every rejection must say something DIFFERENT and true. A vague or
 *    falsely-successful answer makes the model tell a human to look at their screen when
 *    nothing is there, which is worse than the tool not existing.
 *
 * The push handlers are exercised directly: the unix socket is transport, not logic.
 */
import { afterAll, beforeAll, expect, describe, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, truncate, utimes, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageBridge, type PushedItem } from "./images.js";


/**
 * Every call goes through the REAL dispatcher (`call`), not straight into a tool, because v3 moved
 * identity resolution, ownership and the project lookup into that one place, and testing past it
 * would test a path no caller uses.
 */
type Answer = { ok: boolean; message: string };
const PID = 4242; // a stable caller identity, the read-before-write guard is per caller

const listMedia = (b: ImageBridge, cwd: string, pid = PID) =>
  b.call({ op: "call", name: "list_media", cwd, pid, arguments: {} }) as Promise<Answer>;
const writeMedia = (b: ImageBridge, cwd: string, media: unknown, pid = PID) =>
  b.call({ op: "call", name: "write_media", cwd, pid, arguments: { media } }) as Promise<Answer>;

/** Read-then-write, which is what every honest caller does. */
const setMedia = async (b: ImageBridge, cwd: string, media: unknown, pid = PID) => {
  await listMedia(b, cwd, pid);
  return writeMedia(b, cwd, media, pid);
};
/** Put exactly one thing on screen. Enough for the containment and failure-message cases. */
const show = (b: ImageBridge, cwd: string, path: string, caption = "") =>
  setMedia(b, cwd, [{ path, caption }]);

let root: string; // projects root
let proj: string; // root/alpha
let outside: string; // a directory that is NOT under the projects root
let dataDir: string; // throwaway BURROW_DATA_DIR, the suite must never touch the real one
const REAL_DATA_DIR = process.env.BURROW_DATA_DIR;

const pushes: { project: string | null; image: PushedItem }[] = [];
let bridge: ImageBridge;

// 1×1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

beforeAll(async () => {
  // v3 persists the strip to BURROW_DATA_DIR. Without this the suite writes into the REAL
  // ~/.burrow/pushes.json and the owner's strip fills up with test fixtures, caught exactly that
  // way after a deploy showed "alpha: deep.png" in live data.
  dataDir = await mkdtemp(join(tmpdir(), "burrow-images-data-"));
  process.env.BURROW_DATA_DIR = dataDir;
  root = await mkdtemp(join(tmpdir(), "burrow-images-"));
  outside = await mkdtemp(join(tmpdir(), "burrow-outside-"));
  proj = join(root, "alpha");
  await mkdir(join(proj, "shots"), { recursive: true });
  await mkdir(join(root, "beta"), { recursive: true });
  await writeFile(join(proj, "shot.png"), PNG);
  await writeFile(join(proj, "shots", "deep.png"), PNG);
  await writeFile(join(proj, "notes.txt"), "not an image");
  await writeFile(join(root, "beta", "secret.png"), PNG);
  await writeFile(join(outside, "secret.png"), PNG);
  await symlink(join(outside, "secret.png"), join(proj, "link.png"));
  bridge = new ImageBridge(root, (project, image) => pushes.push({ project, image }));
});

afterAll(async () => {
  if (REAL_DATA_DIR === undefined) delete process.env.BURROW_DATA_DIR;
  else process.env.BURROW_DATA_DIR = REAL_DATA_DIR;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

describe("show()", () => {
  it("shows an image inside the project and pushes the bytes", async () => {
    const before = pushes.length;
    const r = await show(bridge, proj, join(proj, "shot.png"), "the thing");
    expect(r.ok).toBe(true);
    expect(r.message).toContain("alpha");
    expect(pushes.length).toBe(before + 1);
    const { project, image } = pushes[pushes.length - 1]!;
    expect(project).toBe("alpha");
    expect(image.name).toBe("shot.png");
    expect(image.mime).toBe("image/png");
    expect(image.caption).toBe("the thing");
    expect(image.kind).toBe("image");
    expect(image.size).toBe(PNG.length);
    // v2 announces, it does not carry: the browser fetches /push/<id>/<name> itself.
    expect(image).not.toHaveProperty("data");
  });

  it("accepts a path relative to the session cwd", async () => {
    const r = await show(bridge, proj, "shots/deep.png", "");
    expect(r.ok).toBe(true);
  });

  it("resolves a RELATIVE path against the caller's cwd, not the project root", async () => {
    // Regression: v3 moved path resolution out of the stdio script and into the gateway. Resolving
    // against the project dir instead of the caller's cwd looks right in every test where a session
    // sits at the project root, and is wrong for every session started in a subdirectory.
    await writeFile(join(proj, "shots", "local.png"), PNG);
    const r = await show(bridge, join(proj, "shots"), "local.png", "");
    expect(r.ok, r.message).toBe(true);
    expect(pushes[pushes.length - 1]!.image.rel).toBe("shots/local.png");
  });

  it("resolves a subdirectory cwd back to its project", async () => {
    const before = pushes.length;
    const r = await show(bridge, join(proj, "shots"), join(proj, "shot.png"), "");
    expect(r.ok).toBe(true);
    expect(pushes[pushes.length - 1]!.project).toBe("alpha");
    expect(pushes.length).toBe(before + 1);
  });

  it("treats the projects root itself as the master shell", async () => {
    await writeFile(join(root, "top.png"), PNG);
    const r = await show(bridge, root, join(root, "top.png"), "");
    expect(r.ok).toBe(true);
    expect(pushes[pushes.length - 1]!.project).toBeNull();
  });

  // --- containment: each of these must refuse AND must not push ---

  it("refuses an absolute path in another project", async () => {
    const before = pushes.length;
    const r = await show(bridge, proj, join(root, "beta", "secret.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("outside this project");
    expect(pushes.length).toBe(before);
  });

  it("refuses a traversal path", async () => {
    const r = await show(bridge, proj, "../beta/secret.png", "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("outside this project");
  });

  it("refuses a path outside the projects root entirely", async () => {
    const r = await show(bridge, proj, join(outside, "secret.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("outside this project");
  });

  it("refuses a symlink that points out of the project", async () => {
    // Lexically this is inside; only the realpath check in boundPath() catches it.
    const before = pushes.length;
    const r = await show(bridge, proj, join(proj, "link.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("outside this project");
    expect(pushes.length).toBe(before);
  });

  it("refuses a cwd that is not a Burrow project", async () => {
    const r = await show(bridge, outside, join(outside, "secret.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Not running inside a Burrow session");
  });

  // --- the other honest failures, each distinct ---

  it("refuses a non-image and names what it can show", async () => {
    const r = await show(bridge, proj, join(proj, "notes.txt"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not a displayable type");
    expect(r.message).toContain(".png");
  });

  it("says so when the file does not exist", async () => {
    const r = await show(bridge, proj, join(proj, "nope.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no such file");
  });

  it("refuses an oversized file WITH the limit", async () => {
    // Sparse: `truncate` reports the size without writing 513 MB to the test runner's disk.
    await writeFile(join(proj, "huge.png"), "");
    await truncate(join(proj, "huge.png"), 513 * 1024 * 1024);
    const r = await show(bridge, proj, join(proj, "huge.png"), "");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("512.0 MB"); // the cap must be IN the message, not just implied
  });

  it("gives every failure mode a different sentence", async () => {
    const messages = await Promise.all([
      show(bridge, outside, join(outside, "secret.png"), ""),
      show(bridge, proj, join(root, "beta", "secret.png"), ""),
      show(bridge, proj, join(proj, "notes.txt"), ""),
      show(bridge, proj, join(proj, "huge.png"), ""),
    ]).then((rs) => rs.map((r) => r.message));
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("the list", () => {
  it("comes back in the order it was written, not by time", async () => {
    // Order is the caller's now: reordering is one of the things a whole-list write buys.
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [
      { path: "shots/deep.png", caption: "one" },
      { path: "shot.png", caption: "two" },
    ]);
    expect((await fresh.recent("alpha")).map((r) => r.caption)).toEqual(["one", "two"]);
    await setMedia(fresh, proj, [
      { path: "shot.png", caption: "two" },
      { path: "shots/deep.png", caption: "one" },
    ]);
    expect((await fresh.recent("alpha")).map((r) => r.caption)).toEqual(["two", "one"]);
  });

  it("carries metadata, never bytes", async () => {
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [{ path: "shot.png" }]);
    const row = (await fresh.recent("alpha"))[0]!;
    expect(row.kind).toBe("image");
    expect(row.size).toBe(PNG.length);
    expect(row).not.toHaveProperty("data");
  });

  it("skips entries whose file is gone rather than failing the whole list", async () => {
    const fresh = new ImageBridge(root, () => {});
    await writeFile(join(proj, "temp.png"), PNG);
    await setMedia(fresh, proj, [{ path: "temp.png", caption: "doomed" }, { path: "shot.png", caption: "survivor" }]);
    await rm(join(proj, "temp.png"));
    expect((await fresh.recent("alpha")).map((r) => r.caption)).toEqual(["survivor"]);
  });

  it("has no cap", async () => {
    // "Just don't make a number, make it infinite." The old cap of 10 was sized
    // when the gateway held base64 bytes; entries are metadata now.
    const fresh = new ImageBridge(root, () => {});
    await mkdir(join(proj, "many"), { recursive: true });
    const media = [];
    for (let i = 0; i < 25; i++) {
      await writeFile(join(proj, "many", `f${i}.png`), PNG);
      media.push({ path: `many/f${i}.png` });
    }
    await setMedia(fresh, proj, media);
    expect(await fresh.recent("alpha")).toHaveLength(25);
  });

  it("survives a restart", async () => {
    const a = new ImageBridge(root, () => {});
    await setMedia(a, proj, [{ path: "shot.png", caption: "persisted" }]);
    const b = new ImageBridge(root, () => {});
    await b.start();
    try {
      expect((await b.recent("alpha")).map((r) => r.caption)).toEqual(["persisted"]);
    } finally {
      await b.stop();
    }
  });
});

/**
 * Read-before-write. A write replaces the WHOLE list, so writing one you have not read is exactly
 * how an entry gets dropped by being forgotten. Version-checked, not just "have you ever read": a
 * stale read drops entries just as easily as no read at all.
 */
describe("write_media guard", () => {
  it("refuses a write with no read at all", async () => {
    const fresh = new ImageBridge(root, () => {});
    const r = await writeMedia(fresh, proj, [{ path: "shot.png" }]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("call `list_media` first");
    expect(await fresh.recent("alpha")).toEqual([]);
  });

  it("refuses a write whose read is STALE", async () => {
    const fresh = new ImageBridge(root, () => {});
    await listMedia(fresh, proj);                                  // we read version 0
    await setMedia(fresh, proj, [{ path: "shot.png" }], 999);      // somebody else changes it
    const r = await writeMedia(fresh, proj, []);                   // our read is out of date
    expect(r.ok).toBe(false);
    expect(r.message).toContain("changed since you read it");
    expect(await fresh.recent("alpha")).toHaveLength(1);           // and it really did not clear
  });

  it("is per caller: one session reading does not license another to write", async () => {
    const fresh = new ImageBridge(root, () => {});
    await listMedia(fresh, proj, 111);
    const r = await writeMedia(fresh, proj, [{ path: "shot.png" }], 222);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("call `list_media` first");
  });

  it("lets the writer write again without re-reading", async () => {
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [{ path: "shot.png" }]);
    const r = await writeMedia(fresh, proj, []);
    expect(r.ok).toBe(true);
    expect(await fresh.recent("alpha")).toEqual([]);
  });
});

describe("write_media behaviour", () => {
  it("clears the screen with an empty list, and never touches the file", async () => {
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [{ path: "shot.png" }]);
    const r = await setMedia(fresh, proj, []);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("cleared");
    expect(await fresh.recent("alpha")).toEqual([]);
    await stat(join(proj, "shot.png"));
  });

  it("keeps id and arrival time for entries that survive a rewrite", async () => {
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [{ path: "shot.png" }]);
    const before = (await fresh.recent("alpha"))[0]!;
    await new Promise((r) => setTimeout(r, 5));
    await setMedia(fresh, proj, [{ path: "shots/deep.png" }, { path: "shot.png", caption: "new caption" }]);
    const after = (await fresh.recent("alpha")).find((i) => i.name === "shot.png")!;
    expect(after.id).toBe(before.id);   // a rewrite must not make everything look brand new
    expect(after.at).toBe(before.at);
    expect(after.caption).toBe("new caption"); // …but the caption is updatable
  });

  it("opens ONLY the newly added entries", async () => {
    const opened: string[] = [];
    const fresh = new ImageBridge(root, (_p, i) => opened.push(i.name));
    await setMedia(fresh, proj, [{ path: "shot.png" }]);
    expect(opened).toEqual(["shot.png"]);
    await setMedia(fresh, proj, [{ path: "shot.png" }, { path: "shots/deep.png" }]);
    expect(opened).toEqual(["shot.png", "deep.png"]); // the survivor did not re-open
  });

  it("refuses bad entries individually and keeps the good ones", async () => {
    // Failing all three because the second was a.txt would be the least useful behaviour.
    const fresh = new ImageBridge(root, () => {});
    const r = await setMedia(fresh, proj, [
      { path: "shot.png" },
      { path: "notes.txt" },
      { path: join(root, "beta", "secret.png") },
    ]);
    expect(r.ok).toBe(false);
    expect(await fresh.recent("alpha")).toHaveLength(1);
    expect(r.message).toContain("2 refused");
    expect(r.message).toContain("not a displayable type");
    expect(r.message).toContain("outside this project");
  });

  it("rejects a non-array outright", async () => {
    const fresh = new ImageBridge(root, () => {});
    await listMedia(fresh, proj);
    const r = await writeMedia(fresh, proj, "everything");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("must be an array");
  });

  it("de-duplicates the same file listed twice", async () => {
    const fresh = new ImageBridge(root, () => {});
    await setMedia(fresh, proj, [{ path: "shot.png" }, { path: join(proj, "shot.png") }]);
    expect(await fresh.recent("alpha")).toHaveLength(1);
  });
});

describe("tool registry (v3)", () => {
  it("advertises both tools with a usable schema", async () => {
    const r = (await new ImageBridge(root, () => {}).call({ op: "tools" })) as { ok: boolean; tools: any[] };
    expect(r.ok).toBe(true);
    expect(r.tools.map((t: any) => t.name).sort()).toEqual(["list_media", "write_media"]);
    for (const t of r.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("names what it offers when asked for a tool that doesn't exist", async () => {
    const r = (await new ImageBridge(root, () => {}).call({
      op: "call", name: "explode", cwd: proj, arguments: {},
    })) as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
    expect(r.message).toContain("explode");
    expect(r.message).toContain("list_media");
  });

  it("still accepts v1's `show_image` op: a pre-v3 session cannot read, so it appends", async () => {
    const fresh = new ImageBridge(root, () => {});
    const r = (await fresh.call({ op: "show_image", cwd: proj, path: "shot.png", caption: "legacy" })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    expect((await fresh.recent("alpha"))[0]!.caption).toBe("legacy");
  });
});


/**
 * `resolve()` backs the `/push/<id>/<sub>` route. The sibling-asset case is what makes a pushed
 * HTML page render with its own stylesheet; the escape case is what stops that being a way to
 * read the rest of the disk.
 */
describe("resolve(): the bytes route", () => {
  it("resolves the pushed item itself", async () => {
    const fresh = new ImageBridge(root, () => {});
    await show(fresh, proj, "shot.png", "");
    const id = (await fresh.recent("alpha"))[0]!.id;
    const found = await fresh.resolve(id, "shot.png");
    expect(found?.abs).toBe(join(proj, "shot.png"));
  });

  it("resolves a sibling asset relative to the item's own directory", async () => {
    // A page at shots/page.html asking for style.css must get shots/style.css, this is the
    // reason the route has a subpath at all.
    const fresh = new ImageBridge(root, () => {});
    await writeFile(join(proj, "shots", "page.html"), "<p>hi</p>");
    await writeFile(join(proj, "shots", "style.css"), "p{}");
    await show(fresh, proj, "shots/page.html", "");
    const id = (await fresh.recent("alpha"))[0]!.id;
    expect((await fresh.resolve(id, "style.css"))?.abs).toBe(join(proj, "shots", "style.css"));
  });

  it("refuses a subpath that climbs out of the project", async () => {
    const fresh = new ImageBridge(root, () => {});
    await show(fresh, proj, "shots/deep.png", "");
    const id = (await fresh.recent("alpha"))[0]!.id;
    expect(await fresh.resolve(id, "../../beta/secret.png")).toBeNull();
    expect(await fresh.resolve(id, "../../../etc/passwd")).toBeNull();
  });

  it("returns null for an id it never issued", async () => {
    expect(await new ImageBridge(root, () => {}).resolve("push-nope", "x.png")).toBeNull();
  });
});

/**
 * Reported live: Claude regenerated a file, showed it at the same path, and the
 * screen kept the old picture, so it worked around it by writing to a new filename.
 *
 * The cause is that keeping the id is CORRECT (that is what stops the item jumping to the front
 * of the strip) and is also exactly what breaks it, because the id is the whole URL. Neither
 * `no-store` nor a refetch of the list helps: an `<img>` whose src attribute did not change never
 * requests anything. So the fix has to be visible in the payload, which is what this pins.
 */
describe("a file that changed under an item already on screen", () => {
  /*
   * Every bump stamps its OWN mtime from a counter, not from the clock. Deriving it from
   * `Date.now()` made these tests flaky (~1 run in 6): two bumps that land in the same
   * millisecond produce the same mtime, and "the version changed" then compares a number to
   * itself. A test for a staleness bug must not itself depend on how fast the machine is.
   */
  const EPOCH = 1_780_000_000; // seconds, a fixed, obviously-synthetic base
  let step = 0;
  const bump = async (abs: string, bytes: Buffer | string) => {
    await writeFile(abs, bytes);
    const t = new Date((EPOCH + ++step) * 1000);
    await utimes(abs, t, t);
  };

  it("keeps the item's identity but changes its version, and says so", async () => {
    const changed: (string | null)[] = [];
    const b = new ImageBridge(root, () => {}, undefined, (p) => changed.push(p));
    const abs = join(proj, "regen.png");
    await bump(abs, PNG);

    await show(b, proj, "regen.png", "");
    const first = (await b.recent("alpha"))[0]!;
    expect(first.ver).toBeGreaterThan(0);

    changed.length = 0;
    await bump(abs, Buffer.concat([PNG, Buffer.from("trailing")]));
    await show(b, proj, "regen.png", "");
    const second = (await b.recent("alpha"))[0]!;

    expect(second.id).toBe(first.id); // still the same tile, still in place
    expect(second.at).toBe(first.at); // and it did not pretend to have just arrived
    expect(second.ver).not.toBe(first.ver); // …but the URL the browser builds is now different
    expect(second.size).not.toBe(first.size);
    // Counting rows saw "1 before, 1 after" and stayed silent. The browser was never told.
    expect(changed).toContain("alpha");
  });

  it("reports the file as it is now, even with no push behind the change", async () => {
    const b = new ImageBridge(root, () => {});
    const abs = join(proj, "drifts.png");
    await bump(abs, PNG);
    await show(b, proj, "drifts.png", "");
    const before = (await b.recent("alpha"))[0]!;

    await bump(abs, Buffer.concat([PNG, Buffer.from("more")]));
    const after = (await b.recent("alpha"))[0]!;
    expect(after.ver).not.toBe(before.ver); // a reload must not resurrect the old bytes
  });

  it("leaves the strip alone when nothing actually changed", async () => {
    const changed: (string | null)[] = [];
    const b = new ImageBridge(root, () => {}, undefined, (p) => changed.push(p));
    await show(b, proj, "shot.png", "");
    changed.length = 0;
    await show(b, proj, "shot.png", "");
    expect(changed).toEqual([]); // re-showing an unchanged file is not an event
  });
});
