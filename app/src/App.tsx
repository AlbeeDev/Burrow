import { useEffect, useRef, useState } from "react";
import { List, Plugs, PushPin, CaretDown, Check, FolderOpen, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Sidebar } from "./components/Sidebar";
import { Conversation } from "./components/Conversation";
import { McpModal } from "./components/McpModal";
import { CommandPalette } from "./components/CommandPalette";
import { SplitScroller } from "./components/SplitScroller";
import {
  openSplit,
  focusCell,
  focusedProject,
  assignToFocused,
  dropOnPanel,
  addPanel,
  closePanel,
  exitTarget,
  toSaved,
  fromSaved,
  type SplitState,
} from "./lib/splitCells";
import { FilesModal } from "./components/FilesModal";
import { PushLightbox } from "./components/PushLightbox";
import { PushRow } from "./components/PushRow";
import { usePushes } from "./lib/usePushes";
import { useGateway } from "./lib/useGateway";
import { MODELS } from "./lib/models";
import { panelFocusRequest, splitToggleRequest, helpRequest } from "./lib/shortcuts";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { sessionPct, weeklyPct, usageLevel, blocks, fmtReset, credits, type UsageResult } from "./lib/usage";
import { fmtAge, fmtBytes, isHeavy } from "./lib/sessionStats";
import { Tour } from "./components/Tour";
import { USAGE_OPEN_EVENT } from "./components/UsageRow";
import { currentStep, TOUR_RESET_EVENT, WORKSPACE_STEPS } from "./lib/tour";

export type Mode = "terminal" | "claude";

// What the two modes are CALLED in the UI. The "claude" key stays internal (localStorage,
// Conversation, server events): we have always said "bubble" out loud, so only the label moves.
const MODE_LABEL: Record<Mode, string> = { terminal: "Terminal", claude: "Bubble" };

const MIN_W = 220;
const MAX_W = 560;
const WIDTH_KEY = "burrow.sidebarWidth";

// Remember which view (terminal vs bubble) was last used, strictly PER project, so returning
// to a project reopens where you left off. A project you've never toggled defaults to terminal;
// there's no global carry-over (switching sandbox to bubble must not flip burrow to bubble).
const MODE_KEY = (p: string | null) => `burrow.mode:${p ?? "master"}`;
const LAST_PROJECT_KEY = "burrow.project";

function loadMode(p: string | null): Mode {
  return localStorage.getItem(MODE_KEY(p)) === "claude" ? "claude": "terminal";
}

