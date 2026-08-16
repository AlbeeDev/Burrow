/**
 * Split-terminal layout logic: pure, so the rules that decide "which project is in which
 * panel, and which panel is focused" can be verified without a browser.
 *
 * The whole point of the focused-cell model: the focused panel IS the app's active project.
 * Every operation therefore returns a complete new state, and App derives the active project
 * from it: there is no second copy of the truth to drift.
 */

export type Cell = { id: number; project: string | null | undefined }; // undefined = empty panel
export type SplitState = { cells: Cell[]; focusId: number; nextId: number };

/**
 * How a layout holds more panels than fit on screen.
 *
 * `cells` is one ordered list. The first LIVE_MAX are ON STAGE: real attached terminals in the
 * grid, exactly as before. Anything past that is PARKED, it stays part of the layout but owns no
 * terminal, and you swap it onto the stage when you want it. So the answer to "what happens past
 * four" is not "shrink everything", it's "the layout is longer than the stage".
 *
 * Why not the obvious alternatives: an even 3×3 grid makes every terminal too small to read at the
 * width a browser gives you; a big focused panel with tiny live thumbnails has the same problem for
 * the thumbnails, and worse, a 22-column tmux client makes Claude's TUI reflow every time you
 * promote it. Paging hides which panels exist. Parking keeps every panel visible AS A THING while
 * only ever attaching four.
 *
 * Nothing about 1–4 panels changes: with no parked cells there is no rail and the grid is the same
 * grid. That is deliberate: this is judged on feel and must be easy to revert.
 */
export const LIVE_MAX = 4; // attached terminals shown at once
export const MAX_PANELS = 8; // panels a layout may hold in total (stage + parked)

/** Enter split view: the current project on the left, an empty panel beside it. */
export function openSplit(project: string | null): SplitState {
  return { cells: [{ id: 1, project }, { id: 2, project: undefined }], focusId: 1, nextId: 3 };
}

/** The focused panel's project (`undefined` = the panel is empty). */
export function focusedProject(s: SplitState): string | null | undefined {
  return s.cells.find((c) => c.id === s.focusId)?.project;
}

/**
 * Where to land when leaving split view. Normally the focused panel's project, which is already
 * the app's active project, so nothing moves. When the focused panel is EMPTY there is nothing to
 * carry out, and exiting onto whatever you focused *before* would drop you somewhere you weren't
 * looking; take the first panel on stage that holds something instead, and master if none do.
 */
export function exitTarget(s: SplitState): string | null {
  const focused = focusedProject(s);
  if (focused !== undefined) return focused;
  const occupied = stageCells(s).find((c) => c.project !== undefined);
  return occupied?.project ?? null;
}

/** The panels on stage: attached terminals in the grid. */
export function stageCells(s: SplitState): Cell[] {
  return s.cells.slice(0, LIVE_MAX);
}

/** The panels the layout holds but isn't showing. Empty for every layout of 4 or fewer. */
export function parkedCells(s: SplitState): Cell[] {
  return s.cells.slice(LIVE_MAX);
}

/** Focus only ever lands on a staged panel, a parked one has nothing to type into. */
export function focusPanel(s: SplitState, id: number): SplitState {
  return stageCells(s).some((c) => c.id === id) ? {...s, focusId: id }: s;
}

/**
 * Focus ANY panel in the layout, staged or not (the horizontal
 * scroller). There is no stage there: every panel is a column you can scroll to, so "you can't
 * focus what isn't on stage" stops being true. `focusPanel` keeps the grid's stricter rule.
 */
export function focusCell(s: SplitState, id: number): SplitState {
  return s.cells.some((c) => c.id === id) ? {...s, focusId: id }: s;
}

/**
 * Bring a parked panel onto the stage by trading places with the focused one, and focus it. The
 * displaced panel takes the parked slot, so nothing is lost and the list length never changes.
 * Called with an already-staged id it just focuses it.
 */
