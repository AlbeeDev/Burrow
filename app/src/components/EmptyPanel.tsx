/**
 * The placeholder in a split panel that holds no project, and, more importantly, something the
 * browser can put keyboard focus INTO.
 *
 * Without that, focusing an empty panel (by click or by Cmd/Ctrl-1…4) left the DOM focus sitting
 * in the terminal you came from, so the header said "Empty panel" while your keystrokes went to
 * another project's shell. Being focusable means the old terminal loses focus and the keys land
 * nowhere, which is the honest behaviour for a panel with nothing in it.
 *
 * Shared by SplitGrid and SplitScroller so the two can't drift.
 */
import { useEffect, useRef } from "react";

export function EmptyPanel({ focused }: { focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`grid h-full place-items-center rounded-xl border border-dashed px-3 text-center text-xs text-faint outline-none ${
        focused ? "border-accent/50": "border-line"
      }`}
    >
      {focused ? "Click a project in the sidebar to open it here": "Click this panel, then pick a project"}
    </div>
  );
}