// Context-size nudge thresholds (absolute tokens). Windows differ per model and we can't know
// each reliably, so this is framed as cost, a big context re-bills every message. Tune here.
const CTX_WARN = 150_000;
const CTX_DANGER = 300_000;
function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0: 1)}k`: String(n);
}

export function App() {
  // null project = the master terminal (root of the VPS). Restore the last project + its view
  // so a reload/return lands where you left off.
  const [project, setProject] = useState<string | null>(() => localStorage.getItem(LAST_PROJECT_KEY) || null);
  const [mode, setMode] = useState<Mode>(() => loadMode(localStorage.getItem(LAST_PROJECT_KEY) || null));
  const [pendingMode, setPendingMode] = useState<Mode | null>(null); // a switch awaiting confirmation
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Split terminals: desktop only. Track the breakpoint live so shrinking the window
  // falls back to the single view (mobile stays exactly as it was). The grid's state lives
  // HERE, not in SplitGrid: the focused panel is the app's active project, so `project`,
  // the header and the sidebar all stay in agreement with what you're looking at.
  // null = single view. The layout rules themselves live in lib/splitCells (pure + verified).
  const [splitState, setSplitState] = useState<SplitState | null>(null);
  // Which saved split (sidebar entity) the live layout belongs to, every reshape writes back
  // to it, so a split always reopens exactly as you left it.
  const [activeSplitId, setActiveSplitId] = useState<string | null>(null);
  // The layout you last left, so mod-0 can bring it back. Client-side only and deliberately not
  // persisted: it's an undo for the keystroke you just pressed, not a preference. A stale id
  // (the split was deleted) simply finds nothing and the chord does nothing.
  const [lastSplitId, setLastSplitId] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const { projects, groups, killTerminal, splits, setSplits, status, onboarding, markSeen } = useGateway();

  // Dismissed for THIS visit. The durable answer is `onboarding.tourDone`, which lives on the
  // server; this only stops the tour reappearing between the click and the write landing.
  const [tourDismissed, setTourDismissed] = useState(false);
  // What Claude pushed for whatever project is on screen, images, markdown, media, PDFs, pages.
  // Follows `project`, so in a split it follows the focused panel: the rule the header obeys too.
  const pushFeed = usePushes(project);

  // First-run tour. Derived from what exists rather than stored as a cursor, so it survives a
  // reload and can never point at a button that hasn't rendered yet, see lib/tour.
  const [tourStarted, setTourStarted] = useState(false);
  const derived = currentStep({
    // Not ready until the server has said whether this install has seen the tour. `onboarding` is
    // null before that, and treating null as "unseen" would flash the tour at someone who
    // finished it long ago, every single load.
    ready: status === "ready" && onboarding !== null,
    dismissed: tourDismissed || onboarding?.tourDone === true,
    groupCount: groups.length,
    projectCount: projects.length,
    started: tourStarted,
  });
  /*
   * Phase 2 is a cursor, not a derivation.
   *
   * The "do this" steps read themselves off the world, a group exists, a project exists, which
   * is what makes them honest. Nothing in the world changes when somebody reads about the
   * terminal, so from here it is an index the Next button moves.
   */
  const [workspaceAt, setWorkspaceAt] = useState(0);
  const tourStep = derived === "workspace" ? (WORKSPACE_STEPS[workspaceAt] ?? null): derived;

  // Step forward, putting away any dialog the step being left had opened, otherwise a half-filled
  // "New group" box, or an open Files modal, sits there while the tour has moved on.
  const advanceTour = () => {
    window.dispatchEvent(new Event(TOUR_RESET_EVENT));
    setFilesOpen(false);
    setPaletteOpen(false);
    // Past the end of the workspace list, the tour is finished for good, recorded on the server
    // so it stays finished on every other browser too.
    if (workspaceAt + 1 >= WORKSPACE_STEPS.length) {
      setTourDismissed(true);
      markSeen({ tour: true });
    }
    setWorkspaceAt((i) => i + 1);
  };

  // Latch on the first step actually shown. Phase 2 is only for someone we walked here.
  useEffect(() => {
    if (tourStep === "group" || tourStep === "project") setTourStarted(true);
  }, [tourStep]);

  // Persistent, drag-resizable sidebar width (desktop).
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= MIN_W && v <= MAX_W ? v: 300;
  });
  const dragging = useRef(false);
  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragging.current) return;
      setSidebarWidth(Math.min(MAX_W, Math.max(MIN_W, e.clientX)));
    }
    function up() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      setSidebarWidth((w) => {
        localStorage.setItem(WIDTH_KEY, String(w));
        return w;
      });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const activeName = project ?? "master";
  const activeDesc = project ? (projects.find((p) => p.name === project)?.description ?? null): null;

  // Persist the active project across reloads; drop a restored name that no longer exists.
  useEffect(() => {
    if (project) localStorage.setItem(LAST_PROJECT_KEY, project);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  }, [project]);
  // Validate the restored project only ONCE, when the list first loads, otherwise this fires
  // during the brief window after creating a project (before refresh lands it in `projects`)
  // and bounces you back to root.
  const validated = useRef(false);
  useEffect(() => {
    if (validated.current || !projects.length) return;
    validated.current = true;
    if (project && !projects.some((p) => p.name === project)) {
      setProject(null);
      setMode(loadMode(null));
    }
  }, [projects, project]);

  // Split-view geometry. `splitOn` gates every split behaviour on one condition, so a window
  // shrink or a mode switch can never leave half-applied split state behind.
  const splitOn = mode === "terminal" && isDesktop && !!splitState;
  const emptyFocus = splitOn && focusedProject(splitState!) === undefined;

  // What this browser wants kept alive. Every cell in the layout counts, including parked ones and
  // ones scrolled out of view: an empty panel (`project === undefined`) holds nothing. Bubble mode
  // holds nothing either: it ends its terminal outright rather than draining it.
  useSessionHolds(
    mode !== "terminal"
      ? []: splitOn
        ? splitState!.cells
.filter((c) => c.project !== undefined)
.map((c) => ({ viewId: `cell:${c.id}`, project: c.project as string | null })): [{ viewId: "single", project }],
  );

  // Every split operation lands here: store the new layout, pull the app's active project from
  // whatever panel is now focused (that single line keeps the header honest), and write the
  // shape back to the saved split it belongs to.
  function applySplit(next: SplitState | null) {
    setSplitState(next);
    if (!next) return;
    const p = focusedProject(next);
    if (p !== undefined) setProject(p);
    if (!activeSplitId) return;
    const saved = toSaved(next);
    const current = splits.find((s) => s.id === activeSplitId);
    if (!current) return;
    // Only a changed LAYOUT is worth a write. Focus isn't stored, so moving between panels, 
    // by click or by Cmd/Ctrl-1…4: compares equal here and never reaches the server.
    if (JSON.stringify({ panels: current.panels }) === JSON.stringify(saved)) return;
    setSplits(splits.map((s) => (s.id === activeSplitId ? {...s, ...saved }: s)));
  }

  // "+" in the sidebar: a new saved split, opened immediately, holding the current project.
  function newSplit() {
    const used = new Set(splits.map((s) => s.name));
    let n = splits.length + 1;
    while (used.has(`Split ${n}`)) n++;
    const state = openSplit(project);
    const entry = { id: `sp-${Date.now().toString(36)}`, name: `Split ${n}`, ...toSaved(state) };
    setSplits([...splits, entry]);
    setActiveSplitId(entry.id);
    if (mode !== "terminal") enterTerminalMode();
    setSplitState(state);
  }

  function openSavedSplit(id: string) {
    const entry = splits.find((s) => s.id === id);
    if (!entry) return;
    setActiveSplitId(id);
    if (mode !== "terminal") enterTerminalMode();
    const state = fromSaved(entry.panels);
    setSplitState(state);
    const p = focusedProject(state);
    if (p !== undefined) setProject(p);
  }

  // Leaving a split lands you on what you were looking at. `applySplit` already keeps `project`
  // synced to the focused panel: except when that panel is EMPTY, where there was nothing to
  // sync and `project` is still whatever you focused before. Rather than exit onto a project you
  // weren't looking at, fall to the first panel that holds something, and to master if none do.
  function exitSplit() {
    if (splitState) setProject(exitTarget(splitState));
    setLastSplitId(activeSplitId); // so mod-0 can reopen it
    setSplitState(null);
    setActiveSplitId(null);
  }

  // Opening a split implies the terminal. Going bubble→terminal kills nothing (only the
  // reverse does), so this needs no confirmation, unlike the header's mode toggle.
  function enterTerminalMode() {
    setMode("terminal");
    localStorage.setItem(MODE_KEY(project), "terminal");
  }

  function selectProject(next: string | null) {
    // In split view the sidebar fills the FOCUSED panel, the other panels stay put.
    if (splitOn) {
      applySplit(assignToFocused(splitState!, next));
      setDrawerOpen(false);
      return;
    }
    setProject(next);
    setMode(loadMode(next)); // reopen the view last used for this project
    setDrawerOpen(false);
  }

  // `?` opens the shortcuts list from anywhere, so the list is
  // reachable without going through Settings. Yields to any field you can type into (including
  // the terminal's hidden textarea), which is what `helpRequest` checks.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!helpRequest(e)) return;
      e.preventDefault();
      setShortcutsOpen((o) => !o);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cmd-K / Ctrl-K opens the cross-project palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cmd/Ctrl-1…4 focuses that panel. This is a SECOND path into the same applySplit a click
  // makes: click-to-focus is untouched, so the header rebinds identically either way.
  // TerminalView hands the chord back to us instead of letting the shell eat it.
  useEffect(() => {
    if (!splitOn) return;
    function onKey(e: KeyboardEvent) {
      const n = panelFocusRequest(e);
      if (!n) return;
      // Columns in order. This used to address `stageCells`, the grid's first four, with the
      // rest parked on a rail, but the scroller has no stage: panel 3 is the third column
      // whether or not it is scrolled into view, and focusing it brings it there.
      const cell = splitState!.cells[n - 1];
      if (!cell) return; // fewer panels open than the number pressed
      e.preventDefault();
      applySplit(focusCell(splitState!, cell.id));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitOn, splitState, splits, activeSplitId]);

  // Cmd/Ctrl-0 is the same toggle the layout row is: in a split it leaves, out of one it reopens
  // the last layout you left. Both directions go through the SAME functions the click uses, so
  // the visual state can't diverge between mouse and keyboard. Live outside split view too, 
  // that's the half that reopens.
  useEffect(() => {
    if (!isDesktop) return;
    function onKey(e: KeyboardEvent) {
      if (!splitToggleRequest(e)) return;
      e.preventDefault();
      if (splitOn) {
        exitSplit();
        return;
      }
      // No-op when there is nothing to come back to, or it has since been deleted. This chord
      // never CREATES a layout: that stays the sidebar's "+".
      if (lastSplitId && splits.some((s) => s.id === lastSplitId)) openSavedSplit(lastSplitId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, splitOn, splitState, splits, activeSplitId, lastSplitId, project, mode]);

  // Apply a confirmed mode switch: remember the choice, and if we're leaving the terminal,
  // hard-kill its session so returning relaunches `claude -c` fresh (current with the bubble).
  function applyMode(next: Mode) {
    if (mode === "terminal") killTerminal(project);
    // Leaving the terminal drops the grid entirely, coming back opens a clean single view
    // rather than a stale layout whose sessions may have been killed underneath it.
    if (next !== "terminal") {
      setSplitState(null);
      setActiveSplitId(null);
    }
    setMode(next);
    localStorage.setItem(MODE_KEY(project), next);
    setPendingMode(null);
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-ink">
      {/*
        Renders nothing itself: it drives the highlight overlay. Closing a REPLAY only ends the
        replay; it must not write the "seen it" flag, or looking at the tour once would be
        indistinguishable from a real user dismissing it.
      */}
      <Tour
        step={tourStep}
        onDismiss={() => {
          setTourDismissed(true);
          markSeen({ tour: true });
        }}
        onSkip={advanceTour}
      />
      {/* Sidebar: persistent (resizable) on desktop, slide-over drawer on mobile. */}
      <div
        style={{ width: sidebarWidth }}
        className={`fixed inset-y-0 left-0 z-30 max-w-[85vw] transform transition-transform duration-200 md:static md:max-w-none md:translate-x-0 md:transition-none ${
          drawerOpen ? "translate-x-0": "-translate-x-full"
        }`}
      >
        <Sidebar
          activeProject={project}
          onSelect={selectProject}
          activeSplitId={activeSplitId}
          onNewSplit={newSplit}
          onOpenSplit={openSavedSplit}
          onExitSplit={exitSplit}
        />
      </div>
      {drawerOpen && (
        <button
          aria-label="Close menu"
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Drag handle to resize the sidebar (desktop only). */}
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          dragging.current = true;
          document.body.style.userSelect = "none";
        }}
        className="hidden w-1 shrink-0 cursor-col-resize bg-line/40 transition-colors hover:bg-accent md:block"
        role="separator"
        aria-label="Resize sidebar"
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/*
          The header is two rows now. The second one only exists while Claude has handed you
          something (PushRow renders nothing otherwise), which is why the padding moved onto the
          inner row: the header expands DOWNWARD by exactly one row and costs nothing in a session
          that never uses the feature. It lives in the header rather than floating over the content
          because the header belongs to the session, not to a panel, so it sits above the split
          grid instead of fighting it.
        */}
        <header className="border-b border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button
            className="grid size-9 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink md:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <List size={20} weight="bold" />
          </button>
          {/* In split view the title wears the same accent spine as the focused panel, the
              two marks are what make "this header describes that panel" read instantly. */}
          <div className={`min-w-0 flex-1 ${splitOn ? "border-l-2 border-accent pl-2.5": ""}`}>
            <h1 className="truncate font-mono text-[15px] font-semibold text-ink">
              {emptyFocus ? "Empty panel": activeName}
            </h1>
            {emptyFocus ? (
              <p className="truncate text-xs text-muted">Pick a project in the sidebar to open it here</p>
            ): (
              activeDesc && <p className="truncate text-xs text-muted">{activeDesc}</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* The 14px count pill that used to live here is gone, the row below IS the entry
                point now, and two entry points for one thing is what made the first one hard to
                find. */}
            {project !== null && !emptyFocus && (
              <button
                data-tour="files"
                onClick={() => setFilesOpen(true)}
                title="Manage files"
                aria-label="Manage files"
                className="flex items-center gap-1.5 rounded-full border border-line bg-bg px-2.5 py-1 text-xs font-medium text-muted hover:border-accent/50 hover:text-ink"
              >
                <FolderOpen size={14} weight="bold" /> Files
              </button>
            )}
            {(
              <button
                data-tour="search"
                onClick={() => setPaletteOpen(true)}
                title="Search projects and chats (Cmd-K)"
                aria-label="Search projects and chats"
                className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
              >
                <MagnifyingGlass size={17} weight="bold" />
              </button>
            )}
            {project !== null && !emptyFocus && <GroupPicker project={project} />}
            {!emptyFocus && <UsageBadge project={project} mode={mode} />}
            {mode === "claude" && (
              <button
                onClick={() => setMcpOpen(true)}
                title="MCP servers"
                aria-label="MCP servers"
                className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
              >
                <Plugs size={18} weight="bold" />
              </button>
            )}
            {/* No split button here: splits are entities in the sidebar's own section now. */}
            {mode === "terminal" && project !== null && !emptyFocus && <PersistToggle project={project} />}
            {mode === "claude" && <ModelToggle />}
            {mode === "claude" && <AccountToggle />}
            <ModeToggle mode={mode} onChange={(m) => m !== mode && setPendingMode(m)} />
          </div>
        </div>
        {!emptyFocus && <PushRow feed={pushFeed} />}
        </header>

        {splitOn ? (
          <div data-tour="terminal" className="min-h-0 flex-1 p-3 md:p-4">
            {/*
              Every panel is a column: full height, scroll sideways for the rest. There is no
              stage/parked split here, so focus can land anywhere (focusCell, not focusPanel) and
              nothing needs promoting.

              This ran behind an experiment flag alongside a 2x2 grid until the
              flag was removed and this became the only layout. The grid's first split was a
              horizontal one, which halves a terminal's rows, a height nobody can work in.
            */}
            <SplitScroller
              cells={splitState!.cells}
              focusId={splitState!.focusId}
              onFocus={(id) => applySplit(focusCell(splitState!, id))}
              onClose={(id) => applySplit(closePanel(splitState!, id))}
              onAdd={() => applySplit(addPanel(splitState!))}
              onDropProject={(id, name) => applySplit(dropOnPanel(splitState!, id, name))}
            />
          </div>
        ): (
          // The tour points at this whole region, so the anchor wraps the view rather than living
          // inside Conversation, which renders two quite different things depending on mode.
          <div data-tour="terminal" className="flex min-h-0 flex-1 flex-col">
            <Conversation project={project} mode={mode} />
          </div>
        )}
      </main>

      <PushLightbox feed={pushFeed} />
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onSelect={selectProject} />}
      {mcpOpen && <McpModal project={project} onClose={() => setMcpOpen(false)} />}
      {filesOpen && project !== null && (
        <FilesModal project={project} onClose={() => setFilesOpen(false)} />
      )}
      {pendingMode && (
        <SwitchModal
          from={mode}
          to={pendingMode}
          onConfirm={() => applyMode(pendingMode)}
          onCancel={() => setPendingMode(null)}
        />
      )}
    </div>
  );
}

// Confirm switching between Terminal and Bubble. Switching ends the current terminal
// session (so the other view is always current), the modal makes that consequence explicit.
function SwitchModal({
  from,
  to,
  onConfirm,
  onCancel,
}: {
  from: Mode;
  to: Mode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const leavingTerminal = from === "terminal";
  const toLabel = MODE_LABEL[to];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">Switch to {toLabel}?</h2>
        <p className="mt-1.5 text-sm text-muted">
          {leavingTerminal
            ? "This ends the current terminal session, anything running in it stops. Bubble opens on the latest conversation, and the terminal starts fresh next time.": "The terminal opens on the latest conversation. Any reply still generating in Bubble keeps running in the background and is saved."}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium ${
              leavingTerminal ? "bg-danger text-white": "bg-accent text-bg"
            }`}
          >
            {leavingTerminal ? "End & switch": "Switch"}
          </button>
        </div>
      </div>
    </div>
  );
}


