/**
 * Every binding and gesture, in a scrollable modal of its own.
 *
 * It used to render inline in Settings, which was fine at nine entries and stopped being fine as
 * soon as the gestures landed: rendering all of them inline doesn't scale. Settings now
 * shows a one-line entry point; this is what it opens, and what `?` opens from anywhere.
 *
 * Still driven entirely by the SHORTCUTS array, so adding a binding remains one entry there.
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Keyboard, X } from "@phosphor-icons/react";
import { keyLabel, shortcutGroups } from "../lib/shortcuts";

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Keyboard size={18} weight="fill" className="text-accent" />
            <h2 className="text-base font-semibold text-ink">Shortcuts &amp; gestures</h2>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close shortcuts"
            title="Close (Esc)"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-5">
          {shortcutGroups().map((group) => (
            // shrink-0: these are direct children of a flex COLUMN that scrolls, so without it
            // they compress to fit and clip their own rows instead of making the list scroll.
            <div key={group.where} className="shrink-0 overflow-hidden rounded-xl border border-line bg-bg">
              <p className="border-b border-line px-3 py-1.5 text-[11px] font-medium text-faint">{group.where}</p>
              <div className="divide-y divide-line">
                {group.items.map((s) => (
                  <div key={`${group.where}:${s.label}`} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm text-muted">{s.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {s.keys.map((k) =>
                        // A gesture is a phrase, not a key you can press, different shape.
                        s.kind === "gesture" ? (
                          <span
                            key={k}
                            className="rounded-md border border-dashed border-line px-1.5 py-0.5 text-[11px] text-muted"
                          >
                            {k}
                          </span>
                        ): (
                          <kbd
                            key={k}
                            className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink"
                          >
                            {keyLabel(k)}
                          </kbd>
                        ),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
