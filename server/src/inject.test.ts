/**
 * Delivery detection for injected messages.
 *
 * Real stakes, and they were paid once already: before this existed, `sendKeys` pressed Enter and
 * reported success, so a message swallowed by a pane in copy-mode was indistinguishable in the log
 * from one Claude answered. A false success here means a scheduled message is silently lost; a
 * false failure means a delivered message gets typed a second time.
 */
import { describe, expect, it } from "vitest";
import { composerHolds, looksReady } from "./inject.js";

/** A Claude pane: transcript above, composer marker, footer. */
function pane(transcript: string[], composer: string): string {
  return [
...transcript,
    "─".repeat(60),
    `❯ ${composer}`,
    "─".repeat(60),
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
}

const MSG = "/loop 30m keep working on the auction project";

describe("composerHolds", () => {
  it("sees a message still waiting in the composer", () => {
    expect(composerHolds(pane(["● earlier reply"], MSG), MSG)).toBe(true);
  });

  it("does not mistake an echoed message for an unsent one", () => {
    // The trap this function exists for: a SUBMITTED message is echoed back into the transcript,
    // so "the text is on screen" proves nothing. Above the composer means sent.
    expect(composerHolds(pane([`> ${MSG}`, "● working on it"], ""), MSG)).toBe(false);
  });

  it("treats a shell prompt as a failure to deliver", () => {
    // No composer marker at all: `exec bash` took over when Claude exited, so the message was run
    // as a shell command. Something plainly happened, and it was not a delivery.
    const shell = ["alice@box:~/p$ /loop 30m keep working on the auction project", "bash: /loop: No such file or directory", "alice@box:~/p$ "].join("\n");
    expect(composerHolds(shell, MSG)).toBe(true);
  });

  it("answers false for an empty probe rather than matching everything", () => {
    // "" is a substring of any string, so a careless implementation reports every send as stuck
    // and then types the message twice.
    expect(composerHolds(pane([], ""), "")).toBe(false);
    expect(composerHolds(pane([], ""), "   ")).toBe(false);
  });

  it("uses the LAST composer, not an arrow somewhere in the transcript", () => {
    expect(composerHolds(pane(["❯ an older prompt line", `> ${MSG}`, "● done"], ""), MSG)).toBe(false);
  });
});

describe("looksReady", () => {
  it("accepts both of Claude's footers", () => {
    expect(looksReady("  ⏵⏵ bypass permissions on (shift+tab to cycle)")).toBe(true);
    expect(looksReady("  ? for shortcuts")).toBe(true);
  });

  it("rejects everything else, which is the point", () => {
    // Narrow on purpose: a shell, a login screen or a scrolled-back pane must all read as not
    // ready, so the caller skips instead of typing into the dark.
    for (const not of ["alice@box:~$ ", "Welcome to Claude Code, /login to continue", "", "some scrolled transcript text"]) {
      expect(looksReady(not)).toBe(false);
    }
  });
});
