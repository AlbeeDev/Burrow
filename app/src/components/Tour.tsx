/**
 * The first-run tour's driver.js wiring. Which step you are on is decided in `lib/tour.ts`; this
 * file turns a step into a highlight on screen.
 *
 * A step is a sequence of states, not one anchor. Clicking the thing a step points at usually
 * opens something else: the `+` opens a dialog, "New project" opens a dialog, and the highlight
 * has to move with it. Each state carries its own target, its own words, and its own placement.
 *
 * Placement is not decorative. driver.js sets `pointer-events: none` on everything except the
 * highlighted element, and the popover is drawn on top of the page. So a box on the wrong side
 * does not merely look untidy, it covers the control the user has to use, which is exactly what
 * the first version did: it pointed *right* from the rail `+`, straight onto the panel where the
 * name field opened. The rule below is: the box goes where nothing the user must touch lives.
 *
 * It also uses `highlight()` rather than a `drive()` tour. A tour owns its own cursor and advances
 * on a Next click; this advances only when the app's state says the user actually did the thing.
 */
import { useEffect, useRef } from "react";
import { driver, type Driver, type Side } from "driver.js";
import "driver.js/dist/driver.css";
import type { TourStep } from "../lib/tour";
import { isAction, WORKSPACE_STEPS } from "../lib/tour";

type State = {
  /** `data-tour` value on the element to point at. */
  anchor: string;
  title: string;
  description: string;
  /**
   * Which side of the anchor the box sits on, and why. Every one of these is a claim that nothing
   * interactive lives on that side at that moment.
   */
  side: Side;
};

/** Earlier entries win when both are on screen: a dialog beats the button that opened it. */
const STATES: Record<TourStep, State[]> = {
  group: [
    {
      // The dialog is centred and its field is in the upper half, so the box goes BELOW it, 
      // the only side that cannot reach the input, and the order you read in anyway.
      anchor: "group-modal",
      title: "Name your group",
      side: "bottom",
      description:
        "Anything you like: <i>Work</i>, <i>Personal</i>, <i>Clients</i>. It is only a label and a " +
        "colour, so you can rename or delete it later.",
    },
    {
      // Right of the rail is the projects panel, which on a fresh install is empty. Nothing to
      // cover, and the dialog this opens is centred, so the box moves off it entirely.
      anchor: "new-group",
      title: "Start with a group",
      side: "right",
      description:
        "Groups are just labels for your projects, the colours in this rail. Click <b>+</b> to make one." +
        "<br><br>You need one first, because a project is created <i>into</i> a group.",
    },
  ],
  project: [
    {
      anchor: "project-modal",
      title: "Name your project",
      side: "bottom",
      description:
        "This creates a folder in your projects directory, with its own terminal running Claude Code. " +
        "The description is optional.",
    },
    {
      // Right of the *panel* is the terminal area, inert during this step. Same direction as the
      // rail step above, different neighbour; that distinction is the whole point of the rule.
      anchor: "new-project",
      title: "Now add a project",
      side: "right",
      description: "Each project is a folder with its own Claude session. Click <b>New project</b>.",
    },
    {
      // Only reached when no group is selected: "New project" does not exist then, and without
      // this the tour showed nothing at all and stranded the user on an empty app.
      anchor: "first-group",
      title: "Open your group",
      side: "right",
      description:
        "Click your group here first. Projects are created <i>into</i> a group, so the " +
        "<b>New project</b> button appears once one is selected.",
    },
  ],
  /*
   * A note on the tall modals (files, search, groups): their box sits BESIDE them, not below.
   * "bottom" is the natural reading order and is what the short create-dialogs use, but a 75vh
   * modal leaves no room under it, so driver flips the box out to the far edge of the screen where
   * it reads as belonging to nothing. Beside is the only placement that stays next to its subject.
   */
  // ── Phase 2: look at this. Nothing to confirm, so these advance on Next. ──────────────────
  terminal: [
    {
      // Box on the LEFT: the terminal fills the right of the screen, so anything else would sit
      // on top of the thing being pointed at.
      anchor: "terminal",
      title: "This is your project",
      side: "left",
      description:
        "Claude Code, running <b>on the machine Burrow is installed on</b>, not in your browser. " +
        "The browser is only a window onto it, so you can close this tab, open Burrow from your " +
        "phone, and carry on in the same session.",
    },
  ],
  persistence: [
    {
      anchor: "persistence",
      title: "What happens when you leave",
      side: "bottom",
      description:
        "<b>Ephemeral</b> sessions are cleaned up once you leave, never mid-task. It waits until " +
        "the session is idle. <b>Persistent</b> ones keep running until you stop them, for as long " +
        "as the machine Burrow is on stays awake.",
    },
  ],
  modes: [
    {
      anchor: "modes",
      title: "Two ways to look at it",
      side: "bottom",
      description:
        "<b>Terminal</b> is the real Claude Code interface, keystroke for keystroke. <b>Bubble</b> " +
        "is a chat view of the same session, easier on a phone. Same conversation either way.",
    },
  ],
  layouts: [
    {
      anchor: "layouts",
      title: "Terminals side by side",
      side: "right",
      description:
        "Put terminals side by side and save the arrangement: full height, scroll sideways for " +
        "more. Handy when one project is building and you want to work in another. Only the " +
        "arrangement is saved, not the sessions, so deleting one never ends anything.",
    },
  ],
};

