/**
 * Host-user wrapping.
 *
 * Real stakes on both sides. The command built here is handed to a shell, so a path containing a
 * quote or a space is either escaped correctly or it is an injection, and these strings are
 * project paths, which people name. And the wrapper decides whether a session finds `claude` at
 * all: get the login shell or the working directory wrong and every session starts in the wrong
 * place, or fails outright with `command not found`.
 *
 * `HOST_USER` is read once at import, so these exercise `shQuote` plus the shape `asUser` produces.
 * The unset path: the default, and the author's own instance, is what the suite runs under, so it
 * is pinned here as the thing that must never change by accident.
 */
import { describe, expect, it } from "vitest";
import { asUser, shQuote, inheritOwner, HOST_USER, PRESERVE } from "./hostUser.js";

describe("shQuote", () => {
  it("quotes every argument, so a space in a path is one argument", () => {
    expect(shQuote(["tmux", "-c", "/home/a/My Projects"])).toBe("'tmux' '-c' '/home/a/My Projects'");
  });

  it("survives a single quote in a path", () => {
    // The one character single-quoting cannot contain. Close, escape, reopen, anything else here
    // ends the quoted string early and hands the rest of a project name to the shell as code.
    expect(shQuote(["/home/a/alice's code"])).toBe(`'/home/a/alice'\\''s code'`);
  });

  it("leaves shell metacharacters inert", () => {
    for (const nasty of ["a; rm -rf /", "$(whoami)", "`id`", "a && b", "x|y"]) {
      const out = shQuote([nasty]);
      expect(out.startsWith("'")).toBe(true);
      expect(out.endsWith("'")).toBe(true);
      // Nothing outside the quotes to be interpreted: the only unquoted quote-marks are the pair.
      expect(out.slice(1, -1).includes("'")).toBe(false);
    }
  });
});

describe("asUser", () => {
  it("is a no-op when no user is configured", () => {
    // The default, and the whole reason an existing install cannot be affected by this file.
    expect(HOST_USER).toBeNull();
    expect(asUser("tmux", ["-L", "burrow", "new-session"])).toEqual({
      file: "tmux",
      args: ["-L", "burrow", "new-session"],
    });
  });
});

describe("PRESERVE", () => {
  it("carries the auth token across the login", () => {
    // The bug the first harness run under `su` found: a login shell clears the environment, so the
    // token vanished and every turn errored before it began. Nothing else in the suite would catch
    // that: it only shows up against a real Claude process.
    expect(PRESERVE).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("stays short, because everything else should come from the user's profile", () => {
    // A whitelist that grows into "keep the environment" defeats the point of logging in at all.
    expect(PRESERVE.length).toBeLessThan(12);
  });
});

describe("inheritOwner", () => {
  it("never throws, whatever it is pointed at", async () => {
    // The contract that matters more than the chown itself: this runs inside project creation and
    // file upload, and a filesystem with no opinion about ownership, or a path that vanished, must
    // not turn into a failed project. Doing nothing leaves exactly the old behaviour.
    await expect(inheritOwner("/definitely/not/a/real/path")).resolves.toBeUndefined();
    await expect(inheritOwner("/tmp")).resolves.toBeUndefined();
  });
});
