/**
 * Per-project terminal persistence preference.
 *
 * A project marked persistent keeps its tmux session (and whatever runs inside, a live
 * `claude -c`) alive when you leave it or the browser disconnects: the PTY detaches but
 * the session stays. An unmarked project is ephemeral, its session is killed on the way
 * out (`tmux kill-session`), so browsing between projects doesn't leak a Claude process
 * per project. Default is OFF; persistence is opt-in.
 *
 * Stored as one JSON file alongside groups.json, so it never touches project state.
 * Shape: { persistent: string[] }: the project names opted into persistence.
 */

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function persistenceFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "persistence.json");
}

export async function readPersistent(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(persistenceFile(), "utf8"));
    const list = Array.isArray(parsed?.persistent) ? parsed.persistent: [];
    return new Set(list.filter((p: unknown): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

/** Master (null project) is always ephemeral, a throwaway root shell, never opted in. */
export async function isPersistent(project: string | null): Promise<boolean> {
  if (!project) return false;
  return (await readPersistent()).has(project);
}

export async function setPersistent(project: string, value: boolean): Promise<void> {
  const set = await readPersistent();
  if (value) set.add(project);
  else set.delete(project);
  const file = persistenceFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ persistent: [...set].slice(0, 500) }, null, 2));
}
