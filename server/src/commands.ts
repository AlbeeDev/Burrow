/**
 * Lists the slash commands available for a project, so the composer can autocomplete them.
 *
 * Two sources, because neither is complete on its own (measured against a live CLI):
 *
 * - Disk, scanned here: `.claude/commands/*.md` AND `.claude/skills/<name>/SKILL.md`, from
 *   both the project and the user config dir. Skills are invoked as slash commands exactly like
 *   commands are: scanning only `commands/` was showing 1 of this box's 8 user-level entries.
 *   (Top-level → /name, one subdir deep → /dir:name, matching Claude Code.)
 * - The CLI itself: the `system/init` frame of a bubble turn carries `slash_commands`, the
 *   authoritative list for headless mode: built-ins (`/compact`, `/context`, `/model`, …) and
 *   plugin commands included. `mergeKnown()` folds those in. It is only known once a session has
 *   produced an init frame, which is why the disk scan stays: it is what the palette has to work
 *   with before the first turn.
 */

import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** `session` = the CLI declared it in its init frame and no file of ours explains it. */
export type CommandScope = "project" | "user" | "skill" | "session";
export type SlashCommand = { name: string; description: string | null; scope: CommandScope };

async function parseDescription(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const body = fm?.[1];
    if (body) {
      const d = /(?:^|\n)description:\s*(.+)/.exec(body);
      const val = d?.[1];
      if (val) return val.trim().slice(0, 120);
    }
    const rest = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
    for (const line of rest.split("\n")) {
      const t = line.trim().replace(/^#+\s*/, "");
      if (t) return t.slice(0, 120);
    }
  } catch {
    /* unreadable: no description */
  }
  return null;
}

/**
 * `<base>/skills/<name>/SKILL.md` → `/name`. The directory name is what the CLI dispatches on;
 * the frontmatter `description` is what makes the palette entry worth reading.
 */
async function scanSkills(base: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(base, entry.name, "SKILL.md");
    const description = await parseDescription(file);
    if (description === null && !(await exists(file))) continue; // a dir without a SKILL.md
    out.push({ name: entry.name, description, scope: "skill" });
  }
  return out;
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function scanDir(base: string, scope: "project" | "user"): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push({
        name: entry.name.slice(0, -3),
        description: await parseDescription(join(base, entry.name)),
        scope,
      });
    } else if (entry.isDirectory()) {
      let sub;
      try {
        sub = await readdir(join(base, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of sub) {
        if (f.isFile() && f.name.endsWith(".md")) {
          out.push({
            name: `${entry.name}:${f.name.slice(0, -3)}`,
            description: await parseDescription(join(base, entry.name, f.name)),
            scope,
          });
        }
      }
    }
  }
  return out;
}

export async function listCommands(cwd: string): Promise<SlashCommand[]> {
  const configBase = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const [project, user, projectSkills, userSkills] = await Promise.all([
    scanDir(join(cwd, ".claude", "commands"), "project"),
    scanDir(join(configBase, "commands"), "user"),
    scanSkills(join(cwd, ".claude", "skills")),
    scanSkills(join(configBase, "skills")),
  ]);
  // Project beats user beats skill on a name collision, the same precedence the CLI applies.
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of [...project, ...user, ...projectSkills, ...userSkills]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold the CLI's own `slash_commands` list into the scanned one. Anything we found on disk keeps
 * its description and scope; anything only the CLI knows about (built-ins, plugin commands) is
 * added bare. Pure: the whole reason this is separate from the scan.
 */
export function mergeKnown(scanned: SlashCommand[], known: readonly string[]): SlashCommand[] {
  const seen = new Set(scanned.map((c) => c.name));
  const extra: SlashCommand[] = [];
  for (const name of known) {
    // Internal plumbing the CLI exposes but a person never types.
    if (!name || name.startsWith("__") || seen.has(name)) continue;
    seen.add(name);
    extra.push({ name, description: null, scope: "session" });
  }
  return [...scanned, ...extra].sort((a, b) => a.name.localeCompare(b.name));
}
