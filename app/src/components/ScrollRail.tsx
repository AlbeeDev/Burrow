/**
 * The layout scroller's scroll bar, drawn by us instead of by the browser.
 *
 * Why not a native scrollbar: it needs to be three or four times
 * thicker, and neither CSS attempt moved it for him. `:-webkit-scrollbar` is Chrome/Safari-only,
 * and Firefox's `scrollbar-width` accepts nothing but `thin` / `auto` / `none`, so on Firefox a
 * fat scrollbar is simply not expressible. This is a div, so it is the same size everywhere.
 *
 * It is also the primary control here rather than an afterthought: it moves the whole workspace,
 * and it sits in the strip below the columns that was otherwise only holding a status line.
 *
 * The element keeps scrolling natively (wheel, trackpad, keyboard), this reads that scroll
 * position and writes it back on drag. It never becomes the source of truth, so nothing desyncs.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How thick the bar is. Sized as a primary control, not as chrome: on a wide (or multi-monitor)
 * setup this is how you move between windows all day, so it should be the easiest thing on screen
 * to hit: it has to be the most accessible thing on the page.
 */
const RAIL_H = 40;
/** Never shrink the thumb below this, or a long layout leaves nothing to aim at. */
const THUMB_MIN = 80;

export function ScrollRail({ targetRef }: { targetRef: React.RefObject<HTMLDivElement | null> }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState({ left: 0, view: 1, total: 1 });
  const [dragging, setDragging] = useState(false);

  // Mirror the element's scroll geometry. Driven by its own scroll event plus a ResizeObserver,
  // so adding or closing a column resizes the thumb without anyone scrolling.
  const sync = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    setGeom({ left: el.scrollLeft, view: el.clientWidth, total: el.scrollWidth });
  }, [targetRef]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [targetRef, sync]);

  const scrollable = geom.total - geom.view;
  // Nothing to scroll: render the rail anyway, full width and inert. Showing and hiding it as
  // columns come and go would make the layout jump by its own height.
  const ratio = scrollable > 0 ? geom.view / geom.total: 1;

  /** Put the thumb's CENTRE at a client-x, and scroll the element to match. */
  const seek = useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      const el = targetRef.current;
      if (!rail || !el || scrollable <= 0) return;
      const box = rail.getBoundingClientRect();
      const thumb = Math.max(THUMB_MIN, box.width * ratio);
      // The thumb's travel is shorter than the rail by its own width, without this the last
      // stretch of the layout is unreachable by dragging.
      const travel = box.width - thumb;
      if (travel <= 0) return;
      const x = clientX - box.left - thumb / 2;
      el.scrollLeft = (Math.min(travel, Math.max(0, x)) / travel) * scrollable;
    },
    [targetRef, scrollable, ratio],
  );

  // Drag continues outside the rail: releasing over a terminal must still end the drag, which is
  // why these listeners go on the window rather than on the element.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => seek(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging, seek]);

  const pct = scrollable > 0 ? geom.left / scrollable: 0;

  return (
    <div
      ref={railRef}
      onPointerDown={(e) => {
        if (scrollable <= 0) return;
        e.preventDefault(); // don't let the press steal focus from the terminal you were typing in
        setDragging(true);
        seek(e.clientX); // click anywhere on the rail jumps there, as a scrollbar track does
      }}
      onWheel={(e) => {
        const el = targetRef.current;
        if (el) el.scrollLeft += e.deltaY || e.deltaX;
      }}
      style={{ height: RAIL_H }}
      className={`relative w-full shrink-0 overflow-hidden rounded-full bg-raised ${
        scrollable > 0 ? "cursor-grab": "opacity-40"
      } ${dragging ? "cursor-grabbing": ""}`}
      role="scrollbar"
      aria-label="Scroll the layout sideways"
      aria-orientation="horizontal"
      aria-valuenow={Math.round(pct * 100)}
    >
      <div
        style={{
          width: `max(${THUMB_MIN}px, ${ratio * 100}%)`,
          left: `calc((100% - max(${THUMB_MIN}px, ${ratio * 100}%)) * ${pct})`,
        }}
        className={`absolute inset-y-0 rounded-full transition-colors ${
          dragging ? "bg-accent": "bg-line hover:bg-accent/60"
        }`}
      />
    </div>
  );
}
