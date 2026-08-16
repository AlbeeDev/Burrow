/**
 * Every binding the app actually implements, in one list, so the Settings panel (and any later
 * help surface) can't drift from reality. Adding one is a single entry here plus its handler; the
 * UI needs no other change.
 *
 * `mod` prints as ⌘ on Apple keyboards and Ctrl everywhere else; the handlers accept either.
 * `where` is the context the binding is live in, and doubles as the group heading.
 *
 * Gestures live here too (`kind: "gesture"`). Right-click-to-paste, Shift-drag,
 * copy-on-release and one-finger scroll are as real and as undiscoverable as any chord, they were
 * left out of the first version only because they aren't keys. Keeping them in the same array is
 * what makes "adding one stays one entry" true for both kinds; the renderer looks at `kind` to
 * decide whether to draw a keycap or a phrase.
 */

import { LIVE_MAX } from "./splitCells";

export type Shortcut = {
  keys: string[];
  label: string;
  where: string;
  /** Omitted means a key binding. */
  kind?: "gesture";
};

export const SHORTCUTS: Shortcut[] = [
  { keys: ["mod", "K"], label: "Search projects and chats", where: "Anywhere" },
  { keys: ["?"], label: "Show this list", where: "Anywhere" },

  { keys: ["mod", `1–${LIVE_MAX}`], label: "Focus that panel", where: "Split view" },
  { keys: ["mod", "0"], label: "Leave the split, or reopen the last one you left", where: "Split view" },

  { keys: ["↑", "↓"], label: "Move between results", where: "Search" },
  { keys: ["Enter"], label: "Open the selected result", where: "Search" },
  { keys: ["→"], label: "Show the whole message for a chat hit", where: "Search" },
  { keys: ["←"], label: "Collapse it again", where: "Search" },
  { keys: ["Esc"], label: "Close the search", where: "Search" },

  { keys: ["Enter"], label: "Send the message", where: "Bubble" },
  { keys: ["Shift", "Enter"], label: "New line instead of sending", where: "Bubble" },
  { keys: ["Tab"], label: "Complete the slash command being typed", where: "Bubble" },

  { keys: ["Enter"], label: "Confirm the name", where: "Renaming and creating" },
  { keys: ["Esc"], label: "Cancel", where: "Renaming and creating" },

  // Gestures: all four are implemented in TerminalView and none of them are discoverable.
  { keys: ["Right-click"], label: "Paste from the clipboard", where: "Terminal, mouse", kind: "gesture" },
  {
    keys: ["Shift-drag"],
    label: "Select text: a plain drag belongs to the app running inside",
    where: "Terminal, mouse",
    kind: "gesture",
  },
  { keys: ["Release a selection"], label: "Copies it, no keystroke needed", where: "Terminal, mouse", kind: "gesture" },
  { keys: ["One-finger drag"], label: "Scroll the terminal", where: "Terminal, touch", kind: "gesture" },
];

const APPLE =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One key as it should be printed for this keyboard. */
export function keyLabel(key: string): string {
  return key === "mod" ? (APPLE ? "⌘": "Ctrl"): key;
}

/**
 * Which split panel a key event is asking to focus (1-based), or 0 if it isn't that chord.
 *
 * Shared by App's window listener and xterm's key filter in TerminalView, so the two can't
 * disagree about which keys the app owns and which belong to the shell. `code` is preferred over
 * `key` because on layouts where a digit needs a modifier (AZERTY and friends) `key` isn't the
 * digit at all, while `code` still says Digit1.
 */
export function panelFocusRequest(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}): number {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return 0;
  const n = e.code?.startsWith("Digit") ? Number(e.code.slice(5)): Number(e.key);
  return Number.isInteger(n) && n >= 1 && n <= LIVE_MAX ? n: 0;
}

/**
 * Is this the split toggle (mod-0)? Same `code`-over-`key` reasoning as `panelFocusRequest`, and
 * the same two callers, so the shell can never eat it either. Deliberately NOT folded into
 * `panelFocusRequest`: that one answers "which panel", and 0 is not a panel.
 */
export function splitToggleRequest(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.code === "Digit0" || e.key === "0";
}

/**
 * Is this the "show me the shortcuts" key? `?` is a plain character, so unlike the chords it has
 * to yield to anything you can type into: a composer, a rename field, or the terminal's hidden
 * textarea. Everything else in this module answers "which chord"; this one also answers "is the
 * user typing", which is why the target check lives here rather than in the handler.
 */
export function helpRequest(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
}): boolean {
  if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return false;
  const el = e.target as HTMLElement | null;
  if (!el || !el.tagName) return true;
  const tag = el.tagName.toLowerCase();
  return !(tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable);
}

/** SHORTCUTS grouped by `where`, keeping the order they're declared in. */
export function shortcutGroups(): { where: string; items: Shortcut[] }[] {
  const groups: { where: string; items: Shortcut[] }[] = [];
  for (const s of SHORTCUTS) {
    const group = groups.find((g) => g.where === s.where);
    if (group) group.items.push(s);
    else groups.push({ where: s.where, items: [s] });
  }
  return groups;
}
