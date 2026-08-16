/**
 * First-use hints: a one-off explanation the first time you open a particular thing.
 *
 * Why these are not tour steps. The tour runs once, in the first few
 * minutes, when someone has one project and no reason to care about organising or scheduling.
 * Explaining the group manager there is explaining a filing cabinet to somebody with one sheet of
 * paper, and by the time they actually open it, weeks later, the tour is long finished and the
 * explanation is gone.
 *
 * So these are deliberately disconnected from the tour: no order, no cursor, no relationship
 * to each other. Each one waits for its own surface to open, says its piece once, and is never
 * seen again. Somebody who never opens the scheduler never sees the scheduler hint.
 *
 * Each hint has its own flag, so adding one later shows it to existing users too, which is the
 * point. A hint attached to the tour's single "seen it" flag would be silently dead for everyone
 * who had already finished.
 *
 * Seen-state lives on the SERVER alongside the tour's, for the same reason: one install, one
 * answer, however many browsers you open it from. See lib/tour.
 */

export type HintId = "groups-manager" | "schedule" | "files" | "search";

export type Hint = {
  /** `data-tour` value on the element to point at, usually the dialog that just opened. */
  anchor: string;
  title: string;
  description: string;
  /** Beside, for the same reason the tour's modal steps are: tall dialogs leave no room below. */
  side: "top" | "bottom" | "left" | "right";
};

export const HINTS: Record<HintId, Hint> = {
  "groups-manager": {
    anchor: "groups-modal",
    title: "Organising projects",
    side: "right",
    description:
      "Drag a project from one lane to another to move it between groups. The <b>⋮</b> on a lane " +
      "renames or recolours it, and new groups are made from the field at the top. Groups are only " +
      "labels, so nothing here touches a folder or ends a session.",
  },
  files: {
    anchor: "files-modal",
    title: "Your project's folder",
    side: "right",
    description:
      "Everything in the project directory, without leaving the browser. Download what Claude made, " +
      "upload something for it to work on. It is the same folder the session is working in, so " +
      "anything you drop here is immediately there.",
  },
  search: {
    anchor: "search-modal",
    title: "Searching everything you have said",
    side: "bottom",
    description:
      "This searches the <b>text of every past conversation</b>, in every project, not just their " +
      "names. It is how you find \"what did I decide about that\" months later. " +
      "<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd> opens it from anywhere.",
  },
  schedule: {
    anchor: "schedule-modal",
    title: "Sending yourself a message later",
    side: "right",
    description:
      "Pick a time and a message, and Burrow types it into the chosen sessions for you. Useful for " +
      "kicking something off overnight. Only <b>persistent</b> chats are woken; an ephemeral one " +
      "is skipped rather than started behind your back.",
  },
};
