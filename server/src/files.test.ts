/**
 * boundPath() containment suite: the one guard between the file bridge and the rest of
 * the filesystem (see CLAUDE.md "Tests"). Every case runs against a real temp directory
 * tree, symlinks included, because the guard's symlink logic is realpath-based.
 *
 * Layout built per test run:
 *   <tmp>/root/            the project cwd (containment boundary)
 *   <tmp>/root/sub/a.txt   a real file inside
 *   <tmp>/outside/secret   a real file outside
 *   <tmp>/root/esc         symlink -> <tmp>/outside        (escape via symlink)
 *   <tmp>/root/loop        symlink -> <tmp>/root/sub       (benign internal symlink)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { boundPath, parseRange, serveBounded } from "./files.js";

let tmp: string;
let root: string;

const within = (p: string) => p === root || p.startsWith(root + sep);

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), "boundpath-")));
  root = join(tmp, "root");
  await mkdir(join(root, "sub"), { recursive: true });
  await mkdir(join(tmp, "outside"), { recursive: true });
  await writeFile(join(root, "sub", "a.txt"), "inside");
  await writeFile(join(tmp, "outside", "secret"), "outside");
  await symlink(join(tmp, "outside"), join(root, "esc"));
  await symlink(join(root, "sub"), join(root, "loop"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("boundPath containment", () => {
  it("resolves a valid relative path inside the root", async () => {
    const p = await boundPath(root, "sub/a.txt");
    expect(p).toBe(join(root, "sub", "a.txt"));
  });

  it("empty path resolves to the root itself", async () => {
    expect(await boundPath(root, "")).toBe(root);
  });

  it("rejects plain traversal", async () => {
    expect(await boundPath(root, "../outside/secret")).toBeNull();
  });

  it("rejects traversal buried mid-path", async () => {
    expect(await boundPath(root, "sub/../../outside/secret")).toBeNull();
  });

  it("rejects backslash traversal (windows-style separators are normalized)", async () => {
    expect(await boundPath(root, "..\\outside\\secret")).toBeNull();
  });

  it("strips leading slashes: an absolute path cannot escape, it re-roots inside", async () => {
    const p = await boundPath(root, "/etc/passwd");
    expect(p).toBe(join(root, "etc", "passwd")); // fresh path INSIDE root, not the real /etc
    expect(p === null || within(p)).toBe(true);
  });

  it("rejects escape through a symlink pointing outside the root", async () => {
    expect(await boundPath(root, "esc/secret")).toBeNull();
  });

  it("allows a symlink that stays inside the root", async () => {
    const p = await boundPath(root, "loop/a.txt");
    expect(p).not.toBeNull();
  });

  it("allows a fresh (not-yet-existing) path inside the root", async () => {
    const p = await boundPath(root, "new/deep/file.txt");
    expect(p).toBe(join(root, "new", "deep", "file.txt"));
  });

  it("returns null when the cwd itself does not exist", async () => {
    expect(await boundPath(join(tmp, "nope"), "a.txt")).toBeNull();
  });

  it("never returns a path outside the root (property sweep)", async () => {
    const attempts = [
      "..",
      "../",
      "../../../../etc/passwd",
      "sub/../..",
      "./../outside",
      "esc",
      "esc/",
      "esc/../../outside/secret",
      "//etc//passwd",
      "..\\..",
      "sub/./../../outside/secret",
    ];
    for (const rel of attempts) {
      const p = await boundPath(root, rel);
      // Either rejected outright, or resolved to something still inside the root.
      expect(p === null || within(p), `escaped via: ${rel} -> ${p}`).toBe(true);
      // And specifically: nothing may resolve into the real outside dir.
      if (p !== null) {
        expect((await realpath(p).catch(() => p)).startsWith(join(tmp, "outside"))).toBe(false);
      }
    }
  });
});

/**
 * Range parsing. This is what makes a pushed video seekable and lets a PDF viewer read the file's
 * index off the end without pulling the whole thing, and it is the reason media moved off the
 * WebSocket. Getting "unsatisfiable" wrong is the interesting failure: answering 200 with the
 * whole file to a request for bytes that don't exist makes a player silently misbehave rather
 * than report an error.
 */
describe("parseRange", () => {
  it("ignores an absent or unparseable header, send the whole file", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("items=0-5", 100)).toBeNull();
    expect(parseRange("bytes=", 100)).toBeNull();
  });

  it("reads a closed range", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  });

  it("reads an open-ended range as 'to the end'", () => {
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  });

  it("clamps an end past the file rather than rejecting it", () => {
    expect(parseRange("bytes=90-999", 100)).toEqual({ start: 90, end: 99 });
  });

  it("reads the suffix form: the last N bytes, which is how PDF viewers start", () => {
    expect(parseRange("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
  });

  it("treats a suffix longer than the file as the whole file, not an error", () => {
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("calls a start past the end unsatisfiable (416, never 200)", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=200-300", 100)).toBe("unsatisfiable");
  });

  it("calls a backwards range unsatisfiable", () => {
    expect(parseRange("bytes=50-10", 100)).toBe("unsatisfiable");
  });

  it("cannot satisfy any range on an empty file", () => {
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });
});

describe("serveBounded extra headers", () => {
  // The CSP guard on pushed HTML (finding 6): a sandboxed page must not be able to open a
  // WebSocket back to the gateway. connect-src 'none' is what enforces that; if this header
  // stops being sent, the sandbox alone does NOT close network egress and the hole reopens.
  it("emits the headers the caller asks for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-"));
    const file = join(dir, "page.html");
    await writeFile(file, "<h1>hi</h1>");
    const headers: Record<string, string> = {};
    const res = {
      writeHead(_code: number, h: Record<string, string>) {
        Object.assign(headers, h);
        return this;
      },
      end() {},
      on() {},
      once() {},
      emit() {},
    } as unknown as import("node:http").ServerResponse;
    await serveBounded(file, { method: "HEAD" } as import("node:http").IncomingMessage, res, {
      inline: true,
      mime: "text/html; charset=utf-8",
      extraHeaders: { "content-security-policy": "connect-src 'none'", "x-content-type-options": "nosniff" },
    });
    expect(headers["content-security-policy"]).toBe("connect-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    await rm(dir, { recursive: true, force: true });
  });
});
