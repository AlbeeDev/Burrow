/**
 * The split view: N full-height columns and one horizontal scrollbar. The layout is as long as you
 * want; the screen shows the slice you scrolled to.
 *
 * Started as an experiment: "instead of that bottom for
 * parked we could use that part of the bottom for a huge scroll bar side to side and have infinite
 * terminals opening horizontally": running behind a flag next to a 2x2 grid. Eventually the
 * flag and the grid were both removed and this became the only layout, because the grid's first
 * split is a horizontal one and that halves a terminal's rows.
 *
 * Single row. It ran as two rows first, which quietly reintroduced
 * the thing he could not work in: *"i kind of cant use a height lowered view"*. A terminal is
 * height-sensitive in a way it is not width-sensitive, halving the rows halves the scrollback you
 * can see and makes Claude's TUI reflow, so the scroller now gives every column the full height
 * and spends width instead. On a screen too narrow for two columns it degrades into exactly the
 * thing he described: one full-size terminal, scroll sideways for the next.
 *
 * The real question is attachment, not layout. Every visible panel is a live xterm AND a live
 * tmux client, so we cannot attach all of them. This attaches what is in view and detaches what
 * has been scrolled away for GRACE_MS: the grace is what stops a flick past a column from
 * churning an attach/detach pair. Detaching is not free on the server side; the grace period is
 * the finding, not the layout.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import { TerminalView } from "./TerminalView";
import { EmptyPanel } from "./EmptyPanel";
import { ScrollRail } from "./ScrollRail";
import { MAX_PANELS, type Cell } from "../lib/splitCells";

/** How long a panel stays attached after scrolling out of view. */
const GRACE_MS = 20_000;
/** A column's minimum width: below this a terminal stops being readable. */
const COL_MIN = "38rem";

/**
 * Is this panel actually on screen right now?
 *
 * IntersectionObserver reports CHANGES, and its first report for a node can land while the grid
 * is still laying out: a panel that is plainly visible gets reported as not intersecting, and
 * since nothing changes afterwards no correction ever arrives. (Seen in the first browser run:
 * column 1 detached itself while sitting in full view.) So geometry is checked directly before
 * any detach actually happens; the observer stays as the cheap trigger.
 */
function onScreen(el: HTMLElement, root: HTMLElement): boolean {
  const a = el.getBoundingClientRect();
  const b = root.getBoundingClientRect();
  if (a.width === 0 || a.height === 0) return false;
  const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return overlap > a.width * 0.25;
}

