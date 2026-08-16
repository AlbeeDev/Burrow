/**
 * Scheduled loop broadcast: N independent schedule rows; each row fires one message into
 * its selected chats' live terminal sessions at its own time/days (multi-schedule redesign,
 * replaces the original single-schedule model).
 *
 * Store: ~/.burrow/schedule.json as `{ schedules: ScheduleRow[] }`. A legacy single-object
 * file (the pre-redesign shape) is migrated to one row on read, nothing the owner set is
 * lost. All decision logic (parse/migrate, set-path normalize, due-row selection) is pure
 * and fs-free so it is unit-testable WITHOUT ever arming or firing (see schedule.test.ts).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ScheduleRow = {
  id: string;
  enabled: boolean;
  time: string; // "HH:MM", 24h, SERVER-local time
  days: number[]; // 0=Sun … 6=Sat
  message: string;
  chats: string[]; // project names to broadcast to
  lastFired: string | null; // "YYYY-MM-DD" guard so a row fires at most once per day
};

const ROW_DEFAULTS = {
  enabled: false,
  time: "02:30",
  days: [1, 2, 3, 4, 5],
  message: "/loop work the APPROVED roadmap items",
  chats: [] as string[],
  lastFired: null as string | null,
};

const MAX_ROWS = 50;

function scheduleFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "schedule.json");
}

/** Row ids come from the server so rows stay stable across set round-trips. */
export function newRowId(): string {
  return randomUUID();
}

/**
 * Coerce one untrusted row into a valid ScheduleRow, per-field falling back to defaults.
 * Pure type/validation: PRESERVES the given lastFired (the set-path decides separately
 * whether to keep the stored one; reads must never lose it).
 */
function sanitizeRow(input: unknown): ScheduleRow {
  const i = (input ?? {}) as Record<string, unknown>;
  const id = typeof i.id === "string" && i.id.trim() ? i.id.trim().slice(0, 64): newRowId();
  const time = typeof i.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(i.time) ? i.time: ROW_DEFAULTS.time;
  const days = Array.isArray(i.days)
    ? [...new Set(i.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort(): ROW_DEFAULTS.days;
  const message =
    typeof i.message === "string" && i.message.trim() ? i.message.trim().slice(0, 1000): ROW_DEFAULTS.message;
  const chats = Array.isArray(i.chats)
    ? [...new Set(i.chats.filter((c): c is string => typeof c === "string" && !!c))].slice(0, 200): ROW_DEFAULTS.chats;
  const enabled = typeof i.enabled === "boolean" ? i.enabled: ROW_DEFAULTS.enabled;
  const lastFired = typeof i.lastFired === "string" ? i.lastFired: null;
  return { id, enabled, time, days, message, chats, lastFired };
}

/**
 * Parse raw store JSON into rows. Pure. Handles both shapes:
 *  - current: `{ schedules: [...] }`
 *  - legacy single schedule: `{ enabled, time, days, message, chats, lastFired }` → one row
 *    (fields preserved, including lastFired, so migration can't cause a same-day re-fire).
 * Anything unrecognizable → [].
 */
export function parseStore(parsed: unknown): ScheduleRow[] {
  const p = (parsed ?? {}) as Record<string, unknown>;
  if (Array.isArray(p.schedules)) return p.schedules.slice(0, MAX_ROWS).map(sanitizeRow);
  // Legacy shape: a single object with schedule fields at the top level.
  if (typeof p.time === "string" || Array.isArray(p.chats)) return [sanitizeRow(p)];
  return [];
}

export async function readSchedules(): Promise<ScheduleRow[]> {
  try {
    return parseStore(JSON.parse(await readFile(scheduleFile(), "utf8")));
  } catch {
    return [];
  }
}

export async function writeSchedules(rows: ScheduleRow[]): Promise<void> {
  const file = scheduleFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schedules: rows }, null, 2));
}

/**
 * Validate an untrusted `schedule.set` payload against the PREVIOUS stored rows. Pure.
 * Per row: keep the stored lastFired when the row existed before with the same time;
 * clear it when the time changed (re-arming for a new time can still fire today) or the
 * row is new. The client's own lastFired is always ignored.
 */
export function normalizeRows(input: unknown, prev: ScheduleRow[]): ScheduleRow[] {
  const rows = Array.isArray(input) ? input.slice(0, MAX_ROWS).map(sanitizeRow): [];
  const prevById = new Map(prev.map((r) => [r.id, r]));
  return rows.map((r) => {
    const old = prevById.get(r.id);
    return {...r, lastFired: old && old.time === r.time ? old.lastFired: null };
  });
}

/** "HH:MM" and "YYYY-MM-DD" for a Date, matching the tick's comparison semantics. */
export function fmtHHMM(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}
export function fmtToday(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The rows that should fire at `now`. Pure, the entire once-per-day / time / day-of-week
 * decision, extracted so it is testable without timers, tmux, or the store.
 */
export function dueRows(rows: ScheduleRow[], now: Date): ScheduleRow[] {
  const hhmm = fmtHHMM(now);
  const today = fmtToday(now);
  return rows.filter(
    (r) =>
      r.enabled &&
      r.chats.length > 0 &&
      r.time === hhmm &&
      r.days.includes(now.getDay()) &&
      r.lastFired !== today,
  );
}

/**
 * The chats a row should keep: those still persistent.
 *
 * Trivial as a filter, and extracted anyway because it DELETES saved configuration. Invert the
 * condition and every schedule loses every chat on its next firing, silently, the sort of one-
 * character mistake that has no symptom until a night nothing runs.
 */
export function keptChats(chats: string[], persistent: Set<string>): string[] {
  return chats.filter((c) => persistent.has(c));
}
