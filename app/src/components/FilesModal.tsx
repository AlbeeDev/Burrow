import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Folder,
  File as FileIcon,
  UploadSimple,
  DownloadSimple,
  CaretRight,
  House,
  Spinner,
} from "@phosphor-icons/react";
import { fileUrl } from "../lib/gateway";

type Entry = { name: string; type: "file" | "dir"; size: number };

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Per-project file manager: browse, download, and upload files within a single project's
 * directory. Everything is bounded server-side to that project's folder. Uses the HTTP file
 * bridge (`/files/*`) rather than the WebSocket, since up/download are binary.
 */
export function FilesModal({ project, onClose }: { project: string; onClose: () => void }) {
  const [path, setPath] = useState(""); // relative dir within the project ("" = root)
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (dir: string) => {
      setLoading(true);
      setError(null);
      fetch(fileUrl("/files/list", { project, path: dir }))
.then((r) => (r.ok ? r.json(): Promise.reject(new Error(`list failed (${r.status})`))))
.then((data: { path: string; entries: Entry[] }) => {
          setEntries(data.entries);
          setPath(data.path);
        })
.catch((e) => setError(e.message))
.finally(() => setLoading(false));
    },
    [project],
  );

  useEffect(() => load(""), [load]);

  const relOf = (name: string) => (path ? `${path}/${name}`: name);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading({ done: 0, total: list.length });
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      try {
        await fetch(fileUrl("/files/upload", { project, path, name: f.name }), {
          method: "POST",
          body: f,
        });
      } catch {
        /* keep going; a failed one just won't appear */
      }
      setUploading({ done: i + 1, total: list.length });
    }
    setUploading(null);
    load(path);
  }

  const crumbs = path ? path.split("/"): [];

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        data-tour="files-modal"
        className="flex h-[75vh] max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Folder size={18} weight="fill" className="text-accent" />
            <div>
              <h2 className="text-base font-semibold text-ink">Files</h2>
              <p className="text-xs text-faint">Browse, download &amp; upload, {project} only.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-4 py-2 text-xs">
          <button
            onClick={() => load("")}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-muted hover:bg-raised hover:text-ink"
          >
            <House size={13} weight="bold" /> {project}
          </button>
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <CaretRight size={11} className="text-faint" />
              <button
                onClick={() => load(crumbs.slice(0, i + 1).join("/"))}
                className="rounded px-1.5 py-0.5 font-mono text-muted hover:bg-raised hover:text-ink"
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        {/* Listing */}
        <div className="relative min-h-0 flex-1 overflow-y-auto p-2">
          {dragOver && (
            <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
              Drop to upload here
            </div>
          )}
          {loading ? (
            <div className="grid place-items-center py-10 text-faint">
              <Spinner size={22} className="animate-spin" />
            </div>
          ): error ? (
            <p className="p-4 text-sm text-danger">{error}</p>
          ): entries.length === 0 ? (
            <p className="p-4 text-sm text-faint">Empty folder. Drag files in or use Upload.</p>
          ): (
            entries.map((e) =>
              e.type === "dir" ? (
                <button
                  key={e.name}
                  onClick={() => load(relOf(e.name))}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-raised"
                >
                  <Folder size={17} weight="fill" className="shrink-0 text-accent/80" />
                  <span className="flex-1 truncate font-mono text-sm text-ink">{e.name}</span>
                  <CaretRight size={13} className="shrink-0 text-faint" />
                </button>
              ): (
                <a
                  key={e.name}
                  href={fileUrl("/files/download", { project, path: relOf(e.name) })}
                  download={e.name}
                  className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-raised"
                >
                  <FileIcon size={17} weight="regular" className="shrink-0 text-muted" />
                  <span className="flex-1 truncate font-mono text-sm text-ink">{e.name}</span>
                  <span className="shrink-0 text-[11px] text-faint">{fmtSize(e.size)}</span>
                  <DownloadSimple
                    size={15}
                    weight="bold"
                    className="shrink-0 text-faint group-hover:text-accent"
                  />
                </a>
              ),
            )
          )}
        </div>

        {/* Footer: upload */}
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <span className="text-xs text-faint">
            {uploading
              ? `Uploading ${uploading.done}/${uploading.total}…`: `${entries.filter((e) => e.type === "file").length} files · ${entries.filter((e) => e.type === "dir").length} folders`}
          </span>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={!!uploading}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            <UploadSimple size={15} weight="bold" /> Upload
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
