// Shared group color logic so the sidebar rail, the in-chat picker, and the manager all
// color a given group identically. Earthy palette that sits inside Burrow's ember theme.
export const GROUP_COLORS = [
  "#f2792b", // ember
  "#e0a94b", // amber
  "#c9702b", // burnt orange
  "#d0644f", // clay red
  "#8fae5f", // olive
  "#5fb8ad", // muted teal
  "#c98bd0", // dusty violet
  "#b5814f", // tan
] as const;

export function groupColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length]!;
}
