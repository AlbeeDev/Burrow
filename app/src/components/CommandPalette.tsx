import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MagnifyingGlass, Folder, ChatText, CaretDown, CaretRight } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";

type Hit = { project: string; snippet: string; when: number; full: string; truncated: boolean };
type Row = { type: "project"; project: string } | ({ type: "hit" } & Hit);

/**
 * The expanded message with the query marked, because ±60 characters was too little to judge a
 * hit but 4000 unmarked ones are a wall.
 */
function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded bg-accent/25 text-ink">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/** "3d ago" / "Jul 12": enough to tell an old session from today's. */
function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Cmd-K palette: fuzzy project jump + full-text search across every project's session
 * histories (server-side `search.history`). Enter/click opens the row's project.
 */
export function CommandPalette({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (project: string) => void;
}) {
  const { gateway, projects } = useGateway();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [coverage, setCoverage] = useState<{ scanned: number; total: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [sel, setSel] = useState(0);
  // One hit open at a time (by row index): the point is to read THIS match, and an accordion
  // keeps arrow-key navigation through the list predictable.
  const [openHit, setOpenHit] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const projectRows: Row[] = projects
.filter((p) => !q || p.name.toLowerCase().includes(q))
.slice(0, 8)
.map((p) => ({ type: "project", project: p.name }));
  const rows: Row[] = [...projectRows, ...hits.map((h) => ({ type: "hit" as const, ...h }))];

  // Debounced history search; results only apply if the query hasn't moved on.
  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      setCoverage(null);
      return;
    }
    const t = setTimeout(() => {
      setSearching(true);
      gateway
.req<{ hits: Hit[]; scanned: number; total: number }>("search.history", { query: q })
.then((r) => {
          setHits(r.hits ?? []);
          setCoverage({ scanned: r.scanned ?? 0, total: r.total ?? 0 });
        })
.catch(() => {
          setHits([]);
          setCoverage(null);
        })
.finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [gateway, q]);

  useEffect(() => {
    setSel(0);
    setOpenHit(null); // a new query means new rows; index-keyed expansion must not carry over
  }, [q]);
  useEffect(() => inputRef.current?.focus(), []);

  function pick(row: Row | undefined) {
    if (!row) return;
    onSelect(row.project);
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center bg-black/70 p-4 pt-[12vh]" onClick={onClose}>
      <div
        data-tour="search-modal"
        className="flex h-fit max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <MagnifyingGlass size={16} weight="bold" className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(rows.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "ArrowRight") {
                if (rows[sel]?.type === "hit") {
                  e.preventDefault();
                  setOpenHit(sel);
                }
              } else if (e.key === "ArrowLeft") {
                if (openHit !== null) {
                  e.preventDefault();
                  setOpenHit(null);
                }
              } else if (e.key === "Enter") pick(rows[sel]);
            }}
            placeholder="Jump to a project or search all chats…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint">esc</kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-faint">
              {q.length >= 2 ? "No matches.": "Type to filter projects, 2+ characters searches chat history."}
            </p>
          )}
          {rows.map((row, i) => {
            const open = row.type === "hit" && openHit === i;
            return (
              <div
                key={row.type === "project" ? `p:${row.project}`: `h:${i}`}
                className={`rounded-lg ${i === sel ? "bg-raised": ""}`}
              >
                <div className="flex w-full items-start gap-2.5 px-2.5 py-2">
                  <button
                    onClick={() => pick(row)}
                    onMouseEnter={() => setSel(i)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                  >
                    {row.type === "project" ? (
                      <>
                        <Folder size={16} weight="bold" className="mt-0.5 shrink-0 text-accent" />
                        <span className="truncate font-mono text-sm text-ink">{row.project}</span>
                      </>
                    ): (
                      <>
                        <ChatText size={16} weight="bold" className="mt-0.5 shrink-0 text-muted" />
                        <span className="min-w-0">
                          <span className="block font-mono text-xs text-accent">{row.project}</span>
                          <span className={`block text-xs text-muted ${open ? "": "truncate"}`}>
                            {row.snippet}
                          </span>
                        </span>
                        <span className="ml-auto shrink-0 self-center text-[10px] text-faint">
                          {ago(row.when)}
                        </span>
                      </>
                    )}
                  </button>
                  {row.type === "hit" && (
                    <button
                      onClick={() => {
                        setSel(i);
                        setOpenHit(open ? null: i);
                        inputRef.current?.focus(); // keep arrow keys live after a mouse expand
                      }}
                      aria-expanded={open}
                      aria-label={open ? "Collapse message": "Show the full message"}
                      title={open ? "Collapse": "Show the full message"}
                      className="grid size-6 shrink-0 place-items-center self-center rounded text-faint hover:bg-bg hover:text-ink"
                    >
                      {open ? <CaretDown size={13} weight="bold" />: <CaretRight size={13} weight="bold" />}
                    </button>
                  )}
                </div>
                {open && (
                  // Clamped and independently scrollable: a 4000-character message must not
                  // push the rest of the results out of the palette.
                  <div className="mx-2.5 mb-2 max-h-56 overflow-y-auto rounded-lg border border-line bg-bg px-2.5 py-2">
                    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
                      <Marked text={row.full} needle={q} />
                    </p>
                    {row.truncated && (
                      <p className="mt-1.5 text-[10px] text-faint">
                        Message truncated: open the project to read the rest.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {coverage && q.length >= 2 && (
          <div className="border-t border-line px-4 py-1.5 text-[11px] text-faint">
            {searching
              ? "Searching…": coverage.scanned >= coverage.total
                ? `Searched all ${coverage.total} sessions.`: `Searched the ${coverage.scanned} most recent of ${coverage.total} sessions, refine the query to go deeper.`}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
