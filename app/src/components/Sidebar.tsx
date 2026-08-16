import { useEffect, useMemo, useState, type ReactNode, type DragEvent } from "react";
import {
  House,
  Folder,
  MagnifyingGlass,
  ArrowsClockwise,
  Faders,
  GearSix,
  Clock,
  Plus,
  SquaresFour,
  Stack,
  Check,
  X,
  FolderPlus,
  PencilSimple,
  TrashSimple,
} from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import { fmtBytes, isHeavy } from "../lib/sessionStats";
import type { Project } from "../lib/gateway";
import { GroupsModal } from "./GroupsModal";
import { ScheduleModal } from "./ScheduleModal";
import { SettingsModal } from "./SettingsModal";
import { CreateModal } from "./CreateModal";
import { Hint } from "./Hint";
import { TOUR_RESET_EVENT } from "../lib/tour";

// Selection is either everything, one group, or the ungrouped bucket.
type Sel = { kind: "all" } | { kind: "group"; name: string } | { kind: "ungrouped" };

// Display label for saved split layouts. Code calls them splits everywhere; only this string is
// the branding, so renaming it is a one-line change, which it was: they were
// "Warrens" (a rabbit-burrow tunnel system, matching the product name), renamed because the
// obvious problem with naming a feature after a pun. A user should not need a definition before
// they can read the sentence describing the thing.
const SPLITS_LABEL = "Layouts";

