/**
 * The shared shape for an addon's Settings row.
 *
 * Why this exists: *"visually i see no difference between the tailscale and
 * claude usage addons turned off or on"*. Both rows were written as explanations, with the state
 * carried entirely by a sentence you had to read. That is fine for a document and wrong for
 * Settings, which is a surface you SCAN: you open it to check something, not to read paragraphs.
 *
 * There was a second problem underneath: the two rows had no shared vocabulary. Tailscale has five
 * internal states and usage has three, each describing itself in its own words, so nothing told you
 * they were the same kind of thing. Every addon now maps its own states onto the five below, and
 * "have I set this up?" becomes a colour rather than a paragraph.
 *
 * The structure is identical whether or not an addon has an action, which also settles the
 * asymmetry between a row with a button and a row without: they are the same row, one of them
 * simply has nothing to do.
 */
import type { ReactNode } from "react";
import { CircleNotch } from "@phosphor-icons/react";

/** The shared vocabulary. Anything an addon can be, in five words. */
export type AddonStatus = "absent" | "setup" | "off" | "on" | "problem";

const LOOK: Record<AddonStatus, { label: string; dot: string; text: string }> = {
  absent: { label: "Not installed", dot: "bg-faint", text: "text-faint" },
  setup: { label: "Needs setup", dot: "bg-[#e0a94b]", text: "text-[#e0a94b]" },
  off: { label: "Off", dot: "bg-muted", text: "text-muted" },
  on: { label: "On", dot: "bg-accent", text: "text-accent" },
  problem: { label: "Problem", dot: "bg-danger", text: "text-danger" },
};

export function AddonRow({
  title,
  status,
  statusLabel,
  children,
  onCheck,
  checking,
  found,
  actions,
}: {
  title: string;
  status: AddonStatus;
  /** Overrides the default word, for a state that deserves a more specific one. */
  statusLabel?: string;
  children: ReactNode;
  /**
   * Re-run detection. Worth having because detection is a `command -v` at request time, so
   * installing something while Burrow is running and pressing this picks it up immediately, 
   * no restart, which is the question everybody asks.
   */
  onCheck?: () => void;
  checking?: boolean;
  /**
   * What the last check actually saw, usually a path. Shown after pressing the button.
   *
   * Without it the button was unfalsifiable: if nothing had changed, pressing it re-rendered
   * an identical row, so you could not tell whether it had checked, failed, or done nothing at
   * all. A check has to report its finding, including when the finding is "nothing".
   */
  found?: string | null;
  actions?: ReactNode;
}) {
  // Falls back rather than indexing blind. An unexpected status used to read `undefined.dot` and
  // take the WHOLE APP down from a Settings row, found when the offline rig answered the state
  // call with `{}`. A row that cannot describe itself should still render.
  const look = LOOK[status] ?? LOOK.absent;
  return (
    <div className="rounded-xl border border-line bg-bg px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${look.dot}`} />
            <span className="text-sm text-muted">{title}</span>
            <span className={`text-[11px] font-medium uppercase tracking-wide ${look.text}`}>
              {statusLabel ?? look.label}
            </span>
          </div>
          <div className="mt-1 text-xs text-faint">{children}</div>
        </div>
        {onCheck && (
          <button
            onClick={onCheck}
            disabled={checking}
            className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-40"
          >
            {checking && <CircleNotch size={12} className="animate-spin" />}
            {checking ? "Checking": "Check again"}
          </button>
        )}
      </div>

      {/* The check's finding, in the machine's own words. `null` is a finding too. */}
      {found !== undefined && !checking && (
        <p className="mt-1.5 font-mono text-[11px] text-faint">
          {found ? `found at ${found}`: "nothing found on PATH"}
        </p>
      )}
      {actions && <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
