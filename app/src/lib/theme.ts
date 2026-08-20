/**
 * Theme switching: curated palettes defined as CSS-variable sets in index.css and selected
 * via `data-theme` on <html>. Per-browser preference (localStorage), applied before first
 * paint from main.tsx so there is no flash of the default theme.
 */

export type Theme = { id: string; label: string; swatch: [string, string, string] };

// swatch = [bg, surface, accent]: enough to preview a palette as a chip.
export const THEMES: Theme[] = [
  { id: "ember", label: "Ember", swatch: ["#13100c", "#241d15", "#f2792b"] },
  { id: "moss", label: "Moss", swatch: ["#0e120c", "#1b2417", "#8fc866"] },
  { id: "ocean", label: "Ocean", swatch: ["#0b0f14", "#161f29", "#4da3e5"] },
  { id: "violet", label: "Violet", swatch: ["#100d15", "#1e1827", "#a875e8"] },
];

const LS_KEY = "burrow.theme";
const DEFAULT = "ember";

export function currentTheme(): string {
  try {
    const t = localStorage.getItem(LS_KEY);
    return t && THEMES.some((x) => x.id === t) ? t: DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function applyTheme(id: string): void {
  // Ember is the:root default: no attribute keeps the CSS lean.
  if (id === DEFAULT) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(LS_KEY, id);
  } catch {
    /* private mode etc.: theme just won't persist */
  }
}

/** Boot hook: apply the saved theme before first paint. */
export function initTheme(): void {
  applyTheme(currentTheme());
}

/**
 * Light/dark mode, orthogonal to the accent theme: it flips only the neutral base tokens (see the
 * `data-mode="light"` block in index.css), so any theme's accent works in either mode.
 */
export type Mode = "dark" | "light";

const MODE_KEY = "burrow.mode";

export function currentMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "light" ? "light": "dark";
  } catch {
    return "dark";
  }
}

export function applyMode(mode: Mode): void {
  if (mode === "light") document.documentElement.dataset.mode = "light";
  else delete document.documentElement.dataset.mode;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* private mode / storage disabled: the choice just won't persist */
  }
}

/** Boot hook: apply the saved mode before first paint. */
export function initMode(): void {
  applyMode(currentMode());
}