export function SplitScroller({
  cells,
  focusId,
  onFocus,
  onClose,
  onAdd,
  onDropProject,
}: {
  cells: Cell[];
  focusId: number;
  onFocus: (id: number) => void;
  onClose: (id: number) => void;
  onAdd: () => void;
  onDropProject: (id: number, project: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<number, HTMLElement>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Panels currently holding a terminal. Starts with the focused one so the layout never opens
  // with nothing attached, whatever the observer decides on its first pass.
  const [attached, setAttached] = useState<Set<number>>(() => new Set([focusId]));
  // Read by the observer, which must NOT be rebuilt every time focus moves.
  const focusRef = useRef(focusId);
  focusRef.current = focusId;

  // The focused panel is attached unconditionally, scrolling it out of view must not pull the
  // terminal out from under the keyboard. (Done-when: "the focused panel survives scrolling".)
  useEffect(() => {
    setAttached((prev) => (prev.has(focusId) ? prev: new Set(prev).add(focusId)));
    const timer = timers.current.get(focusId);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(focusId);
    }
  }, [focusId]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const timersNow = timers.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.cell);
          if (!Number.isInteger(id)) continue;
          const pending = timersNow.get(id);
          if (entry.isIntersecting) {
            // Coming into view: attach now, and cancel any pending detach, this is the
            // scroll-back case the grace period exists for.
            if (pending) {
              clearTimeout(pending);
              timersNow.delete(id);
            }
            setAttached((prev) => (prev.has(id) ? prev: new Set(prev).add(id)));
          } else if (!pending && id !== focusRef.current) {
            // The focused panel is never scheduled for detach, scrolling it off screen must not
            // pull the terminal out from under the keyboard. (First browser run did exactly that:
            // the effect below only fires when focus MOVES, so it couldn't cancel a detach
            // scheduled afterwards.)
            timersNow.set(
              id,
              setTimeout(() => {
                timersNow.delete(id);
                if (id === focusRef.current) return; // focus arrived while the grace ran
                const node = nodes.current.get(id);
                // Last word goes to geometry, not to a report from GRACE_MS ago.
                if (node && scrollRef.current && onScreen(node, scrollRef.current)) return;
                setAttached((prev) => {
                  if (!prev.has(id)) return prev;
                  const next = new Set(prev);
                  next.delete(id);
                  return next;
                });
              }, GRACE_MS),
            );
          }
        }
      },
      // Against the scroller itself, not the viewport: a column counts as "in view" once a
      // quarter of it is showing, so a half-scrolled panel is already live.
      { root, threshold: 0.25 },
    );
    for (const node of nodes.current.values()) observer.observe(node);
    // One geometry sweep on (re)layout: whatever is on screen is attached immediately, so a
    // freshly added column never waits for a scroll to come alive.
    setAttached((prev) => {
      const next = new Set(prev);
      for (const [id, node] of nodes.current) if (onScreen(node, root)) next.add(id);
      return next.size === prev.size ? prev: next;
    });
    return () => {
      observer.disconnect();
      for (const t of timersNow.values()) clearTimeout(t);
      timersNow.clear();
    };
  }, [cells.length]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={scrollRef}
        className="rail-scroll grid min-h-0 flex-1 grid-flow-col grid-rows-1 gap-2 overflow-x-auto overflow-y-hidden"
        style={{ gridAutoColumns: `minmax(${COL_MIN}, 1fr)` }}
      >
        {cells.map((cell) => {
          const focused = cell.id === focusId;
          const live = attached.has(cell.id);
          return (
            <div
              key={cell.id}
              data-cell={cell.id}
              ref={(el) => {
                if (el) nodes.current.set(cell.id, el);
                else nodes.current.delete(cell.id);
              }}
              onMouseDownCapture={() => onFocus(cell.id)}
              onFocusCapture={() => onFocus(cell.id)}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const name = e.dataTransfer.getData("text/plain");
                if (name) onDropProject(cell.id, name);
              }}
              className={`flex min-h-0 min-w-0 flex-col gap-1 rounded-xl border p-1 transition-colors ${
                focused ? "border-accent bg-accent/5": "border-transparent hover:border-line"
              }`}
            >
              <div className="flex items-center gap-2 px-1">
                <span className={`h-3.5 w-0.5 shrink-0 rounded-full ${focused ? "bg-accent": "bg-line"}`} />
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-xs ${
                    focused ? "font-semibold text-accent": "text-faint"
                  }`}
                >
                  {cell.project === undefined ? "empty": (cell.project ?? "master")}
                </span>
                {/* The honest bit of the prototype: you can see which panels hold a terminal. */}
                {cell.project !== undefined && !live && (
                  <span className="shrink-0 rounded bg-line/60 px-1 text-[9px] uppercase tracking-wider text-faint">
                    detached
                  </span>
                )}
                <button
                  onClick={() => onClose(cell.id)}
                  title="Close panel"
                  aria-label="Close panel"
                  className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-raised hover:text-ink"
                >
                  <X size={12} weight="bold" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {cell.project === undefined ? (
                  <EmptyPanel focused={focused} />
                ): live ? (
                  <TerminalView key={cell.project ?? "master"} project={cell.project} autoFocus={focused} />
                ): (
                  <div className="grid h-full place-items-center rounded-xl border border-dashed border-line px-3 text-center text-xs text-faint">
                    Scrolled away: reattaches when you come back
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* The bar that moves the workspace. Ours, not the browser's, see ScrollRail. */}
      <ScrollRail targetRef={scrollRef} />

      {/*
        The status line scrolls the layout too. The
        wheel handler lives HERE and not on the grid on purpose: over a column the wheel belongs to
        that terminal's scrollback, and hijacking it would cost you the thing you scroll most.
      */}
      <div
        onWheel={(e) => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollLeft += e.deltaY || e.deltaX;
        }}
        className="flex shrink-0 cursor-ew-resize items-center gap-2 px-1 text-[10px] text-faint"
      >
        {/* Was "scroller (experiment)" until the flag went and this became the
            only split layout. A label calling the thing you are using an experiment is a lie. */}
        <span className="font-mono uppercase tracking-wider">warren</span>
        {/* Count only panels that HOLD something, an empty column is attached to nothing, and
            counting it made the footer read "4 of 2". */}
        <span>
          {cells.filter((c) => c.project !== undefined && attached.has(c.id)).length} of{" "}
          {cells.filter((c) => c.project !== undefined).length} attached · scroll sideways for the
          rest
        </span>
        {cells.length < MAX_PANELS && (
          <button
            onClick={onAdd}
            title="Add panel"
            aria-label="Add panel"
            className="ml-auto flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={12} weight="bold" /> panel
          </button>
        )}
      </div>
    </div>
  );
}
