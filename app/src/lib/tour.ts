/**
 * First-run tour.
 *
 * Two phases that advance differently. The setup steps (`group`, `project`) have no Next button:
 * they advance when the thing actually exists, because a fresh install is unusable until a group
 * and a project are made (the "New project" button only renders inside a group). The workspace
 * steps after them are informational, so Next and Skip are correct there.
 *
 * Phase 1 is derived from what exists rather than stored as a cursor, so it survives a reload and
 * can never point at a button that has not rendered. Dismissal is stored on the server
 * (settings.json), not in localStorage: Burrow is opened from many browsers by one person, and a
 * per-browser flag would replay the tour on every device.
 */

/** Steps are identified by what they point at, so the anchors and the logic can't drift apart. */
export type TourStep =
  // Phase 1: do this.
  | "group"
  | "project"
  // Phase 2: look at this.
  | "terminal"
  | "persistence"
  | "modes"
  | "layouts";

/**
 * The informational half, in order. Files, search, the group manager and the scheduler are
 * deliberately absent: they are first-use hints (lib/hints.ts), shown when the surface is first
 * opened instead of up front.
 */
export const WORKSPACE_STEPS: TourStep[] = ["terminal", "persistence", "modes", "layouts"];

/** Does this step wait for the user to do something, or for them to press Next? */
export function isAction(step: TourStep): boolean {
  return step === "group" || step === "project";
}

/**
 * Fired when moving off a step, so whatever dialog that step opened gets closed. That state lives
 * in Sidebar and App, which the tour has no handle on; an event avoids drilling props through
 * three components.
 */
export const TOUR_RESET_EVENT = "burrow:tour-reset";

/**
 * Where phase 1 is, purely as a function of what exists. `"workspace"` means phase 1 is done and
 * the cursor half takes over; `null` means show nothing (finished, dismissed, or the gateway has
 * not answered yet: `projects` is an empty array before the first response too, so acting on it
 * early would open the tour during the connect flicker).
 */
export function currentStep(input: {
  ready: boolean;
  dismissed: boolean;
  groupCount: number;
  projectCount: number;
  /**
   * Whether this session already showed a step. Separates "made their first project just now,
   * continue into the workspace" from "has had projects for months, show nothing".
   */
  started: boolean;
}): TourStep | "workspace" | null {
  if (!input.ready || input.dismissed) return null;
  if (input.projectCount > 0) return input.started ? "workspace": null;
  if (input.groupCount === 0) return "group";
  return "project";
}
