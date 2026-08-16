/**
 * Per-session memory + age, as the gateway samples it (server/src/sessionStats.ts).
 *
 * Pure formatting only: the numbers arrive on the `sessions.active` response, which the app
 * already polls. Kept in its own file so the thresholds and the wording live in ONE place: the
 * sidebar chip and the usage panel must never disagree about what counts as a big session.
 */

export type SessionStat = {
  session: string;
  name: string;
  project: string | null;
  rssBytes: number;
  procs: number;
  ageMs: number;
};

/**
 * Where a session stops being ordinary.
 *
 * MEASURED on a real box, not guessed: three real sessions summed 1.31 / 1.37 / 1.55 GB
 * across 13–14 processes each (`claude` itself ~570 MB, the rest a Playwright Chrome and node).
 * The "~300 MB per session" figure in the roadmap describes the `claude` process ALONE and is not
 * what a session costs. The runaway that took the host down reached 6.3 GB.
 *
 * So: 3 GB: about 2× the busiest healthy session observed, and half the known-bad one. A lower
 * bar would light up every row, which is the same as no signal at all.
 */
export const HEAVY_BYTES = 3_000_000_000;

export function isHeavy(rssBytes: number): boolean {
  return rssBytes >= HEAVY_BYTES;
}

/** "812 MB" / "6.3 GB". Decimal units, because that is what every other memory readout here uses. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ", ";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** "4m" / "3h 12m" / "2d 4h": coarse on purpose; nobody needs a session's age to the second. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ", ";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rem = min % 60;
    return rem ? `${hours}h ${rem}m`: `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem ? `${days}d ${rem}h`: `${days}d`;
}