export function Tour({
  step,
  onDismiss,
  onSkip,
}: {
  step: TourStep | null;
  onDismiss: () => void;
  /** Advance a "look at this" step. The two setup steps have no such button; see below. */
  onSkip?: () => void;
}) {
  const ref = useRef<Driver | null>(null);
  // Read by driver's callbacks, which are created once and must not close over a stale prop.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const skip = useRef(onSkip);
  skip.current = onSkip;

  useEffect(() => {
    if (!step) {
      ref.current?.destroy();
      ref.current = null;
      return;
    }

    const end = () => {
      // Recording that it was seen is the caller's job, it owns the gateway and knows whether
      // this is a replay, which must never write the flag.
      dismiss.current();
      ref.current?.destroy();
      ref.current = null;
    };

    // The final workspace step: its button says Done rather than Next.
    const last = step === WORKSPACE_STEPS[WORKSPACE_STEPS.length - 1];
    /*
     * Who gets a Next button, and what it says.
     *
     * A "do this" step (group, project) has none: it ends when the user made the thing, and
     * offering to skip past it would skip the only two actions the tour exists to teach. A "look
     * at this" step has nothing to wait for, so Next is the only way forward, and skipping is
     * legitimate there, because by then they have a working project and the rest is information.
     *
     * A replay gets the button on every step regardless, since the point is to move through
     * without doing anything.
     */
    const stepIsAction = isAction(step);
    const advancing = !stepIsAction;
    const advance = advancing ? () => skip.current?.(): end;
    const obj = driver({
      showProgress: false,
      popoverClass: "burrow-tour", // styled against the theme's variables in index.css
      doneBtnText: last ? "Done": "Next",
      nextBtnText: last ? "Done": "Next",
      /*
       * "Skip tour" rides in driver's PREVIOUS slot. There is no third button in its API, and the
       * footer puts previous on the left of next, which is exactly where a quiet way out belongs,
       * away from the button you press to continue. Going backwards through a tour that advances
       * on what you did makes no sense anyway, so the slot was free.
       */
      prevBtnText: "Skip tour",
      onPrevClick: end,
      // Only the × ends it. With this true, one click on the dimmed area would abandon the tour
      // permanently: an expensive outcome for a misclick.
      allowClose: false,
      overlayOpacity: 0.6,
      onCloseClick: end,
      onDestroyStarted: end,
      onNextClick: advance,
      onDoneClick: advance,
    });
    ref.current = obj;

    const states = STATES[step];
    let showing = -1;

    /**
     * Point at the best state currently on screen.
     *
     * On a timer rather than only when `step` changes, because what makes the next state appear is
     * often invisible from here: opening a dialog and selecting a group are both Sidebar state.
     * Without the re-check the box sat on "open your group" for a group that was already open.
     */
    const settle = () => {
      const index = states.findIndex((s) => document.querySelector(`[data-tour="${s.anchor}"]`));
      if (index === -1 || index === showing) return;
      const state = states[index]!;
      const element = document.querySelector(`[data-tour="${state.anchor}"]`);
      if (!element) return;
      showing = index;
      obj.highlight({
        element,
        popover: {
          title: state.title,
          description: state.description,
          side: state.side,
          align: "center",
          // Buttons belong on the POPOVER: the driver config's `showButtons` only applies to a
          // `drive()` tour, and with `highlight()` it renders nothing, which left the first
          // version with no visible way out at all.
          /*
            No way out of the two setup steps, not even the ×. Four boxes
            appear before a project exists (each step has a button state and a dialog state), and
            none of them offers an exit: a group and a project are what make the app usable at
            all, and on a fresh install there is nothing else to do anyway. Dismissing the tour
            there would leave someone alone with an empty sidebar and a New project button that
            does not exist yet, which is exactly the state the tour was written to rescue.

            Everything after has both: Next to continue, Skip tour to leave. By then it is
            information, and leaving early is a fair choice.
          */
          showButtons: stepIsAction ? []: ["previous", "next", "close"],
        },
      });
    };

    settle();
    // Well under "did that do anything?", and costs one querySelector per state per tick, only
    // while a step is on screen.
    const timer = setInterval(settle, 300);

    return () => {
      clearInterval(timer);
      obj.destroy();
      ref.current = null;
    };
  }, [step]);

  return null;
}