export function Sidebar({
  activeProject,
  onSelect,
  activeSplitId,
  onNewSplit,
  onOpenSplit,
  onExitSplit,
}: {
  activeProject: string | null;
  onSelect: (project: string | null) => void;
  // Saved split layouts live here (desktop), this is the split entry point.
  activeSplitId: string | null;
  onNewSplit: () => void;
  onOpenSplit: (id: string) => void;
  onExitSplit: () => void;
}) {
  const { gateway, projects, groups, assignments, status, refresh, activeSessions, masterActive, sessionStats, persistentProjects, assignProject, groupColors, colorOf, deleteProject, schedules, splits, setSplits } =
    useGateway();
  const anyArmed = schedules.some((s) => s.enabled);
  // Only the sessions worth interrupting you about. Everything else stays out of the row.
  const heavyByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessionStats) {
      if (s.project && isHeavy(s.rssBytes)) m.set(s.project, fmtBytes(s.rssBytes));
    }
    return m;
  }, [sessionStats]);
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sel, setSel] = useState<Sel>({ kind: "all" });
  const [newName, setNewName] = useState<string | null>(null); // non-null = inline create group open
  const [newProject, setNewProject] = useState<{ name: string; desc: string } | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const [splitRenaming, setSplitRenaming] = useState<string | null>(null);
  const [splitNameVal, setSplitNameVal] = useState("");

  function commitSplitRename(id: string) {
    const name = splitNameVal.trim();
    setSplitRenaming(null);
    if (!name) return;
    setSplits(splits.map((s) => (s.id === id ? {...s, name }: s)));
  }

  async function doRename(oldName: string) {
    const newName = renameVal.trim();
    if (!newName || newName === oldName) {
      setRenaming(null);
      return;
    }
    try {
      await gateway.req("projects.rename", { name: oldName, newName });
      const wasActive = activeProject === oldName;
      setRenaming(null);
      setRenameErr(null);
      refresh();
      if (wasActive) onSelect(newName);
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message: "Rename failed");
    }
  }

  async function createProjectNow() {
    const np = newProject;
    if (!np || !np.name.trim()) return;
    const name = np.name.trim();
    const targetGroup = sel.kind === "group" ? sel.name: null;
    setProjErr(null);
    setCreating(true);
    try {
      await gateway.req("projects.create", {
        name,
        description: np.desc.trim() || undefined,
        group: targetGroup ?? undefined,
      });
      // The GROUP IS NOT ASSIGNED HERE. `projects.create` records it server-side as part of
      // creating the project: doing it from the client meant a `groups.set` followed immediately
      // by the `refresh()` below, and frames are dispatched concurrently, so the read could come
      // back before the write landed and render the project ungrouped until a reload.
      setNewProject(null);
      onSelect(name); // open the new project (its terminal boots with its own overlay)
      refresh();
    } catch (e) {
      setProjErr(e instanceof Error ? e.message: "Could not create project");
    } finally {
      setCreating(false);
    }
  }

  const isGrouped = (p: Project) => {
    const g = assignments[p.name];
    return g && groups.includes(g);
  };

  const hasUngrouped = useMemo(() => projects.some((p) => !isGrouped(p)), [projects, assignments, groups]);

  // Projects for the current rail selection, then narrowed by the search box.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (sel.kind === "group" && assignments[p.name] !== sel.name) return false;
      if (sel.kind === "ungrouped" && isGrouped(p)) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [projects, assignments, groups, sel, query]);

  // Per-group counts + whether any of its projects has a live session (for the rail).
  const groupMeta = useMemo(() => {
    const m: Record<string, { count: number; active: boolean }> = {};
    for (const g of groups) m[g] = { count: 0, active: false };
    for (const p of projects) {
      const g = assignments[p.name];
      if (g && m[g]) {
        m[g].count++;
        if (activeSessions.has(p.name)) m[g].active = true;
      }
    }
    return m;
  }, [projects, groups, assignments, activeSessions]);

  const title =
    sel.kind === "all" ? "All projects": sel.kind === "ungrouped" ? "Ungrouped": sel.name;
  const titleGroup = sel.kind === "group" ? sel.name: null;

  // Skipping a tour step closes whatever that step had opened. An event rather than a prop
  // because the tour has no handle on this component, and drilling one through for a review-only
  // affordance would cost more than it is worth. See lib/tour.
  useEffect(() => {
    const close = () => {
      setNewName(null);
      setNewProject(null);
    };
    window.addEventListener(TOUR_RESET_EVENT, close);
    return () => window.removeEventListener(TOUR_RESET_EVENT, close);
  }, []);

  async function createGroup() {
    const name = (newName ?? "").trim();
    setNewName(null);
    if (!name || groups.includes(name)) return;
    try {
      await gateway.req("groups.set", { groups: [...groups, name], assignments, colors: groupColors });
      refresh();
      setSel({ kind: "group", name });
    } catch {
      /* ignore */
    }
  }

  return (
    <aside className="flex h-full">
      {/*
        Creating anything happens in a modal rather than inline in this panel. Both of these used
        to expand *inside* the sidebar, which is fine to use and impossible to guide someone
        through, and, during the first-run tour, actually broken: driver.js kills pointer events
        on everything except the element it highlights, so an inline field was unusable. See
        CreateModal.
      */}
      {newName !== null && (
        <CreateModal
          title="New group"
          subtitle="Groups are labels: a colour in the rail. Projects live in one."
          tourId="group-modal"
          submitLabel="Create group"
          canSubmit={!!newName.trim() && !groups.includes(newName.trim())}
          onSubmit={createGroup}
          onClose={() => setNewName(null)}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createGroup();
              if (e.key === "Escape") setNewName(null);
            }}
            placeholder="Work, Personal, Clients…"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          {newName.trim() && groups.includes(newName.trim()) && (
            <p className="text-xs text-[#e5604d]">A group called “{newName.trim()}” already exists.</p>
          )}
        </CreateModal>
      )}

      {newProject !== null && (
        <CreateModal
          title="New project"
          subtitle={
            sel.kind === "group"
              ? `Added to ${sel.name}. Creates a folder and its own Claude session.`: "Creates a folder and its own Claude session."
          }
          tourId="project-modal"
          submitLabel="Create project"
          canSubmit={!!newProject.name.trim()}
          onSubmit={createProjectNow}
          onClose={() => setNewProject(null)}
        >
          <input
            autoFocus
            value={newProject.name}
            onChange={(e) => setNewProject({...newProject, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") createProjectNow();
              if (e.key === "Escape") setNewProject(null);
            }}
            placeholder="project-name"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <input
            value={newProject.desc}
            onChange={(e) => setNewProject({...newProject, desc: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") createProjectNow();
              if (e.key === "Escape") setNewProject(null);
            }}
            placeholder="Description (optional)"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          {projErr && <p className="text-xs text-[#e5604d]">{projErr}</p>}
        </CreateModal>
      )}

      {creating && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4">
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-8 py-6 shadow-2xl">
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-2 animate-bounce rounded-full bg-accent"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
            <span className="text-sm text-muted">Creating project…</span>
          </div>
        </div>
      )}
      {/* ── Group rail: the spine. Each group is a color chip; pick one to filter. ── */}
      <div className="flex w-16 shrink-0 flex-col items-center gap-1.5 border-r border-line bg-bg py-3">
        <RailChip
          label="All projects"
          active={sel.kind === "all"}
          onClick={() => setSel({ kind: "all" })}
        >
          <Stack size={18} weight={sel.kind === "all" ? "fill": "regular"} />
        </RailChip>

        <div className="my-1 h-px w-7 bg-line/70" />

        <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto">
          {groups.map((g, i) => {
            const color = colorOf(g);
            const on = sel.kind === "group" && sel.name === g;
            return (
              <RailChip
                key={g}
                // The tour falls back to the first group when "New project" isn't on screen, 
                // that button only exists once a group is selected.
                tourId={i === 0 ? "first-group": undefined}
                label={`${g} · ${groupMeta[g]?.count ?? 0}`}
                active={on}
                color={color}
                dot={groupMeta[g]?.active}
                onClick={() => setSel({ kind: "group", name: g })}
                onDropProject={(proj) => assignProject(proj, g)}
              >
                <span
                  className="text-sm font-bold"
                  style={{ color: on ? "#161009": color }}
                >
                  {g.charAt(0).toUpperCase()}
                </span>
              </RailChip>
            );
          })}

          {hasUngrouped && (
            <RailChip
              label="Ungrouped"
              active={sel.kind === "ungrouped"}
              onClick={() => setSel({ kind: "ungrouped" })}
              onDropProject={(proj) => assignProject(proj, null)}
            >
              <Folder size={17} weight={sel.kind === "ungrouped" ? "fill": "regular"} />
            </RailChip>
          )}

          <button
            data-tour="new-group"
            onClick={() => setNewName("")}
            title="New group"
            aria-label="New group"
            className="grid size-11 shrink-0 place-items-center rounded-2xl border border-dashed border-line text-faint transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={16} weight="bold" />
          </button>
        </div>

        <div className="my-1 h-px w-7 bg-line/70" />

        <button
          onClick={() => setScheduling(true)}
          title="Schedule loop"
          aria-label="Schedule loop"
          className="relative grid size-11 shrink-0 place-items-center rounded-2xl text-muted transition-all hover:rounded-xl hover:bg-raised hover:text-ink"
        >
          <Clock size={18} weight={anyArmed ? "fill": "regular"} />
          {anyArmed && (
            <span className="absolute right-2 top-2 size-1.5 rounded-full bg-accent" />
          )}
        </button>

        <button
          data-tour="manage-groups"
          onClick={() => setManaging(true)}
          title="Manage groups"
          aria-label="Manage groups"
          className="grid size-11 shrink-0 place-items-center rounded-2xl text-muted transition-all hover:rounded-xl hover:bg-raised hover:text-ink"
        >
          <Faders size={18} weight="regular" />
        </button>

        {/* Settings: theme lives in here now (absorbed the old palette popover). */}
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          className="grid size-11 shrink-0 place-items-center rounded-2xl text-muted transition-all hover:rounded-xl hover:bg-raised hover:text-ink"
        >
          <GearSix size={18} weight="regular" />
        </button>
      </div>

      {/* ── Panel: branding, the selected group's title, search, and its projects. ── */}
      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        <div className="flex items-center gap-2 px-4 pt-3.5">
          <img src="/burrow-logo.svg" alt="" className="size-5 shrink-0" />
          <span className="font-mono text-lg font-bold tracking-tight">
            Bur<span className="text-accent">·</span>row
          </span>
          <button
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh"
            className="ml-auto grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
          >
            <ArrowsClockwise size={16} weight="bold" />
          </button>
        </div>

        {/* Selected-group title bar: the big, obvious "where am I" cue. */}
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          {titleGroup && (
            <span
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: colorOf(titleGroup) }}
            />
          )}
          <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
          <span className="ml-auto text-xs text-faint">{shown.length}</span>
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 focus-within:border-accent">
            <MagnifyingGlass size={15} className="text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects"
              className="w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </div>
        </div>

        {/* "New project" assigns to the current group, meaningless in All view, so hide it
            there. */}
        {sel.kind !== "all" && (
          <div className="px-3 pb-2">
            <button
              data-tour="new-project"
              onClick={() => {
                setNewProject(newProject ? null: { name: "", desc: "" });
                setProjErr(null);
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-accent/50 bg-accent/10 py-2 text-sm font-medium text-accent transition-colors hover:border-accent hover:bg-accent/20"
            >
              <FolderPlus size={17} weight="bold" />
              New project
            </button>
          </div>
        )}

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">

          {/* master: the root shell, always reachable. */}
          {(
            <Row
              icon={<House size={17} weight={activeProject === null ? "fill": "regular"} />}
              label="master"
              sub={null}
              active={activeProject === null}
              dot={masterActive ? "live": undefined}
              onClick={() => onSelect(null)}
            />
          )}

          {shown.map((p) =>
            renaming === p.name ? (
              <div key={p.name} className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") doRename(p.name);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                  />
                  <button onClick={() => doRename(p.name)} className="text-accent hover:opacity-80" aria-label="Save rename">
                    <Check size={16} weight="bold" />
                  </button>
                  <button onClick={() => setRenaming(null)} className="text-faint hover:text-ink" aria-label="Cancel rename">
                    <X size={15} weight="bold" />
                  </button>
                </div>
                {renameErr && <p className="mt-1 text-xs text-[#e5604d]">{renameErr}</p>}
              </div>
            ): (
              <Row
                key={p.name}
                icon={<Folder size={16} weight={activeProject === p.name ? "fill": "regular"} />}
                label={p.name}
                sub={p.description}
                active={activeProject === p.name}
                dot={activeSessions.has(p.name) ? "live": persistentProjects.has(p.name) ? "persistent": undefined}
                heavy={heavyByProject.get(p.name)}
                accent={isGrouped(p) ? colorOf(assignments[p.name]!): undefined}
                dragName={p.name}
                onClick={() => onSelect(p.name)}
                onRename={() => {
                  setRenaming(p.name);
                  setRenameVal(p.name);
                  setRenameErr(null);
                }}
                onDelete={() => {
                  if (!confirm(`Delete "${p.name}"? It moves to trash (recoverable on the VPS).`)) return;
                  deleteProject(p.name);
                  if (activeProject === p.name) onSelect(null);
                }}
              />
            ),
          )}

          {status === "ready" && shown.length === 0 && (
            <p className="px-3 py-4 text-sm text-faint">
              {sel.kind === "group"
                ? "No projects in this group yet: assign some via Manage.": "No projects match."}
            </p>
          )}
        </nav>

        {/* ── Saved split layouts. First-class entities like projects: create as many as you
             want, rename, delete. A split is only a VIEW config, deleting one never ends a
             session, and the same project can appear in several. Desktop-only (the grid is). ── */}
        {(
          <div data-tour="layouts" className="hidden shrink-0 border-t border-line px-2 py-2 md:block">
            <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
              <SquaresFour size={13} weight="bold" className="text-faint" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                {SPLITS_LABEL}
              </span>
              <button
                onClick={onNewSplit}
                title={`New ${SPLITS_LABEL.slice(0, -1).toLowerCase()} from the current project`}
                aria-label="New split"
                className="ml-auto grid size-5 place-items-center rounded text-faint hover:bg-raised hover:text-accent"
              >
                <Plus size={13} weight="bold" />
              </button>
            </div>

            {splits.length === 0 ? (
              <p className="px-1.5 pb-1 text-[11px] leading-snug text-faint">
                Saved terminal splits. Hit + to open one, it keeps whatever layout you shape.
              </p>
            ): (
              <div className="max-h-44 space-y-0.5 overflow-y-auto">
                {splits.map((s) =>
                  splitRenaming === s.id ? (
                    <div key={s.id} className="flex items-center gap-1.5 px-1 py-1">
                      <input
                        autoFocus
                        value={splitNameVal}
                        onChange={(e) => setSplitNameVal(e.target.value)}
                        onBlur={() => commitSplitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitSplitRename(s.id);
                          if (e.key === "Escape") setSplitRenaming(null);
                        }}
                        className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                  ): (
                    <div
                      key={s.id}
                      // The OUTLINE is what makes this read as a toggle: a tint and accent
                      // text look like "selected", a ring looks like "on, press to turn off".
                      // Inactive rows keep a transparent ring so nothing shifts by a pixel.
                      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 ring-1 ${
                        activeSplitId === s.id ? "bg-raised ring-accent": "ring-transparent hover:bg-raised/60"
                      }`}
                    >
                      <span
                        className={`h-3.5 w-0.5 shrink-0 rounded-full ${
                          activeSplitId === s.id ? "bg-accent": "bg-line"
                        }`}
                      />
                      {/* The row itself is the toggle: clicking the open one closes it. */}
                      <button
                        onClick={() => (activeSplitId === s.id ? onExitSplit(): onOpenSplit(s.id))}
                        aria-pressed={activeSplitId === s.id}
                        className="min-w-0 flex-1 text-left"
                        title={
                          activeSplitId === s.id
                            ? `Leave ${s.name} (sessions keep running)`: `Open ${s.name}`
                        }
                      >
                        <span
                          className={`block truncate text-sm ${
                            activeSplitId === s.id ? "font-medium text-accent": "text-ink"
                          }`}
                        >
                          {s.name}
                        </span>
                        <span className="block truncate text-[11px] text-faint">
                          {s.panels.map((p) => (p === null ? "empty": (p.project ?? "master"))).join(" · ")}
                        </span>
                      </button>
                      {activeSplitId === s.id && (
                        <button
                          onClick={onExitSplit}
                          title="Close split view (sessions keep running)"
                          aria-label="Close split view"
                          className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
                        >
                          <X size={12} weight="bold" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setSplitRenaming(s.id);
                          setSplitNameVal(s.name);
                        }}
                        title="Rename"
                        aria-label="Rename split"
                        className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                      >
                        <PencilSimple size={12} weight="bold" />
                      </button>
                      <button
                        onClick={() => {
                          if (activeSplitId === s.id) onExitSplit();
                          setSplits(splits.filter((x) => x.id !== s.id));
                        }}
                        title="Delete (sessions keep running)"
                        aria-label="Delete split"
                        className="grid size-5 shrink-0 place-items-center rounded text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                      >
                        <TrashSimple size={12} weight="bold" />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {managing && <GroupsModal onClose={() => setManaging(false)} />}
      {scheduling && <ScheduleModal onClose={() => setScheduling(false)} />}
      {/* First-use explanations for these two, said once each and unrelated to the tour, the
          point is that they fire whenever you first open the thing, which may be weeks later.
          See lib/hints. */}
      <Hint id="groups-manager" active={managing} />
      <Hint id="schedule" active={scheduling} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}

/** A square color chip in the group rail, with a Discord-style active indicator. */
function RailChip({
  children,
  label,
  active,
  color,
  dot,
  onClick,
  onDropProject,
  tourId,
}: {
  children: ReactNode;
  label: string;
  active: boolean;
  color?: string;
  dot?: boolean;
  onClick: () => void;
  onDropProject?: (project: string) => void;
  /** Anchor id for the first-run tour, when this chip is one of its targets. */
  tourId?: string;
}) {
  const [over, setOver] = useState(false);
  const dropProps = onDropProject && {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const name = e.dataTransfer.getData("text/plain");
      if (name) onDropProject(name);
    },
  };
  return (
    <div className="relative flex w-full items-center justify-center">
      {/* left indicator bar for the active chip */}
      <span
        className={`absolute left-0 w-1 rounded-r-full bg-accent transition-all ${
          active ? "h-7 opacity-100": "h-0 opacity-0"
        }`}
      />
      <button
        data-tour={tourId}
        onClick={onClick}
        title={label}
        aria-label={label}
        {...dropProps}
        className={`grid size-11 place-items-center rounded-2xl transition-all ${
          over ? "scale-110 ring-2 ring-accent": ""
        } ${active ? "text-ink": "text-muted hover:rounded-xl hover:text-ink"}`}
        style={
          active || over
            ? { backgroundColor: color ?? "var(--color-accent)" }: color
              ? { backgroundColor: `${color}22` }: undefined
        }
      >
        {children}
      </button>
      {dot && !active && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent shadow-[0_0_5px_#f2792b]" />
      )}
    </div>
  );
}

function Row({
  icon,
  label,
  sub,
  active,
  dot,
  heavy,
  accent,
  dragName,
  onClick,
  onRename,
  onDelete,
}: {
  icon: ReactNode;
  label: string;
  sub: string | null;
  active: boolean;
  dot?: "live" | "persistent";
  /** Formatted resident size, set ONLY when this session is over the heavy threshold. */
  heavy?: string;
  accent?: string;
  dragName?: string;
  onClick: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      draggable={!!dragName}
      onDragStart={
        dragName
          ? (e) => {
              e.dataTransfer.setData("text/plain", dragName);
              e.dataTransfer.effectAllowed = "move";
            }: undefined
      }
      className={`group flex w-full items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-2.5 text-left transition-colors ${
        dragName ? "cursor-grab active:cursor-grabbing": "cursor-pointer"
      } ${active ? "bg-accent-soft": "hover:bg-raised"}`}
    >
      {/* thin group-color spine so a project's group is visible even in All view */}
      <span
        className="h-7 w-0.5 shrink-0 rounded-full"
        style={{ backgroundColor: accent ?? "transparent" }}
      />
      <span className={active ? "text-accent": "text-muted group-hover:text-ink"}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-mono text-sm ${active ? "text-ink": "text-ink/90"}`}>
          {label}
        </span>
        {/*
          The heavy-memory chip sits on the SECOND line, not out at the row's right edge, because
          there it stole enough width to truncate the project name to "f1_c…", a memory warning
          that hides which session it is about defeats its own purpose. Only rendered past the
          threshold, so an ordinary row is unchanged.
        */}
        {(sub || heavy) && (
          <span className="flex items-baseline gap-1.5">
            {heavy && (
              <span
                title={`This session is holding ${heavy} of memory`}
                aria-label={`Session memory ${heavy}`}
                className="shrink-0 rounded px-1 text-[10px] font-medium tabular-nums text-[#e0a94b] ring-1 ring-[#e0a94b]/40"
              >
                {heavy}
              </span>
            )}
            {sub && <span className="truncate text-xs text-faint">{sub}</span>}
          </span>
        )}
      </span>
      {onRename && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          title="Rename project"
          aria-label="Rename project"
          className="shrink-0 text-faint/60 transition-colors hover:text-ink"
        >
          <PencilSimple size={14} weight="bold" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete project"
          aria-label="Delete project"
          className="shrink-0 text-faint/60 opacity-0 transition-colors hover:text-[#e5604d] group-hover:opacity-100"
        >
          <TrashSimple size={14} weight="bold" />
        </button>
      )}
      {dot === "live" && (
        <span
          title="Live session running"
          aria-label="Live session running"
          className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_6px_#f2792b]"
        />
      )}
      {dot === "persistent" && (
        <span
          title="Persistent: resumes when opened"
          aria-label="Persistent chat"
          className="size-2 shrink-0 rounded-full border-2 border-accent"
        />
      )}
    </div>
  );
}
