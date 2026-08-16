import { useState } from "react";
import { createPortal } from "react-dom";
import { X, GearSix, Skull, CaretRight } from "@phosphor-icons/react";
import { ShortcutsModal } from "./ShortcutsModal";
import { useGateway } from "../lib/useGateway";
import { THEMES, applyTheme, currentTheme } from "../lib/theme";
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, setTermFontSize, termFontSize } from "../lib/termFont";
import { keyLabel, SHORTCUTS } from "../lib/shortcuts";
import { TailscaleRow } from "./TailscaleRow";
import { UsageRow } from "./UsageRow";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The entry point, not the list. One row that says how many there are and opens the modal, the
 * full list lived here until it grew past the fold. The count comes off the array, so it can't go stale either.
 */
function ShortcutsEntry({ onOpen }: { onOpen: () => void }) {
  const gestures = SHORTCUTS.filter((s) => s.kind === "gesture").length;
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-bg px-3 py-2.5 text-left transition-colors hover:border-accent/50"
    >
      <span className="min-w-0">
        <span className="block text-sm text-muted">Keyboard shortcuts and gestures</span>
        <span className="mt-0.5 block text-xs text-faint">
          {SHORTCUTS.length - gestures} bindings · {gestures} gestures
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-faint">
        <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink">
          {keyLabel("?")}
        </kbd>
        <CaretRight size={14} weight="bold" />
      </span>
    </button>
  );
}

/**
 * Settings panel: gear in the rail. Per-browser preferences (theme, terminal font,
 * default model), the keyboard shortcuts, the danger zone, and build info.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { gateway, status, activeSessions, masterActive } = useGateway();

  const [theme, setTheme] = useState(currentTheme());
  const [font, setFont] = useState(termFontSize());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [killed, setKilled] = useState<number | null>(null);

  function bumpFont(delta: number) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, font + delta));
    setFont(next);
    setTermFontSize(next);
  }

  function killAll() {
    setConfirmKill(false);
    gateway
.req<{ killed: number }>("sessions.kill_all")
.then((r) => setKilled(r.killed ?? 0))
.catch(() => setKilled(0));
  }

  const liveCount = activeSessions.size + (masterActive ? 1: 0);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <GearSix size={18} weight="fill" className="text-accent" />
            <h2 className="text-base font-semibold text-ink">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <Section title="Theme">
            <div className="flex gap-2">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    applyTheme(t.id);
                    setTheme(t.id);
                  }}
                  aria-label={`Theme: ${t.label}`}
                  className={`flex flex-1 flex-col items-center gap-1.5 rounded-xl border p-2.5 transition-colors ${
                    theme === t.id ? "border-accent": "border-line hover:border-accent/40"
                  }`}
                  style={{ background: t.swatch[0] }}
                >
                  <span className="size-4 rounded-full" style={{ background: t.swatch[2] }} />
                  <span className="text-[11px] font-medium" style={{ color: t.swatch[2] }}>
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Terminal">
            <div className="flex items-center justify-between rounded-xl border border-line bg-bg px-3 py-2.5">
              <span className="text-sm text-muted">Font size</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => bumpFont(-1)}
                  disabled={font <= FONT_MIN}
                  className="grid size-7 place-items-center rounded-md border border-line text-muted hover:text-ink disabled:opacity-30"
                  aria-label="Smaller font"
                >
                  −
                </button>
                <span className="w-8 text-center font-mono text-sm text-ink">{font}</span>
                <button
                  onClick={() => bumpFont(1)}
                  disabled={font >= FONT_MAX}
                  className="grid size-7 place-items-center rounded-md border border-line text-muted hover:text-ink disabled:opacity-30"
                  aria-label="Larger font"
                >
                  +
                </button>
                {font !== FONT_DEFAULT && (
                  <button onClick={() => bumpFont(FONT_DEFAULT - font)} className="text-xs text-faint underline hover:text-muted">
                    reset
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1.5 px-1 text-xs text-faint">Applies live to open terminals. Saved in this browser.</p>
          </Section>

          {/* Addons: things Burrow can use if they are on this machine, and says so plainly when
              they are not. See server/src/tailscale.ts, and USAGE-PROVIDER.md for the next one. */}
          <Section title="Addons">
            <TailscaleRow />
            <UsageRow onClose={onClose} />
          </Section>

          {/*
            Replaces a "Tour" button that used to sit in the header. That was a review tool I built
            for myself and left in, and on a public install it shows for everyone, the header is
            not where a thing you use once belongs.

            This resets the SERVER's record, so the tour genuinely runs again, on this browser and
            every other one. There is no simulated mode any more.
          */}
          <Section title="Onboarding">
            <button
              onClick={() => {
                gateway.req("onboarding.seen", { reset: true }).catch(() => {});
                window.location.reload();
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-bg px-3 py-2.5 text-left transition-colors hover:border-accent/50"
            >
              <span className="min-w-0">
                <span className="block text-sm text-muted">Show the tour again</span>
                <span className="mt-0.5 block text-xs text-faint">
                  Replays the first-run walkthrough and the one-off tips, on every device.
                </span>
              </span>
              <CaretRight size={14} weight="bold" className="shrink-0 text-faint" />
            </button>
          </Section>

          <Section title="Shortcuts">
            <ShortcutsEntry onOpen={() => setShortcutsOpen(true)} />
          </Section>
          {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}


          {(
            <Section title="Danger zone">
              <div className="rounded-xl border border-danger/40 bg-bg p-3">
                {killed !== null ? (
                  <p className="text-sm text-muted">
                    Ended <span className="text-ink">{killed}</span> session{killed === 1 ? "": "s"}.
                  </p>
                ): confirmKill ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-danger">
                      End all {liveCount} live session{liveCount === 1 ? "": "s"}?
                    </span>
                    <div className="flex gap-1.5">
                      <button onClick={() => setConfirmKill(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink">
                        Cancel
                      </button>
                      <button onClick={killAll} className="rounded-md bg-danger px-2.5 py-1 text-xs font-medium text-bg">
                        Kill all
                      </button>
                    </div>
                  </div>
                ): (
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm text-ink">Kill all sessions</p>
                      <p className="text-xs text-faint">Ends every live terminal, including persistent ones.</p>
                    </div>
                    <button
                      onClick={() => setConfirmKill(true)}
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-danger/50 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger hover:text-bg"
                    >
                      <Skull size={14} weight="bold" /> Kill all
                    </button>
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section title="About">
            <div className="rounded-xl border border-line bg-bg px-3 py-2.5 font-mono text-xs text-muted">
              <p>
                Bur<span className="text-accent">·</span>row, build {__BUILD_COMMIT__}
              </p>
              <p className="mt-0.5 text-faint">
                built {__BUILD_TIME__} · gateway {status === "ready" ? "connected": status}
              </p>
            </div>
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
