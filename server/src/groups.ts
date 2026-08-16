/**
 * Virtual project groups ("collections"). Projects stay flat and real on disk; a group
 * is just a label. Stored as one JSON file the app reads/writes over the gateway, so
 * grouping never touches the filesystem, project paths, or Claude session continuity.
 *
 * Shape: { groups: string[], assignments: { "<project>": "<group>" } }
 * `groups` is the canonical list (so an empty, freshly-created group persists);
 * `assignments` maps a project to one of those groups. Absence = ungrouped.
 */

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type GroupsConfig = {
  groups: string[];
  assignments: Record<string, string>;
  colors?: Record<string, string>;
  // Which group the external (non-admin) user is restricted to. Follows renames; cleared
};

function groupsFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "groups.json");
}

export async function readGroups(): Promise<GroupsConfig> {
  try {
    const parsed = JSON.parse(await readFile(groupsFile(), "utf8"));
    const assignments =
      parsed?.assignments && typeof parsed.assignments === "object" ? parsed.assignments: {};
    const names = new Set<string>(
      (Array.isArray(parsed?.groups) ? parsed.groups: [])
.filter((g: unknown) => typeof g === "string")
.map((g: string) => g.trim())
.filter(Boolean),
    );
    // Back-compat: ensure any group referenced by an assignment is in the list.
    for (const g of Object.values(assignments)) {
      if (typeof g === "string" && g.trim()) names.add(g.trim());
    }
    const colors: Record<string, string> = {};
    if (parsed?.colors && typeof parsed.colors === "object") {
      for (const [g, c] of Object.entries(parsed.colors)) {
        if (typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c)) colors[g] = c;
      }
    }
    return { groups: [...names], assignments, colors };
  } catch {
    return { groups: [], assignments: {}, colors: {} };
  }
}

export async function writeGroups(config: GroupsConfig): Promise<void> {
  const file = groupsFile();
  await mkdir(dirname(file), { recursive: true });

  const groups = [
...new Set(
      (config.groups ?? [])
.map((g) => String(g).trim())
.filter(Boolean)
.map((g) => g.slice(0, 60)),
    ),
  ].slice(0, 100);
  const allowed = new Set(groups);

  const assignments: Record<string, string> = {};
  for (const [project, group] of Object.entries(config.assignments ?? {})) {
    if (typeof project === "string" && typeof group === "string" && allowed.has(group.trim())) {
      assignments[project] = group.trim();
    }
  }

  const colors: Record<string, string> = {};
  for (const [group, color] of Object.entries(config.colors ?? {})) {
    if (allowed.has(group.trim()) && typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
      colors[group.trim()] = color;
    }
  }
  await writeFile(file, JSON.stringify({ groups, assignments, colors }, null, 2));
}
