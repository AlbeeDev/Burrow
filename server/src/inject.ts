/**
 * Did an injected message actually go in?
 *
 * Split out and tested because it decides whether the scheduler reports truth: without it,
 * `sendKeys` pressed Enter and reported success, so a message swallowed by a pane in copy-mode
 * was indistinguishable in the log from one that was delivered.
 */

/** Claude's composer prompt. The TUI draws this at the start of the input line. */
const COMPOSER = "❯";

/**
 * Is `probe` still sitting in the composer, rather than having been submitted?
 *
 * "The text is on screen" proves nothing: a submitted message is echoed back into the transcript.
 * What separates the cases is position: above the composer marker it was sent, at or after it, it
 * is still waiting. With no composer marker the pane is not Claude (most likely the shell that
 * `exec bash` leaves behind), and text near the bottom means the message was run as a shell
 * command; both readings answer true, and both are delivery failures.
 */
export function composerHolds(pane: string, probe: string): boolean {
  const needle = probe.trim();
  if (!needle) return false;
  const lines = pane.split("\n");
  let composerAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.includes(COMPOSER)) {
      composerAt = i;
      break;
    }
  }
  // No composer: judge on the tail, where a shell would have echoed the command.
  const region = composerAt === -1 ? lines.slice(-8): lines.slice(composerAt);
  return region.join("\n").includes(needle);
}

/**
 * Ready markers for Claude's input prompt: the TUI's footer, in either permission mode. Narrow on
 * purpose: a login screen, a trust prompt, an error, a scrolled pane or a shell match none of
 * them, so the caller skips instead of typing blind.
 */
export function looksReady(pane: string): boolean {
  return /\? for shortcuts|bypass permissions on/i.test(pane);
}
