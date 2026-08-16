/**
 * The surface for things Claude pushes (`show` on the `burrow` MCP server).
 *
 * A lightbox rather than an inline chat block, because this has to work in BOTH modes and the
 * terminal has no message stream to render into. It opens by itself when something arrives for
 * the project you're looking at, and the header button reopens the recent ones.
 *
 * v2 renders by KIND. Every viewer points at the same `/push/<id>/<name>` URL, the gateway
 * streams it with Range support, which is what lets video and audio seek instead of buffering a
 * base64 blob that never could.
 */
import { useEffect, useRef, useState } from "react";
import { CaretLeft, CaretRight, DownloadSimple, X } from "@phosphor-icons/react";
import type { PushFeed } from "../lib/usePushes";
import { pushUrl, type PushedItem } from "../lib/gateway";
import { Markdown } from "./Markdown";

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function Failed({ name, why }: { name: string; why: string }) {
  return (
    <p className="m-auto max-w-md text-center text-sm text-muted">
      <span className="font-mono text-ink">{name}</span> {why}.
    </p>
  );
}

/** Markdown arrives as text, so it is the one kind that needs fetching rather than an element. */
function MarkdownView({ item }: { item: PushedItem }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    fetch(pushUrl(item))
.then((r) => (r.ok ? r.text(): Promise.reject(new Error(`HTTP ${r.status}`))))
.then((t) => live && setText(t))
.catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [item]);

  if (error) return <Failed name={item.name} why={`could not be read (${error})`} />;
  if (text === null) return <p className="m-auto text-sm text-muted">Loading {item.name}…</p>;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="mx-auto h-full w-full max-w-3xl overflow-y-auto rounded-lg bg-surface p-5 text-left"
      /* The one width cap that is a real decision rather than an arbitrary number: prose past
         ~80 characters a line is measurably harder to read, so markdown keeps a measure. */
    >
      {/*
        `Markdown` is react-markdown WITHOUT rehype-raw, so HTML embedded in the document renders
        as text rather than as markup. That is the requirement, not an accident: a markdown push
        that could smuggle HTML would be the HTML case with none of its protections, it would run
        in Burrow's own origin, where the admin key lives in localStorage.
      */}
      <Markdown>{text}</Markdown>
    </div>
  );
}

/** One viewer per kind. Everything but markdown is an element pointed at the ranged route. */
function Viewer({ item }: { item: PushedItem }) {
  const src = pushUrl(item);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  switch (item.kind) {
    case "image":
      return (
        <img
          src={src}
          alt={item.caption || item.name}
          onClick={stop}
          className="mx-auto max-h-full min-h-0 max-w-full rounded-lg object-contain"
        />
      );
    case "video":
      return (
        <video
          src={src}
          controls
          onClick={stop}
          className="mx-auto max-h-full min-h-0 max-w-full rounded-lg bg-black"
        />
      );
    case "audio":
      return (
        <div onClick={stop} className="m-auto w-full max-w-lg rounded-xl bg-surface p-5">
          <p className="mb-3 truncate text-center font-mono text-sm text-ink">{item.name}</p>
          <audio src={src} controls className="w-full" />
        </div>
      );
    case "pdf":
      // The browser's own PDF viewer, fed by the ranged route so it can fetch the cross-reference
      // table off the end of the file instead of downloading everything first. FULL WIDTH on
      // purpose: a PDF page has its own aspect ratio and the viewer fits it, capping the frame
      // (it was max-w-4xl) just made the page smaller for no reason. Same for the HTML case below.
      return (
        <iframe
          src={src}
          title={item.name}
          onClick={stop}
          className="h-full w-full rounded-lg bg-white"
        />
      );
    case "html":
      /*
       * SANDBOXED, and specifically WITHOUT `allow-same-origin`. The page was written by a model,
       * and Burrow's own origin holds the admin key in localStorage plus the live gateway socket.
       * `allow-scripts` alone lets the page be itself; adding allow-same-origin alongside it would
       * let the page reach straight back into the app, the two together are equivalent to no
       * sandbox at all.
       */
      return (
        <iframe
          src={src}
          title={item.name}
          sandbox="allow-scripts allow-popups allow-forms"
          onClick={stop}
          className="h-full w-full rounded-lg bg-white"
        />
      );
    case "markdown":
      return <MarkdownView item={item} />;
    default:
      return <Failed name={item.name} why="is a kind this version of Burrow cannot display" />;
  }
}

export function PushLightbox({ feed }: { feed: PushFeed }) {
  const { items, index, open, close, step } = feed;
  const item = items[index];
  const surface = useRef<HTMLDivElement>(null);

  // Take focus off the terminal. xterm owns every keystroke while its textarea has focus, so
  // without this the arrow keys go to the shell underneath instead of stepping through items.
  useEffect(() => {
    if (open) surface.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, step]);

  if (!open || !item) return null;

  return (
    // Near-opaque: the app header sits directly under this bar, and a translucent overlay let
    // the two rows of text collide into each other.
    <div
      ref={surface}
      tabIndex={-1}
      role="dialog"
      aria-label={`${item.kind} from Claude: ${item.name}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 p-4 outline-none"
      onClick={close}
    >
      <div className="flex shrink-0 items-center gap-2 rounded-xl bg-surface/70 px-3 py-2 text-xs text-muted">
        <span className="truncate font-mono text-ink">{item.name}</span>
        <span className="shrink-0 rounded bg-raised px-1 uppercase tracking-wide">{item.kind}</span>
        <span className="shrink-0">{fmtSize(item.size)}</span>
        <span className="shrink-0">{new Date(item.at).toLocaleTimeString()}</span>
        <div className="ml-auto flex items-center gap-1">
          {items.length > 1 && (
            <span className="px-1 tabular-nums">
              {index + 1} / {items.length}
            </span>
          )}
          <a
            href={pushUrl(item)}
            download={item.name}
            onClick={(e) => e.stopPropagation()}
            title="Save this file"
            aria-label="Save this file"
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/10 hover:text-ink"
          >
            <DownloadSimple size={17} weight="bold" />
          </a>
          <button
            onClick={close}
            title="Close (Esc)"
            aria-label="Close"
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-white/10 hover:text-ink"
          >
            <X size={17} weight="bold" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center gap-2 pt-3">
        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              step(-1);
            }}
            disabled={index === 0}
            aria-label="Previous item"
            className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-white/10 hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
          >
            <CaretLeft size={20} weight="bold" />
          </button>
        )}
        <Viewer item={item} />
        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              step(1);
            }}
            disabled={index === items.length - 1}
            aria-label="Next item"
            className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-white/10 hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
          >
            <CaretRight size={20} weight="bold" />
          </button>
        )}
      </div>

      {item.caption && <p className="shrink-0 pt-3 text-center text-sm text-ink">{item.caption}</p>}
    </div>
  );
}
