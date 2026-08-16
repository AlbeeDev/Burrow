/**
 * Pre-accepts Claude Code's one-time "trust this folder?" dialog for a project, so an
 * auto-launched `claude` in the terminal goes straight to the chat instead of stopping
 * at the trust prompt. Marks only the given project (and only if not already trusted)
 * in ~/.claude.json: the same file/flag the interactive CLI uses.
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function ensureTrusted(cwd: string): void {
  const file = join(homedir(), ".claude.json");
  try {
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.projects ??= {};
    const entry = (config.projects[cwd] ??= {});
    if (entry.hasTrustDialogAccepted === true) return; // already trusted, no write
    entry.hasTrustDialogAccepted = true;
    writeFileSync(file, JSON.stringify(config, null, 2));
  } catch {
    // If the config can't be read/written, fall back to the interactive trust prompt.
  }
}
