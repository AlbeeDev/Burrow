import { useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { X, Plus, DotsThreeVertical, PencilSimple, Trash, Palette } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import type { Project } from "../lib/gateway";

// Swatches for the group color picker (custom hex also available via the color input).
const PALETTE = [
  "#f2792b", "#e0a94b", "#c9702b", "#d0644f", "#8fae5f", "#5fb8ad",
  "#c98bd0", "#b5814f", "#e5604d", "#6ea9d6", "#7fd89a", "#ffc76b",
];

/**
 * Groups board: one colored lane per group plus an "Ungrouped" lane. Drag chats between
 * lanes (or tap to move), rename/recolor/delete a group inline, and delete a project (soft
 *: moves to trash). Every action persists immediately. The board scrolls horizontally with
 * the wheel. Groups are labels only; project delete moves the real folder to ~/.burrow/trash.
 */
export function GroupsModal({ onClose }: { onClose: () => void }) {
  const { gateway, projects, groups, assignments, refresh, assignProject, activeSessions, colorOf, groupColors, setGroupColor, deleteProject } =
    useGateway();
  const [newGroup, setNewGroup] = useState("");

  // Auto-scroll the board while dragging a chip near its left/right edge, so you can reach
  // lanes that are off-screen when there are more groups than fit the window.
  const boardRef = useRef<HTMLDivElement>(null);
  const scrollDir = useRef(0); // -1 left, +1 right, 0 idle
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = boardRef.current;
      if (el && scrollDir.current) el.scrollLeft += scrollDir.current * 14;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  function onBoardDragOver(e: DragEvent) {
    const el = boardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const EDGE = 90;
    scrollDir.current = e.clientX < rect.left + EDGE ? -1: e.clientX > rect.right - EDGE ? 1: 0;
  }
  const stopAutoScroll = () => {
    scrollDir.current = 0;
  };

  function persist(
    nextGroups: string[],
    nextAssign: Record<string, string>,
  ) {
    const body: Record<string, unknown> = {
      groups: nextGroups,
      assignments: nextAssign,
      colors: groupColors,
    };
    gateway.req("groups.set", body).then(refresh).catch(() => {});
  }

  function addGroup() {
    const name = newGroup.trim();
    setNewGroup("");
    if (!name || groups.includes(name)) return;
    persist([...groups, name], assignments);
  }

  function renameGroup(oldName: string, raw: string) {
    const name = raw.trim();
    if (!name || (name !== oldName && groups.includes(name))) return;
    const nextGroups = groups.map((g) => (g === oldName ? name: g));
    const nextAssign: Record<string, string> = {};
    for (const [p, g] of Object.entries(assignments)) nextAssign[p] = g === oldName ? name: g;
    persist(nextGroups, nextAssign);
  }

  function deleteGroup(name: string) {
    const nextGroups = groups.filter((g) => g !== name);
    const nextAssign: Record<string, string> = {};
    for (const [p, g] of Object.entries(assignments)) if (g !== name) nextAssign[p] = g;
    persist(nextGroups, nextAssign);
  }

  const membersOf = (group: string | null) =>
    projects.filter((p) =>
      group === null ? !groups.includes(assignments[p.name] ?? ""): assignments[p.name] === group,
    );

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        data-tour="groups-modal"
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">Organize groups</h2>
            <p className="text-xs text-faint">Drag chats between lanes, recolor a group via its ⋮ menu, delete a project via its chip. Scroll sideways with the wheel.</p>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="border-b border-line px-5 py-3">
          <div className="flex items-center gap-2">
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addGroup()}
              placeholder="New group name…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
            <button
              onClick={addGroup}
              disabled={!newGroup.trim()}
              className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
            >
              <Plus size={14} weight="bold" /> Add group
            </button>
          </div>
        </div>

        {/* The board: wheel scrolls it sideways; dragging near an edge auto-scrolls it. */}
        <div
          ref={boardRef}
          className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4"
          onWheel={(e) => {
            e.currentTarget.scrollLeft += e.deltaY;
          }}
          onDragOver={onBoardDragOver}
          onDragLeave={stopAutoScroll}
          onDrop={stopAutoScroll}
        >
          {groups.map((g) => (
            <Lane
              key={g}
              name={g}
              color={colorOf(g)}
              members={membersOf(g)}
              groups={groups}
              activeSessions={activeSessions}
              onDropProject={(proj) => assignProject(proj, g)}
              onMove={(proj, to) => assignProject(proj, to)}
              onRename={(raw) => renameGroup(g, raw)}
              onDelete={() => deleteGroup(g)}
              onSetColor={(c) => setGroupColor(g, c)}
              onDeleteProject={deleteProject}
            />
          ))}
          <Lane
            name="Ungrouped"
            color={null}
            members={membersOf(null)}
            groups={groups}
            activeSessions={activeSessions}
            onDropProject={(proj) => assignProject(proj, null)}
            onMove={(proj, to) => assignProject(proj, to)}
            onDeleteProject={deleteProject}
          />
          {groups.length === 0 && (
            <div className="grid flex-1 place-items-center px-6 text-center text-sm text-faint">
              Add a group above, then drag chats into it.
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Lane({
  name,
  color,
  members,
  groups,
  activeSessions,
  onDropProject,
  onMove,
  onRename,
  onDelete,
  onSetColor,
  onDeleteProject,
}: {
  name: string;
  color: string | null;
  members: Project[];
  groups: string[];
  activeSessions: Set<string>;
  onDropProject: (project: string) => void;
  onMove: (project: string, to: string | null) => void;
  onRename?: (raw: string) => void;
  onDelete?: () => void;
  onSetColor?: (color: string) => void;
  onDeleteProject: (name: string) => Promise<void>;
}) {
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const proj = e.dataTransfer.getData("text/plain");
        if (proj) onDropProject(proj);
      }}
      className={`flex max-h-full w-56 shrink-0 flex-col rounded-xl border bg-bg transition-colors ${
        over ? "border-accent ring-1 ring-accent": "border-line"
      }`}
    >
      <div
        className="flex items-center gap-2 rounded-t-xl px-3 py-2"
        style={color ? { backgroundColor: `${color}22` }: undefined}
      >
        {color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={() => {
              onRename?.(editing);
              setEditing(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename?.(editing);
                setEditing(null);
              }
              if (e.key === "Escape") setEditing(null);
            }}
            className="min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-0.5 text-sm text-ink focus:border-accent focus:outline-none"
          />
        ): (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{name}</span>
        )}
        <span className="text-xs text-faint">{members.length}</span>
        {onRename && (
          <div className="relative">
            <button
              onClick={() => setMenu((m) => !m)}
              className="grid size-6 place-items-center rounded text-muted hover:bg-raised hover:text-ink"
              aria-label={`${name} menu`}
            >
              <DotsThreeVertical size={16} weight="bold" />
            </button>
            {menu && (
              <>
                <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setMenu(false)} />
                <div className="absolute right-0 z-50 mt-1 w-40 rounded-lg border border-line bg-surface p-1 shadow-xl">
                  <button
                    onClick={() => {
                      setEditing(name);
                      setMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-raised"
                  >
                    <PencilSimple size={14} /> Rename
                  </button>
                  <div className="px-2 py-1.5">
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs text-faint">
                      <Palette size={13} /> Color
                    </div>
                    <div className="grid grid-cols-6 gap-1">
                      {PALETTE.map((c) => (
                        <button
                          key={c}
                          onClick={() => onSetColor?.(c)}
                          title={c}
                          className={`size-4 rounded-full ring-offset-1 ring-offset-surface hover:ring-2 hover:ring-ink/40 ${
                            color === c ? "ring-2 ring-ink": ""
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                      <label
                        title="Custom color"
                        className="grid size-4 cursor-pointer place-items-center rounded-full border border-dashed border-faint text-[8px] text-faint"
                      >
                        +
                        <input
                          type="color"
                          className="sr-only"
                          onChange={(e) => onSetColor?.(e.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      onDelete?.();
                      setMenu(false);
                    }}
                    className="flex w-full items-center gap-2 rounded border-t border-line px-2 py-1.5 text-left text-sm text-[#e5604d] hover:bg-raised"
                  >
                    <Trash size={14} /> Delete group
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="min-h-16 flex-1 space-y-1 overflow-y-auto p-2">
        {members.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-faint">Drop chats here</p>
        ): (
          members.map((p) => (
            <Chip
              key={p.name}
              project={p.name}
              color={color}
              live={activeSessions.has(p.name)}
              targets={["__ungrouped__", ...groups].filter((t) => t !== name && !(t === "__ungrouped__" && color === null))}
              onMove={(to) => onMove(p.name, to === "__ungrouped__" ? null: to)}
              onDeleteProject={onDeleteProject}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Chip({
  project,
  color,
  live,
  targets,
  onMove,
  onDeleteProject,
}: {
  project: string;
  color: string | null;
  live: boolean;
  targets: string[];
  onMove: (to: string) => void;
  onDeleteProject: (name: string) => Promise<void>;
}) {
  const { colorOf } = useGateway();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="relative">
      <button
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", project);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => setMenu((m) => !m)}
        className="flex w-full cursor-grab items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left active:cursor-grabbing hover:border-accent/50"
      >
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color ?? "var(--color-line)" }} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{project}</span>
        {live && <span className="size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_5px_#f2792b]" />}
      </button>
      {menu && (
        <>
          <button
            className="fixed inset-0 z-40 cursor-default"
            aria-hidden
            onClick={() => {
              setMenu(false);
              setConfirm(false);
            }}
          />
          <div className="absolute left-0 z-50 mt-1 max-h-60 w-48 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-xl">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-faint">Move to</p>
            {targets.map((t) => (
              <button
                key={t}
                onClick={() => {
                  onMove(t);
                  setMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-raised"
              >
                {t !== "__ungrouped__" && (
                  <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(t) }} />
                )}
                <span className="truncate">{t === "__ungrouped__" ? "Ungrouped": t}</span>
              </button>
            ))}
            <button
              onClick={() => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                onDeleteProject(project)
.then(() => setMenu(false))
.catch((e) => setErr(e instanceof Error ? e.message: "delete failed"));
              }}
              className="mt-0.5 flex w-full items-center gap-2 rounded border-t border-line px-2 py-1.5 text-left text-sm text-[#e5604d] hover:bg-raised"
            >
              <Trash size={14} /> {confirm ? "Confirm, move to trash": "Delete project"}
            </button>
            {err && <p className="px-2 py-1 text-[11px] text-[#e5604d]">{err}</p>}
          </div>
        </>
      )}
    </div>
  );
}
