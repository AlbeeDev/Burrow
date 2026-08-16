/**
 * Plan-usage shapes and the two display rules worth getting right, kept pure so they can be
 * checked without a browser. Mirrors `server/src/usage.ts`.
 *
 * The rule that matters, straight from the provider contract (USAGE-PROVIDER.md): a failed read must
 * read as "unknown", NEVER as a number. A 0% bar looks like plenty of headroom, which is the
 * opposite of what a failure means.
 */

export type UsageBlock = { kind: string; percent: number; scope?: string };

export type Usage = {
  status: string;
  session_pct?: number;
  session_resets_at?: string;
  weekly_pct?: number;
  weekly_resets_at?: string;
  blocking?: UsageBlock[];
  credits_enabled?: boolean;
  // null, not absent, when the account has no limit set, the live script really sends that.
  credits_spent?: number | null;
  credits_limit?: number | null;
};

export type UsageResult = { ok: boolean; usage: Usage; at: number; cached: boolean; provider?: string | null };

/** The percentage the bar should show, or null when there is nothing trustworthy to show. */
export function sessionPct(r: UsageResult | null): number | null {
  if (!r || !r.ok) return null;
  const raw = r.usage.session_pct;
  if (typeof raw !== "number" || Number.isNaN(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * How alarming the bar is: the session percentage, full stop.
 *
 * Bands: 0–75 fine, 75–90 warn, 90+ danger. A `blocking` entry used to
 * force danger, which is why the bar sat red at 9% used: one model capped for the week says
 * nothing about the session you are in. Blocks stay visible (a marker on the badge, a line in the
 * panel) but they no longer colour anything.
 */
export function usageLevel(r: UsageResult | null): "ok" | "warn" | "danger" | "unknown" {
  const pct = sessionPct(r);
  if (pct === null) return "unknown";
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warn";
  return "ok";
}

/** The weekly window, same clamping as the session one. */
export function weeklyPct(r: UsageResult | null): number | null {
  if (!r || !r.ok) return null;
  const raw = r.usage.weekly_pct;
  if (typeof raw !== "number" || Number.isNaN(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function blocks(r: UsageResult | null): UsageBlock[] {
  return r?.ok ? (r.usage.blocking ?? []): [];
}

/**
 * A reset timestamp, legible at a glance: how long you have to wait first, the wall-clock time
 * second. Raw `toLocaleString` output was the complaint, "Aug 1, 07:00" makes you do arithmetic.
 * Returns null for a missing or unparseable value so callers render a dash rather than "Invalid
 * Date".
 */
export function fmtReset(iso: string | undefined, now = Date.now()): { in: string; at: string } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.round((t - now) / 60_000);
  const at = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (mins <= 0) return { in: "any moment", at };
  if (mins < 60) return { in: `in ${mins}m`, at };
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return { in: m ? `in ${h}h ${m}m`: `in ${h}h`, at };
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return { in: rh ? `in ${d}d ${rh}h`: `in ${d}d`, at: new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) };
}

/**
 * The credits line. Remaining is the useful number when a limit exists, but the live
 * script sends `credits_limit: null` when no limit is set, and there is nothing to count down
 * from, so that case says what it has instead of pretending. Returns null when there are no
 * credits at all.
 */
export function credits(u: Usage): { label: string; value: string; sub: string } | null {
  const spent = u.credits_spent;
  if (typeof spent !== "number") return null;
  const off = u.credits_enabled === false ? " · credits off": "";
  if (typeof u.credits_limit === "number") {
    const left = Math.max(0, u.credits_limit - spent);
    return {
      label: "Credits left",
      value: `$${left.toFixed(2)}`,
      sub: `$${spent.toFixed(2)} of $${u.credits_limit.toFixed(2)} used${off}`,
    };
  }
  return {
    label: "Credits used",
    value: `$${spent.toFixed(2)}`,
    sub: `no limit set: nothing to count down from${off}`,
  };
}
