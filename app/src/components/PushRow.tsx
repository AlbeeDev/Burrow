/**
 * The strip of things Claude has handed you in this session.
 *
 * From first live use of the image push: *"too hard to see where to click, it's way
 * too small... accessibility is at 0 as ur skill."* Fair, the entry point was a 14px glyph with a
 * number, in a header that already holds nine controls, and the only reason you found it is that
 * you knew it was coming.
 *
 * His design, and it settles the layout: the header expands downward by exactly one row, only
 * while Claude has attached something, and that row belongs to pushed items and nothing else. It
 * sits inside the header, which belongs to the SESSION rather than to a panel, so in split view
 * the strip is above the grid and doesn't fight it. That is why this beats a floating box.
 *
 * Three rules it has to keep:
 *  - Zero height when empty. A permanently visible strip taxes every session that never uses
 *    the feature. It renders nothing until the first item lands.
 *  - Items with a KIND, not images. Push v2 already carries markdown, video, audio, PDFs and
 *    pages, so the tile picks its own preview and the row never needs rebuilding per type.
 *  - A real hit target. Each tile is a button with a label, tab-reachable, Enter/Space opens
 *    it: the thing the original entry point got wrong.
 */
import { FileHtml, FileMd, FilePdf, ImageSquare, MusicNotes } from "@phosphor-icons/react";
import { pushUrl, type PushedItem } from "../lib/gateway";
import type { PushFeed } from "../lib/usePushes";

/**
 * A preview per KIND, not per image. Images show themselves and video shows a real frame (the
 * `#t=0.1` fragment tells the browser to seek there while only fetching metadata, the ranged
 * route is what makes that cheap). Everything else gets its kind's glyph: the filename sits
 * directly underneath, so a "first heading" thumbnail for markdown would mostly restate it.
 */
function Thumb({ item }: { item: PushedItem }) {
  switch (item.kind) {
    case "image":
      return <img src={pushUrl(item)} alt="" loading="lazy" className="size-full object-cover" />;
    case "video":
      return (
        <video
          src={`${pushUrl(item)}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          className="size-full object-cover"
        />
      );
    case "markdown":
      return <FileMd size={20} weight="regular" className="text-muted" />;
    case "pdf":
      return <FilePdf size={20} weight="regular" className="text-muted" />;
    case "html":
      return <FileHtml size={20} weight="regular" className="text-muted" />;
    case "audio":
      return <MusicNotes size={20} weight="regular" className="text-muted" />;
    default:
      return <ImageSquare size={20} weight="regular" className="text-muted" />;
  }
}

const KIND_WORD: Record<PushedItem["kind"], string> = {
  image: "image",
  markdown: "markdown file",
  video: "video",
  audio: "audio file",
  pdf: "PDF",
  html: "page",
};

export function PushRow({ feed }: { feed: PushFeed }) {
  const { items, show } = feed;
  if (items.length === 0) return null; // zero height in a session that has received nothing

  return (
    <div className="border-t border-line px-4 py-2">
      <ul
        aria-label="Files Claude showed you"
        className="flex items-start gap-1.5 overflow-x-auto"
      >
        {items.map((item, i) => (
          <li key={item.id} className="shrink-0">
            <button
              onClick={() => show(i)}
              title={`${item.name}${item.caption ? `: ${item.caption}`: ""}`}
              aria-label={`Open ${item.name}, ${KIND_WORD[item.kind] ?? item.kind} Claude showed you`}
              className="group flex w-[72px] flex-col items-center gap-1 rounded-lg p-1 hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              <span className="grid size-11 place-items-center overflow-hidden rounded-md border border-line bg-bg group-hover:border-accent/50">
                <Thumb item={item} />
              </span>
              <span className="w-full truncate text-center text-[10px] leading-tight text-muted group-hover:text-ink">
                {item.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
