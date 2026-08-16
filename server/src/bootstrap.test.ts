/**
 * First-run config generation.
 *
 * This is the one piece of Burrow that WRITES to the repo on startup, which is the whole reason it
 * is tested. Two failures matter and neither is loud:
 *
 *  - Clobbering an existing `.env` would delete an operator's real settings, including their
 *    admin key and token: on a restart they had no reason to fear.
 *  - Running in a container would generate a file describing defaults that the compose
 *    environment overrides anyway, recreated on every rebuild, telling a confused reader that
 *    settings live somewhere they don't.
 *
 * `bootstrapConfig` takes the environment as an argument precisely so both can be checked without
 * touching `process.env` or the real `server/.env`.
 */
import { afterEach, beforeEach, expect, describe, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bootstrapConfig,
  defaultBashrc,
  defaultProjectsRoot,
  envFilePath,
  renderEnv,
} from "./bootstrap.js";

describe("derived defaults", () => {
  it("point at the running user's home, not at a literal /root", () => {
    expect(defaultProjectsRoot()).toBe(homedir());
    expect(defaultBashrc()).toBe(join(homedir(), ".bashrc"));
  });

  it("still resolve to the old hardcoded values when running as root", () => {
    // The compatibility claim in the commit message, asserted rather than assumed. Skips on a
    // developer machine, where it says nothing.
    if (homedir() !== "/root") return;
    expect(defaultProjectsRoot()).toBe("/root");
    expect(defaultBashrc()).toBe("/root/.bashrc");
  });
});

describe("renderEnv()", () => {
  it("writes the projects root as a real, editable line", () => {
    const out = renderEnv("/home/alice/dev");
    expect(out).toContain("BURROW_PROJECTS_ROOT=/home/alice/dev");
  });

  it("leaves the security-relevant settings commented out", () => {
    const out = renderEnv("/home/alice");
    // A generated file that quietly enabled a public bind would be a trap.
    expect(out).toContain("# BURROW_TOKEN=");
    expect(out).toContain("BURROW_BIND=127.0.0.1");
  });
});

describe("bootstrapConfig()", () => {
  it("does nothing when the environment is already configured", () => {
    // The container case: compose supplies everything, so there is nothing to bootstrap.
    for (const key of ["BURROW_PROJECTS_ROOT", "BURROW_BIND", "BURROW_PORT", "BURROW_DATA_DIR"]) {
      expect(bootstrapConfig({ [key]: "something" }), key).toEqual({ action: "skipped", reason: "env" });
    }
  });

  /*
   * Everything below can WRITE `server/.env`, so it all has to sit inside the backup/restore.
   * The blank-value case caught me out first time round: it isn't "skipped", so it falls straight
   * through to the write, and sitting outside this block it left a generated file behind in the
   * working tree. A test for a function whose job is writing files has to clean up after itself.
   */
  describe("against the real env path", () => {
    const path = envFilePath();
    let backup: string | null = null;

    beforeEach(() => {
      backup = existsSync(path) ? readFileSync(path, "utf8"): null;
    });
    afterEach(() => {
      if (backup === null) rmSync(path, { force: true });
      else writeFileSync(path, backup);
    });

    it("treats a blank environment value as unconfigured", () => {
      // `BURROW_PROJECTS_ROOT=` in a compose file is not a configuration, it is an empty slot.
      expect(bootstrapConfig({ BURROW_PROJECTS_ROOT: "   " }).action).not.toBe("skipped");
    });

    it("keeps an existing file exactly as it was", () => {
      const mine = "BURROW_PORT=9999\nMY_CUSTOM_SETTING=do-not-lose-me\n";
      writeFileSync(path, mine);
      expect(bootstrapConfig({})).toEqual({ action: "kept", path });
      expect(readFileSync(path, "utf8")).toBe(mine); // untouched, byte for byte
    });

    it("writes one when there is none", () => {
      rmSync(path, { force: true });
      const r = bootstrapConfig({});
      expect(r.action).toBe("written");
      expect(readFileSync(path, "utf8")).toContain(`BURROW_PROJECTS_ROOT=${homedir()}`);
    });

    it("is idempotent: a second start keeps the first file", () => {
      rmSync(path, { force: true });
      expect(bootstrapConfig({}).action).toBe("written");
      expect(bootstrapConfig({}).action).toBe("kept");
    });
  });

});
