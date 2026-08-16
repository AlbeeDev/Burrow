/**
 * Saved split layouts (~/.burrow/splits.json), first-class entities in the sidebar, same
 * store pattern as groups.json.
 *
 * A saved split is ONLY a view config, which projects sit in which panel. It never owns a
 * session: deleting one leaves every terminal running, and the same project may appear in many
 * splits. Server-persisted so a layout is the same on every device.
 *
 * Focus is deliberately NOT stored: a split always opens on its first panel.
 * Remembering it meant a server write on every panel click, which is a lot of disk traffic to
 * preserve something nobody missed. A `focus` field in an older file is simply ignored.
 *
 * Panel encoding is explicit so the three cases stay distinguishable through JSON:
 *   null                  → an empty panel
 *   { project: null }     → the master shell
 *   { project: "burrow" } → that project
 */

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SplitPanel = { project: string | null } | null;
export type SavedSplit = { id: string; name: string; panels: SplitPanel[] };

const MAX_SPLITS = 50;
// Mirrors the client's MAX_PANELS (splitCells.ts): a layout may HOLD 8 panels even though only
// LIVE_MAX of them are attached terminals at a time, the rest are parked. Raised from 4 with the
// multi-panel scroller; if that gets reverted this can go back to 4.
const MAX_PANELS = 8;
const MAX_NAME = 60;

function splitsFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "splits.json");
}

function sanitizePanel(raw: unknown): SplitPanel {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const p = (raw as { project?: unknown }).project;
  if (p === null) return { project: null };
  if (typeof p === "string" && p.trim()) return { project: p.trim() };
  return null;
}

/** One stored entry → a usable split, or null if it's too broken to show. */
function sanitizeSplit(raw: unknown, index: number): SavedSplit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const panels = (Array.isArray(r.panels) ? r.panels: []).slice(0, MAX_PANELS).map(sanitizePanel);
  if (panels.length === 0) return null; // a split with no panels can't be opened
  const id = typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64): `split-${index}`;
  const name =
    typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, MAX_NAME): `Split ${index + 1}`;
  return { id, name, panels }; // a stored `focus` from older versions is dropped here
}

export async function readSplits(): Promise<SavedSplit[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(splitsFile(), "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray((parsed as { splits?: unknown })?.splits)
    ? ((parsed as { splits: unknown[] }).splits): [];
  const out: SavedSplit[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const s = sanitizeSplit(raw, i);
    if (!s || seen.has(s.id)) continue; // duplicate ids would make rename/delete ambiguous
    seen.add(s.id);
    out.push(s);
  }
  return out.slice(0, MAX_SPLITS);
}

export async function writeSplits(splits: unknown): Promise<SavedSplit[]> {
  const list = Array.isArray(splits) ? splits: [];
  const clean: SavedSplit[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const s = sanitizeSplit(raw, i);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    clean.push(s);
    if (clean.length >= MAX_SPLITS) break;
  }
  const file = splitsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ splits: clean }, null, 2));
  return clean;
}
