/**
 * Projects = subfolders of the projects root. Each project's description is read
 * from its CLAUDE.md, so the app and VPS stay in sync with no extra tooling
 * (per the Burrow concept: descriptions come from existing hook files).
 */

import { readdir, readFile, stat, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { inheritOwner } from "./hostUser.js";

export type Project = { name: string; description: string | null };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Claude encodes a project's cwd into its session-folder name: every non-alphanumeric → '-'. */
function claudeSessionDir(absPath: string): string {
  return join(homedir(), ".claude", "projects", absPath.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * Move Claude's session-history folder to the new path, robustly. A plain rename() throws
 * (and, if swallowed, silently strands history) when a stray session folder was recreated at
 * the target during a kill/reopen race: the bug that lost a sandbox's history on a rename
 * round-trip. So we MERGE instead: move each session file into the target, and on a same-id
 * collision keep the LARGER (more complete) file. Never silently drops data; errors propagate.
 */
async function moveSessionHistory(oldDir: string, newDir: string): Promise<void> {
  const src = claudeSessionDir(oldDir);
  const dst = claudeSessionDir(newDir);
  try {
    await stat(src);
  } catch {
    return; // project never opened in Claude, no history to move
  }
  try {
    await rename(src, dst); // fast path: target doesn't exist yet
    return;
  } catch {
    // Target exists (a stray session folder came back), fall through to a per-file merge.
  }
  for (const f of await readdir(src)) {
    const sp = join(src, f);
    const dp = join(dst, f);
    const srcSize = (await stat(sp)).size;
    let dstSize = -1;
    try {
      dstSize = (await stat(dp)).size;
    } catch {
      /* no collision at target */
    }
    if (dstSize >= srcSize) continue; // keep the complete file already at the target
    await rename(sp, dp); // move in (replaces a smaller stray)
  }
  await rm(src, { recursive: true, force: true }); // drop the emptied source folder
}

/** Drop the per-project entry in ~/.claude.json (folder-trust + history pointer). */
async function removeClaudeJsonProject(dir: string): Promise<void> {
  const file = join(homedir(), ".claude.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (data?.projects && Object.prototype.hasOwnProperty.call(data.projects, dir)) {
      delete data.projects[dir];
      await writeFile(file, JSON.stringify(data, null, 2));
    }
  } catch {
    // Malformed/missing ~/.claude.json: nothing to clean.
  }
}

/** Move the per-project entry in ~/.claude.json (folder-trust + history) to the new path. */
async function moveClaudeJsonProject(oldDir: string, newDir: string): Promise<void> {
  const file = join(homedir(), ".claude.json");
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (data?.projects && Object.prototype.hasOwnProperty.call(data.projects, oldDir)) {
      data.projects[newDir] = data.projects[oldDir];
      delete data.projects[oldDir];
      await writeFile(file, JSON.stringify(data, null, 2));
    }
  } catch {
    // Malformed/missing ~/.claude.json: skip; the folder-trust will just re-prompt once.
  }
}

/**
 * Rename a project: the directory, Claude's session-history folder, and Claude's per-project
 * config key. (Group/persistence state, keyed by name, is remapped by the caller.) The dir
 * move preserves inode + contents; the Claude moves preserve chat history + `claude -c`.
 */
export async function renameProject(root: string, oldName: string, newName: string): Promise<Project> {
  const clean = newName.trim();
  if (!NAME_RE.test(clean) || clean.includes("..")) {
    throw new Error("Name must be letters/numbers/._- (no spaces or slashes).");
  }
  if (oldName === clean) return { name: clean, description: null };
  if (oldName.includes("/") || oldName.includes("..") || oldName.startsWith(".")) {
    throw new Error("Invalid project.");
  }
  const oldDir = join(root, oldName);
  const newDir = join(root, clean);
  try {
    if (!(await stat(oldDir)).isDirectory()) throw new Error("not a dir");
  } catch {
    throw new Error("Project not found.");
  }
  let exists = false;
  try {
    await stat(newDir);
    exists = true;
  } catch {
    /* good: target is free */
  }
  if (exists) throw new Error("A project with that name already exists.");

  await rename(oldDir, newDir); // 1. the directory itself
  await moveSessionHistory(oldDir, newDir); // 2. Claude's chat history, merge-safe, never silent
  await moveClaudeJsonProject(oldDir, newDir); // 3. Claude's per-project config
  return { name: clean, description: null };
}

/**
 * Delete a project. The directory is SOFT-deleted, moved to ~/.burrow/trash/<name>.<ts> so a
 * misclick is recoverable. But the Claude-side state (session history, auto-memory, and the
 * ~/.claude.json entry) is purged OUTRIGHT: leaving it caused a same-named project recreated at
 * the same path to re-attach the deleted project's ghost chat + memory. Group / persistence
 * state is cleaned by the caller.
 */
export async function deleteProject(root: string, name: string, stamp: string): Promise<void> {
  if (name.includes("/") || name.includes("..") || name.startsWith(".")) throw new Error("Invalid project.");
  const dir = join(root, name);
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error("not a dir");
  } catch {
    throw new Error("Project not found.");
  }
  const trash = join(process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow"), "trash");
  await mkdir(trash, { recursive: true });
  await rename(dir, join(trash, `${name}.${stamp}`)); // files → trash (recoverable)

  // Purge Claude-side state so a same-named recreate starts fresh (no ghost history/memory).
  await rm(claudeSessionDir(dir), { recursive: true, force: true }); // session.jsonl + memory/
  await removeClaudeJsonProject(dir); // folder-trust + history pointer
}

/**
 * Create a new project = a fresh directory under the root. Optionally seeds a CLAUDE.md
 * with the description so it shows a header and reads as a real Claude project. Rejects
 * unsafe names and existing folders. Throws with a user-facing message on failure.
 */
export async function createProject(
  root: string,
  name: string,
  description?: string,
): Promise<Project> {
  const clean = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clean) || clean.includes("..")) {
    throw new Error("Name must be letters/numbers/._- (no spaces or slashes).");
  }
  const dir = join(root, clean);
  try {
    await mkdir(dir); // non-recursive: fails if it already exists
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A project with that name already exists.");
    throw err;
  }
  // Burrow made this folder as root; the person working in it is not root. Hand it over before
  // anything else touches it, or their first file write fails with EACCES inside their own project.
  await inheritOwner(dir);
  const desc = description?.trim();
  if (desc) {
    const claudeMd = join(dir, "CLAUDE.md");
    await writeFile(claudeMd, `# ${clean}\n\n${desc}\n`);
    await inheritOwner(claudeMd);
  }
  return { name: clean, description: desc || null };
}

/** First meaningful line of a CLAUDE.md, used as the project's chat header. */
async function readDescription(dir: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, "CLAUDE.md"), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.replace(/^#+\s*/, "").trim();
      if (!line) continue;
      if (line.startsWith("<!--")) continue; // HTML comment
      if (line.startsWith("@")) continue; // @import redirect (e.g. @AGENTS.md)
      if (/^(claude|agents)\.md$/i.test(line)) continue; // bare filename reference
      return line.slice(0, 200);
    }
  } catch {
    // No CLAUDE.md, or unreadable: description stays null.
  }
  return null;
}

export async function listProjects(root: string): Promise<Project[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const projects: Project[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    projects.push({ name: entry.name, description: await readDescription(join(root, entry.name)) });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a project name to a directory inside the root, rejecting path traversal. */
export async function resolveProjectCwd(root: string, project: string): Promise<string | null> {
  if (project.includes("/") || project.includes("..") || project.startsWith(".")) return null;
  const dir = join(root, project);
  try {
    return (await stat(dir)).isDirectory() ? dir: null;
  } catch {
    return null;
  }
}