function ModelToggle() {
  const { model, setModel } = useGateway();
  return (
    <select
      value={model}
      onChange={(e) => setModel(e.target.value)}
      title="Model"
      className="rounded-full border border-line bg-bg px-3 py-1 text-xs font-medium text-muted focus:border-accent focus:text-ink focus:outline-none"
    >
      {MODELS.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

function AccountToggle() {
  const { accounts, activeAccount, setAccount } = useGateway();
  if (accounts.length <= 1) return null;
  return (
    <select
      value={activeAccount}
      onChange={(e) => setAccount(e.target.value)}
      title="Claude account"
      className="rounded-full border border-line bg-bg px-3 py-1 text-xs font-medium text-muted focus:border-accent focus:text-ink focus:outline-none"
    >
      {accounts.map((a) => (
        <option key={a} value={a}>
          {a.charAt(0).toUpperCase() + a.slice(1)}
        </option>
      ))}
    </select>
  );
}

// In-chat group picker: set the current project's group from the header, from any device.
function GroupPicker({ project }: { project: string }) {
  const { groups, assignments, assignProject, colorOf } = useGateway();
  const [open, setOpen] = useState(false);
  const current = groups.includes(assignments[project] ?? "") ? assignments[project]!: null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Set group"
        className="flex items-center gap-1.5 rounded-full border border-line bg-bg px-2.5 py-1 text-xs font-medium text-muted hover:border-accent/50 hover:text-ink"
      >
        {current ? (
          <>
            <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(current) }} />
            <span className="max-w-[100px] truncate text-ink">{current}</span>
          </>
        ): (
          <span className="text-faint">+ Group</span>
        )}
        <CaretDown size={11} weight="bold" className={open ? "rotate-180 transition-transform": "transition-transform"} />
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-2xl">
            {groups.length === 0 && (
              <p className="px-3 py-2 text-xs text-faint">No groups yet, create one in the sidebar.</p>
            )}
            {groups.map((g) => (
              <button
                key={g}
                onClick={() => {
                  assignProject(project, g);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raised"
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(g) }} />
                <span className="min-w-0 flex-1 truncate text-ink">{g}</span>
                {current === g && <Check size={14} weight="bold" className="text-accent" />}
              </button>
            ))}
            {current && (
              <button
                onClick={() => {
                  assignProject(project, null);
                  setOpen(false);
                }}
                className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2.5 py-1.5 text-left text-sm text-faint hover:bg-raised hover:text-ink"
              >
                Remove from group
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Ephemeral | Persistent, as a segmented control matching the Terminal/Bubble one.
 *
 * It used to be a single button showing the current state, which carries the standard toggle-button
 * ambiguity: "Persistent" could equally mean *it is* or *click to make it*, and the tooltip had to
 * resolve that. Showing both options resolves it by construction, the selected one is obvious and
 * the alternative is named rather than hidden behind a hover.
 */
function PersistToggle({ project }: { project: string }) {
  const { persistentProjects, setPersistent } = useGateway();
  const on = persistentProjects.has(project);
  const OPTIONS = [
    {
      persistent: false,
      label: "Ephemeral",
      hint: "Cleaned up after you leave, but never mid-task, it waits until the session is idle.",
    },
    {
      persistent: true,
      label: "Persistent",
      hint: "Keeps running after you leave or disconnect, until you stop it.",
    },
  ];
  return (
    <div
      data-tour="persistence"
      className="flex rounded-full border border-line bg-bg p-0.5 text-xs font-medium"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.label}
          onClick={() => setPersistent(project, o.persistent)}
          aria-pressed={on === o.persistent}
          title={o.hint}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 transition-colors ${
            on === o.persistent ? "bg-accent text-bg": "text-muted hover:text-ink"
          }`}
        >
          {o.persistent && <PushPin size={12} weight={on ? "fill": "regular"} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Plan usage in the header: a bar with the CURRENT SESSION WINDOW's percentage, in the slot the
 * conversation-context badge used to own. Clicking it opens everything else, weekly window, both
 * reset times, per-model blocks, credit spend, plus the context size, which moved in here because
 * it answers a different question (when to `/compact`, per project) than "how much plan is left"
 * (per account).
 *
 * Source of truth is the installed usage provider via `usage.get` (server-cached). This
 * replaces the old `rate_limit_event` badge, which only appeared mid-bubble-turn and only once you
 * had already hit the wall.
 */
function UsageBadge({ project, mode }: { project: string | null; mode: Mode }) {
  const { gateway, status } = useGateway();
  const [tokens, setTokens] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [open, setOpen] = useState(false);

  // Settings can open this panel, so "I just set up the usage addon" leads straight to where it
  // lives rather than leaving you hunting a small pill in a crowded header. See UsageRow.
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(USAGE_OPEN_EVENT, show);
    return () => window.removeEventListener(USAGE_OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    const poll = () =>
      gateway
.req<{ tokens: number | null }>("context.size", { project })
.then((r) => alive && setTokens(r.tokens))
.catch(() => {});
    poll();
    const id = setInterval(poll, 12_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [gateway, status, project, mode]);

  // 60s: the server caches for 45s (its README says 30–60s and explicitly forbids per-render
  // polling), so anything faster just returns the same cached object.
  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    const poll = () =>
      gateway
.req<UsageResult>("usage.get")
.then((r) => alive && setUsage(r))
.catch(() => alive && setUsage({ ok: false, usage: { status: "request_failed" }, at: Date.now(), cached: false }));
    poll();
    const id = setInterval(poll, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [gateway, status]);

  if (!usage) return null;
  /*
   * No provider installed → no badge at all, rather than a permanent "usage ?".
   *
   * A question mark in the header reads as "something is broken"; it is noise for the many people
   * who will never install a usage provider, and it cannot be dismissed. Settings says the addon
   * exists, which is where a thing you might want to add belongs.
   */
  if (usage.usage.status === "not_configured") return null;

  // A failed read shows "?" and never 0%: a zero reads as headroom, which is the opposite of
  // the truth (its README is explicit about this). Both rules live in lib/usage.
  const pct = sessionPct(usage);
  const level = usageLevel(usage);
  const blocked = blocks(usage);
  const tone =
    level === "danger"
      ? "border-danger/50 text-danger": level === "warn"
        ? "border-[#e0a94b]/60 text-[#e0a94b]": level === "unknown"
          ? "border-line text-faint": "border-line text-muted";

  return (
    <span className="relative hidden sm:inline-flex">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={
          pct === null
            ? `Plan usage unknown (${usage.usage.status}), click for details`: `Session window ${pct}% used${blocked.length ? ` · ${blocked.length} model capped`: ""}, click for the weekly window, resets and credits`
        }
        className={`inline-flex items-center gap-2 rounded-full border bg-bg px-2.5 py-1 text-xs font-medium ${tone}`}
      >
        {pct === null ? (
          <span>usage ?</span>
        ): (
          <>
            <Bar pct={pct} level={level} className="h-1.5 w-12" />
            <span>{pct}%</span>
            {/* A capped model is worth knowing about at any percentage, but it is not this
                session's problem, so it gets a dot, not the bar's colour. */}
            {blocked.length > 0 && (
              <span
                aria-label={`${blocked.length} model capped this week`}
                className="size-1.5 rounded-full bg-[#e0a94b]"
              />
            )}
          </>
        )}
      </button>
      {open && (
        <UsagePanel
          result={usage}
          tokens={tokens}
          onClose={() => setOpen(false)}
          onRefresh={() => {
            setUsage(null);
            gateway
.req<UsageResult>("usage.get")
.then(setUsage)
.catch(() => setUsage({ ok: false, usage: { status: "request_failed" }, at: Date.now(), cached: false }));
          }}
        />
      )}
    </span>
  );
}

/** One usage bar. Three bands, one place, the badge and the panel must never disagree. */
function Bar({ pct, level, className = "" }: { pct: number; level: string; className?: string }) {
  const fill =
    level === "danger" ? "bg-danger": level === "warn" ? "bg-[#e0a94b]": "bg-sky-400";
  return (
    <span className={`block overflow-hidden rounded-full bg-line/60 ${className}`}>
      <span className={`block h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** A window: name, percentage, its own bar, and when it resets, relative first. */
function Window({ label, pct, level, reset }: { label: string; pct: number | null; level: string; reset: ReturnType<typeof fmtReset> }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="text-xs font-medium tabular-nums text-ink">{pct === null ? ", ": `${pct}%`}</span>
      </div>
      <Bar pct={pct ?? 0} level={pct === null ? "unknown": level} className="mt-1 h-1.5 w-full" />
      {/* Two weights, not one grey mush: the wait is the number you actually read (same
          treatment as the percentage above it), the wall-clock time is a label (same treatment
          as the section headings). */}
      <p className="mt-1 flex items-baseline gap-2">
        {reset ? (
          <>
            <span className="text-xs font-medium tabular-nums text-ink">{reset.in}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
              resets {reset.at}
            </span>
          </>
        ): (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            reset time unknown
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * Everything the bar doesn't have room for. Opened by clicking the bar.
 *
 * Two real bars for the two account windows, then a separated block for the conversation, so
 * "this account" and "this conversation" stop reading as one stack of rows. Leaving is part of
 * the design: a visible ✕, Escape, or a click anywhere outside, and the panel takes focus
 * when it opens so Escape reaches it without a click first.
 */
/**
 * Session holds: the lifetime model: "a session drains when nothing holds it".
 *
 * The LAYOUT decides what stays alive, not the attachment. Every panel in a split holds its session
 * even while it is scrolled out of view or parked with no terminal attached; the single view holds
 * whatever project it shows. Closing a panel, leaving the split, switching to bubble, or losing the
 * browser releases the hold, and only then does the normal ephemeral countdown start.
 *
 * Re-sends everything on reconnect: holds are scoped to a connection server-side, so a new socket
 * starts with none and the map has to be replayed or the layout would quietly stop protecting it.
 */
function useSessionHolds(holds: { viewId: string; project: string | null }[]) {
  const { gateway, status } = useGateway();
  const sent = useRef(new Map<string, string | null>());
  const key = holds.map((h) => `${h.viewId}=${h.project ?? "\0master"}`).join(",");
  useEffect(() => {
    if (status !== "ready") {
      sent.current = new Map(); // the server forgot them; replay on the next connection
      return;
    }
    const next = new Map(holds.map((h) => [h.viewId, h.project]));
    for (const [viewId, project] of next) {
      const before = sent.current.get(viewId);
      if (!sent.current.has(viewId) || before !== project) {
        gateway.req("terminal.hold", { viewId, project }).catch(() => {});
      }
    }
    for (const viewId of sent.current.keys()) {
      if (!next.has(viewId)) gateway.req("terminal.release", { viewId }).catch(() => {});
    }
    sent.current = next;
    // `key` is the real dependency: `holds` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, status, key]);
}

/**
 * Live sessions on this host: resident memory and age, newest server sample (once a minute).
 *
 * This exists because one session once reached 6.3 GB and took the box down, and nothing
 * in the UI could say which one; the kernel found out first. The account bars above answer "how
 * much plan is left"; this answers "what is this machine actually carrying right now".
 */
function MachineSection() {
  const { sessionStats } = useGateway();
  if (sessionStats.length === 0) return null;
  const total = sessionStats.reduce((n, s) => n + s.rssBytes, 0);
  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">This machine</span>
        <span className="text-[10px] tabular-nums text-faint">
          {sessionStats.length} live · {fmtBytes(total)}
        </span>
      </div>
      <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
        {sessionStats.map((s) => (
          <li key={s.session} className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-xs text-muted">{s.name}</span>
            <span className="flex shrink-0 items-baseline gap-1.5">
              <span
                className={`text-xs font-medium tabular-nums ${
                  isHeavy(s.rssBytes) ? "text-[#e0a94b]": "text-ink"
                }`}
              >
                {fmtBytes(s.rssBytes)}
              </span>
              <span className="w-11 text-right text-[10px] tabular-nums text-faint">{fmtAge(s.ageMs)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-0.5 text-[10px] text-faint">resident memory · session age</p>
    </div>
  );
}

function UsagePanel({
  result,
  tokens,
  onClose,
  onRefresh,
}: {
  result: UsageResult;
  tokens: number | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const u = result.usage;
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    surface.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const session = sessionPct(result);
  const weekly = weeklyPct(result);
  const level = usageLevel(result);
  const weeklyLevel = weekly === null ? "unknown": weekly >= 90 ? "danger": weekly >= 75 ? "warn": "ok";
  const capped = blocks(result);
  const money = credits(u);
  const ctxLevel = !tokens ? "ok": tokens >= CTX_DANGER ? "danger": tokens >= CTX_WARN ? "warn": "ok";

  return (
    <>
      <span className="fixed inset-0 z-40 block cursor-default" onClick={onClose} />
      <div
        ref={surface}
        tabIndex={-1}
        role="dialog"
        aria-label="Plan usage"
        className="absolute right-0 top-8 z-50 w-72 rounded-xl border border-line bg-surface p-3 text-left shadow-2xl outline-none"
      >
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">This account</span>
          <button
            onClick={onClose}
            aria-label="Close plan usage"
            title="Close (Esc)"
            className="-mr-1 grid size-6 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink"
          >
            <X size={13} weight="bold" />
          </button>
        </div>
        {result.ok ? (
          <>
            <Window label="Session" pct={session} level={level} reset={fmtReset(u.session_resets_at)} />
            <Window label="This week" pct={weekly} level={weeklyLevel} reset={fmtReset(u.weekly_resets_at)} />
            {/* Quiet on purpose: a capped model is real, but it is not what the bars measure. */}
            {capped.length > 0 && (
              <p className="flex items-start gap-1.5 pt-0.5 text-[10px] text-[#e0a94b]">
                <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[#e0a94b]" />
                <span>
                  {capped.map((b) => `${b.scope ?? b.kind} at ${b.percent}%`).join(", ")}, capped for the
                  week, doesn't affect the windows above
                </span>
              </p>
            )}
            {money && (
              <div className="mt-1.5 border-t border-line pt-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="whitespace-nowrap text-xs text-muted">{money.label}</span>
                  <span className="text-xs font-medium tabular-nums text-ink">{money.value}</span>
                </div>
                <p className="mt-0.5 text-[10px] text-faint">{money.sub}</p>
              </div>
            )}
          </>
        ): (
          <p className="text-xs text-muted">
            Usage unknown: <span className="font-mono text-faint">{u.status}</span>.
            {u.status === "unauthenticated" && " The usage-check browser needs a fresh login."}
            {u.status === "browser_unavailable" && " The usage-check container is down."}
          </p>
        )}

        <div className="mt-2.5 border-t border-line pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-faint">
            This conversation
          </span>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="whitespace-nowrap text-xs text-muted">Context</span>
            <span className={`text-xs font-medium tabular-nums ${ctxLevel === "ok" ? "text-ink": "text-[#e0a94b]"}`}>
              {tokens ? fmtK(tokens): ": "}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-faint">
            {ctxLevel === "ok" ? "tokens in this chat": "large, every message re-bills it"}
          </p>
        </div>

        <MachineSection />

        <div className="mt-2 flex items-center justify-between text-[10px] text-faint">
          <span>{result.cached ? "cached": "fresh"} · {new Date(result.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <button onClick={onRefresh} className="underline hover:text-muted">
            refresh
          </button>
        </div>
      </div>
    </>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div data-tour="modes" className="flex rounded-full border border-line bg-bg p-0.5 text-xs font-medium">
      {(["terminal", "claude"] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={`rounded-full px-3 py-1 transition-colors ${
            mode === m ? "bg-accent text-bg": "text-muted hover:text-ink"
          }`}
        >
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}
