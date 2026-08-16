/**
 * Terminal font size: per-browser (localStorage). TerminalView reads it at open and
 * listens for the change event so an open terminal re-sizes live from the settings panel.
 */

const LS_KEY = "burrow.termFontSize";
export const FONT_MIN = 10;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 13;
export const FONT_EVENT = "burrow:termfont";

export function termFontSize(): number {
  try {
    const n = Number(localStorage.getItem(LS_KEY));
    return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n: FONT_DEFAULT;
  } catch {
    return FONT_DEFAULT;
  }
}

export function setTermFontSize(n: number): void {
  const v = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
  try {
    localStorage.setItem(LS_KEY, String(v));
  } catch {
    /* private mode: applies this page only */
  }
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: v }));
}
