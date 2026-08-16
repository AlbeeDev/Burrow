/**
 * The shell for "create a thing" dialogs: groups and projects.
 *
 * Why these are modals. Both used to open *inside* the sidebar: the group
 * name field appeared in the project list, the project form expanded under its button. That is
 * fine on its own and impossible to guide someone through, because the control you must type into
 * is a small box tucked inside a busy panel, nowhere near the button you just pressed. A modal
 * takes the middle of the screen, so there is exactly one place to look.
 *
 * It also fixes something worse. driver.js sets `pointer-events: none` on everything except the
 * element it is highlighting, so during the first-run tour the inline input was not merely hidden
 * behind the popover: it was dead. A modal is a single element the tour can highlight whole,
 * which makes it and every field inside it interactive again.
 */
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export function CreateModal({
  title,
  subtitle,
  tourId,
  submitLabel,
  canSubmit,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Anchor for the first-run tour, when this dialog is one of its steps. */
  tourId?: string;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        data-tour={tourId}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-1 text-xs text-faint">{subtitle}</p>}

        <div className="mt-4 space-y-2">{children}</div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:text-ink">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-bg transition-opacity disabled:opacity-40"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
