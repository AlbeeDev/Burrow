/**
 * The usage addon's Settings row.
 *
 * There is no on/off switch, and that is deliberate: installing the provider IS the opt-in. A
 * switch would only let you turn off a badge you went and installed a program to get. So the row
 * reports rather than configures, and the "Check again" button covers the case a switch was really
 * being asked for: you installed it just now and want Burrow to notice.
 *
 * Detection, never configuration: Burrow ships no provider and hardcodes no path. Any executable
 * called `claude-usage` on PATH that prints the documented JSON will do. See USAGE-PROVIDER.md.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import { sessionPct, type UsageResult } from "../lib/usage";
import { AddonRow, type AddonStatus } from "./AddonRow";

/**
 * Opening the usage panel from here.
 *
 * The badge is a small pill in a crowded header, and nothing otherwise connects "I just set this
 * up" to "here is where it lives". A window event rather than lifted state
 * because the badge is rendered several levels away and this is one button.
 */
export const USAGE_OPEN_EVENT = "burrow:open-usage";

export function UsageRow({ onClose }: { onClose: () => void }) {
  const { gateway, status } = useGateway();
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(
    (manual = false) => {
      if (status !== "ready") return;
      if (manual) setChecking(true);
      gateway
.req<UsageResult>("usage.get")
.then(setUsage)
.catch(() => setUsage(null))
.finally(() => manual && setChecking(false));
    },
    [gateway, status],
  );

  useEffect(() => load(), [load]);

  if (!usage) return null;

  const missing = usage.usage.status === "not_configured";
  const pct = sessionPct(usage);
  const state: AddonStatus = missing ? "absent": usage.ok && pct !== null ? "on": "problem";

  return (
    <AddonRow
      title="Plan usage in the header"
      status={state}
      onCheck={() => load(true)}
      checking={checking}
      found={usage.provider ?? null}
      actions={
        state === "on" && (
          <button
            onClick={() => {
              // Close Settings first, then open the panel, so the thing you are being shown is not
              // behind the dialog you were just in.
              onClose();
              window.dispatchEvent(new Event(USAGE_OPEN_EVENT));
            }}
            className="rounded-lg border border-accent bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
          >
            View usage
          </button>
        )
      }
    >
      {missing ? (
        <>
          Burrow can show how much of your Claude plan window is left, if a provider is installed.
          It ships none. Install <code className="text-ink">claude-usage</code> on this machine and
          press refresh.{" "}
          <a
            href="https://github.com/AlbeeDev"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            About <ArrowSquareOut size={11} className="inline" />
          </a>
        </>
      ): state === "on" ? (
        // Says what the addon DOES, like the other two states, rather than repeating a number the
        // header badge and the View usage button are both already showing.
        <>Your plan usage shows in the header, refreshed about once a minute.</>
      ): (
        <>
          A provider is installed but the last read failed (
          <span className="text-ink">{usage.usage.status}</span>). The header shows{" "}
          <span className="text-ink">usage ?</span> rather than a number, because a zero would read
          as headroom.
        </>
      )}
    </AddonRow>
  );
}
