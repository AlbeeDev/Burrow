/**
 * Who host-exec sessions run as.
 *
 * With BURROW_HOST_EXEC=1 commands run on the host but inherit the container's environment, whose
 * PATH points at directories that are empty on the host. BURROW_HOST_USER fixes that by running
 * sessions through a login shell for that user, so their own profile (nvm, PATH, tools) applies
 * and files they create belong to them. Unset means root with the container environment, the
 * original behaviour.
 */

/** Empty means "stay as root", the default. */
export const HOST_USER = process.env.BURROW_HOST_USER?.trim() || null;

/**
 * Quote arguments for `sh -c`. Single quotes leave no escapes live; a literal single quote is
 * closed, escaped and reopened. Arguments include user-named project paths, so this must be exact.
 */
export function shQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replaceAll("'", `'\\''`)}'`).join(" ");
}

/**
 * Environment variables that survive the login. `su -` clears the environment (that is what makes
 * the user's own PATH apply), but these are values Burrow deliberately hands the child; without
 * the token every turn fails before it starts. Keep the list short: anything not named here should
 * come from the user's profile.
 */
export const PRESERVE = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  // Claude's config/history location, when moved off the default.
  "CLAUDE_CONFIG_DIR",
  // Claude Code refuses bypassPermissions as root unless the environment is marked a sandbox.
  "IS_SANDBOX",
  // Set by the PTY; a login shell cannot know them.
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
];

/**
 * Run a command as HOST_USER through a login shell.
 *
 * `su -` (the dash) is what reads the user's profile. The inner `bash -lic` is still needed
 * because `su -c` runs its command non-interactively; see inLoginShell. `cwd` is applied inside
 * the shell because a login shell starts in the user's home, and `exec` replaces the shell so
 * signals reach the real child (bubble mode interrupts by killing what it spawned).
 */
export function asUser(file: string, args: string[], cwd?: string): { file: string; args: string[] } {
  if (!HOST_USER) return { file, args };
  const inner = `${cwd ? `cd ${shQuote([cwd])} && `: ""}exec ${shQuote([file, ...args])}`;
  const command = `exec bash -lic ${shQuote([inner])}`;
  return { file: "su", args: ["-w", PRESERVE.join(","), "-", HOST_USER, "-c", command] };
}

/**
 * Give a newly created path the same owner as its parent directory. The gateway runs as root, so
 * without this everything it creates in a user's folders is root-owned and their own sessions
 * cannot write there. Parent's owner rather than HOST_USER because it needs no configuration and
 * is what a plain mkdir by that user would have produced. Best-effort: never throws, and doing
 * nothing leaves the old behaviour.
 */
export async function inheritOwner(path: string): Promise<void> {
  try {
    const { chown, stat } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const parent = await stat(dirname(path));
    const self = await stat(path);
    if (self.uid === parent.uid && self.gid === parent.gid) return;
    await chown(path, parent.uid, parent.gid);
  } catch {
    /* not permitted, or gone: leave it as it was */
  }
}

/**
 * Wrap a tmux launch command so it sees what an interactive shell sees. tmux runs a pane's command
 * non-interactively, and Ubuntu's stock .bashrc returns early when non-interactive while nvm
 * appends itself below that guard, so without `-i` the user's PATH never loads and `claude` is not
 * found. Only applied when HOST_USER is set: a root install's PATH already works, and changing
 * which startup files it reads would be a behaviour change for nothing.
 */
export function inLoginShell(command: string): string {
  if (!HOST_USER) return command;
  return `bash -lic ${shQuote([command])}`;
}