export function promotePanel(s: SplitState, id: number): SplitState {
  const from = s.cells.findIndex((c) => c.id === id);
  if (from === -1) return s;
  if (from < LIVE_MAX) return {...s, focusId: id };
  const to = s.cells.findIndex((c) => c.id === s.focusId);
  const slot = to >= 0 && to < LIVE_MAX ? to: 0;
  const cells = [...s.cells];
  const parked = cells[from]!;
  cells[from] = cells[slot]!;
  cells[slot] = parked;
  return {...s, cells, focusId: id };
}

/**
 * Sidebar click: fill the FOCUSED panel, leaving the others alone. A project already open in
 * another panel just gets focused instead, one project can only be attached once (two
 * attachments fight over the tmux size).
 */
export function assignToFocused(s: SplitState, project: string | null): SplitState {
  const existing = s.cells.find((c) => c.project === project && c.id !== s.focusId);
  // Already open somewhere: go to it. If that somewhere is parked, bring it on stage, otherwise
  // the sidebar click would "focus" a panel with nothing to type into.
  if (existing) return promotePanel(s, existing.id);
  return {...s, cells: s.cells.map((c) => (c.id === s.focusId ? {...c, project }: c)) };
}

/**
 * Drag a project onto a specific panel. If it's already open elsewhere the two panels swap,
 * so a drag never duplicates an attachment or silently drops one.
 */
export function dropOnPanel(s: SplitState, id: number, project: string): SplitState {
  const target = s.cells.find((c) => c.id === id);
  if (!target) return s;
  const from = s.cells.find((c) => c.project === project);
  if (from?.id === id) return focusPanel(s, id);
  const next = {
...s,
    cells: s.cells.map((c) => {
      if (c.id === id) return {...c, project };
      if (from && c.id === from.id) return {...c, project: target.project };
      return c;
    }),
  };
  // focusPanel, not a raw assignment: dropping onto a parked tile must not focus something
  // off stage.
  return focusPanel(next, id);
}

/**
 * Live layout → the stored form (the panel list, nothing else). Cell ids are ephemeral client
 * state, so they are deliberately not persisted; reopening rebuilds them. Neither is focus, 
 * because this shape is what gets compared to decide whether to save, leaving focus out is what
 * makes clicking between panels free of server writes.
 */
export function toSaved(s: SplitState): { panels: SavedPanel[] } {
  return { panels: s.cells.map((c) => (c.project === undefined ? null: { project: c.project })) };
}

/** Stored form → a live layout, focused on the first panel. Empty input still yields something. */
export function fromSaved(panels: SavedPanel[]): SplitState {
  const list = (panels ?? []).slice(0, MAX_PANELS);
  const cells: Cell[] = (list.length ? list: [null]).map((p, i) => ({
    id: i + 1,
    project: p === null || p === undefined ? undefined: p.project,
  }));
  return { cells, focusId: cells[0]!.id, nextId: cells.length + 1 };
}

export type SavedPanel = { project: string | null } | null;

/**
 * Add an empty panel, up to MAX_PANELS. It's focused if it lands on stage; past LIVE_MAX it
 * arrives parked, and focus stays where the work is rather than jumping to a panel you can't type
 * into.
 */
export function addPanel(s: SplitState): SplitState {
  if (s.cells.length >= MAX_PANELS) return s;
  const landsOnStage = s.cells.length < LIVE_MAX;
  return {
    cells: [...s.cells, { id: s.nextId, project: undefined }],
    focusId: landsOnStage ? s.nextId: s.focusId,
    nextId: s.nextId + 1,
  };
}

/**
 * Close a panel. Closing a staged one pulls the first parked panel onto the stage (the list just
 * gets shorter). Closing the focused one moves focus to the first staged survivor; closing the
 * last panel returns null: the caller leaves split view.
 */
export function closePanel(s: SplitState, id: number): SplitState | null {
  const cells = s.cells.filter((c) => c.id !== id);
  if (cells.length === 0) return null;
  const next = {...s, cells, focusId: id === s.focusId ? cells[0]!.id: s.focusId };
  // The focused panel may have been pushed off stage by the shift; keep the invariant.
  return stageCells(next).some((c) => c.id === next.focusId) ? next: {...next, focusId: cells[0]!.id };
}
