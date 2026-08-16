/**
 * Shows one first-use hint, if it hasn't been seen. See `lib/hints.ts` for why these exist apart
 * from the tour.
 *
 * Same driver.js machinery and the same placement rule as the tour, the box goes where nothing
 * you have to touch lives, but none of the sequencing. A hint has no next and no previous; it is
 * one thing said once. Dismissing it is the only exit, and that is also what marks it seen.
 */
import { useEffect, useRef } from "react";
import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { HINTS, type HintId } from "../lib/hints";
import { useGateway } from "../lib/useGateway";

export function Hint({ id, active }: { id: HintId; active: boolean }) {
  const ref = useRef<Driver | null>(null);
  const { onboarding, markSeen } = useGateway();
  // null means the server has not answered. Not "unseen", guessing there would raise a hint at
  // somebody who dismissed it months ago, every time they open the dialog.
  const seen = onboarding === null || onboarding.hintsSeen.has(id);

  useEffect(() => {
    if (!active || seen) return;
    const hint = HINTS[id];

    const obj = driver({
      showProgress: false,
      popoverClass: "burrow-tour",
      allowClose: false,
      overlayOpacity: 0.55,
      doneBtnText: "Got it",
      nextBtnText: "Got it",
      onCloseClick: () => end(),
      onDestroyStarted: () => end(),
      onNextClick: () => end(),
      onDoneClick: () => end(),
    });
    ref.current = obj;

    function end() {
      markSeen({ hint: id });
      ref.current?.destroy();
      ref.current = null;
    }

    /*
     * Wait for the dialog to exist. The surface that triggers a hint is usually a modal that
     * mounts a frame or two after the state flag flips, so a single check on mount would find
     * nothing and the hint would never appear at all. Gives up after a second rather than
     * polling forever behind a dialog that failed to open.
     */
    let tries = 0;
    const timer = setInterval(() => {
      const element = document.querySelector(`[data-tour="${hint.anchor}"]`);
      if (element) {
        clearInterval(timer);
        obj.highlight({
          element,
          popover: {
            title: hint.title,
            description: hint.description,
            side: hint.side,
            align: "center",
            showButtons: ["next", "close"],
          },
        });
      } else if (++tries > 20) {
        clearInterval(timer);
      }
    }, 50);

    return () => {
      clearInterval(timer);
      ref.current?.destroy();
      ref.current = null;
    };
  }, [id, active, seen, markSeen]);

  return null;
}
