import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Gateway, gatewayUrl, type ConnStatus, type Project, type Schedule, type SavedSplit } from "./gateway";
import { groupColor } from "./groups";
import type { SessionStat } from "./sessionStats";

/** project name -> group label. Absent = ungrouped. */
export type Assignments = Record<string, string>;

type GatewayContextValue = {
  gateway: Gateway;
  status: ConnStatus;
  projects: Project[];
  groups: string[];
  assignments: Assignments;
  accounts: string[];
  activeAccount: string;
  setAccount: (id: string) => void;
  model: string;
  setModel: (m: string) => void;
  activeSessions: Set<string>;
  masterActive: boolean;
  /** Per-session memory + age, sampled server-side once a minute. Empty until the first sample. */
  sessionStats: SessionStat[];
  persistentProjects: Set<string>;
  setPersistent: (project: string, value: boolean) => void;
  assignProject: (project: string, group: string | null) => void;
  groupColors: Record<string, string>;
  colorOf: (group: string) => string;
  setGroupColor: (group: string, color: string) => void;
  /**
   * What this INSTALL has already been shown. `null` until the server answers, and callers must
   * treat that as "don't decide yet": showing the tour to somebody who finished it a month ago,
   * for the half second before the answer lands, is exactly the flash this avoids.
   *
   * Server-side rather than per-browser: Burrow is opened from several devices by one person, and
   * a localStorage flag replays the tour on every one of them.
   */
  onboarding: { tourDone: boolean; hintsSeen: Set<string> } | null;
  markSeen: (what: { tour?: true; hint?: string }) => void;
  deleteProject: (name: string) => Promise<void>;
  killTerminal: (project: string | null) => void;
  schedules: Schedule[];
  setSchedules: (next: Schedule[]) => void;
  splits: SavedSplit[];
  setSplits: (next: SavedSplit[]) => void;
  refresh: () => void;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

export function GatewayProvider({ children }: { children: ReactNode }) {
  const gatewayRef = useRef<Gateway>();
  if (!gatewayRef.current) {
    const token = import.meta.env.VITE_BURROW_TOKEN as string | undefined;
    gatewayRef.current = new Gateway(gatewayUrl(), token);
  }
  const gateway = gatewayRef.current;

  const [status, setStatus] = useState<ConnStatus>(gateway.status);
  const [projects, setProjects] = useState<Project[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [groupColors, setGroupColors] = useState<Record<string, string>>({});
  const [onboarding, setOnboarding] = useState<{ tourDone: boolean; hintsSeen: Set<string> } | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>("");
  const [model, setModelState] = useState<string>(() => localStorage.getItem("burrow.model") ?? "");

  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [masterActive, setMasterActive] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStat[]>([]);
  const [persistentProjects, setPersistentProjects] = useState<Set<string>>(new Set());
  const [schedules, setSchedulesState] = useState<Schedule[]>([]);
  const [splits, setSplitsState] = useState<SavedSplit[]>([]);
  // Account-level, not per project: any bubble turn in any project updates it, and it stays
  // put while you move around the app.

  const setModel = useCallback((m: string) => {
    setModelState(m);
    localStorage.setItem("burrow.model", m);
  }, []);

  const refresh = useCallback(() => {
    if (gateway.status !== "ready") return;
    gateway
.req<{ projects: Project[] }>("projects.list")
.then((r) => setProjects(r.projects))
.catch(() => {});
    gateway
.req<{
        groups: string[];
        assignments: Assignments;
        colors?: Record<string, string>;
      }>("groups.get")
.then((r) => {
        setGroups(r.groups ?? []);
        setAssignments(r.assignments ?? {});
        setGroupColors(r.colors ?? {});
      })
.catch(() => {});
    gateway
.req<{ accounts: string[]; active: string }>("claude.accounts")
.then((r) => {
        setAccounts(r.accounts ?? []);
        setActiveAccount(r.active ?? "");
      })
.catch(() => {});
    gateway
.req<{ schedules: Schedule[] }>("schedule.get")
.then((r) => setSchedulesState(r.schedules ?? []))
.catch(() => {});
    gateway
.req<{ splits: SavedSplit[] }>("splits.get")
.then((r) => setSplitsState(r.splits ?? []))
.catch(() => {});
    gateway
.req<{ tourDone: boolean; hintsSeen: string[] }>("onboarding.get")
.then((r) => setOnboarding({ tourDone: !!r.tourDone, hintsSeen: new Set(r.hintsSeen ?? []) }))
      // A failed read leaves it null, which shows nothing. Better than opening a tour at somebody
      // because one request lost a race.
.catch(() => {});
  }, [gateway]);

  const setSchedules = useCallback(
    (next: Schedule[]) => {
      setSchedulesState(next); // optimistic
      gateway
.req<{ schedules: Schedule[] }>("schedule.set", { schedules: next })
.then((r) => setSchedulesState(r.schedules ?? []))
.catch(() => {});
    },
    [gateway],
  );

  // Saved split layouts. Optimistic like the other stores, so renaming or reshaping a split
  // feels instant; the server's sanitized list wins once it answers.
  const setSplits = useCallback(
    (next: SavedSplit[]) => {
      setSplitsState(next);
      gateway
.req<{ splits: SavedSplit[] }>("splits.set", { splits: next })
.then((r) => setSplitsState(r.splits ?? []))
.catch(() => {});
    },
    [gateway],
  );

  // Which projects have a live terminal session (dots) + which are persistent (toggle).
  const fetchActive = useCallback(() => {
    if (gateway.status !== "ready") return;
    gateway
.req<{
        active: string[];
        master: boolean;
        persistent: string[];
        stats?: SessionStat[];
        statsAt?: number;
      }>("sessions.active")
.then((r) => {
        setActiveSessions(new Set(r.active ?? []));
        setMasterActive(!!r.master);
        setPersistentProjects(new Set(r.persistent ?? []));
        setSessionStats(r.stats ?? []);
      })
.catch(() => {});
  }, [gateway]);

  const setPersistent = useCallback(
    (project: string, value: boolean) => {
      setPersistentProjects((prev) => {
        const next = new Set(prev);
        value ? next.add(project): next.delete(project);
        return next;
      }); // optimistic
      gateway.req("terminal.set_persistent", { project, persistent: value }).catch(() => {});
    },
    [gateway],
  );

  // Assign a project to a group (or null to ungroup). Optimistic, then persists the whole
  // groups config. Shared by the sidebar drag-drop and the in-chat group picker.
  const assignProject = useCallback(
    (project: string, group: string | null) => {
      const next = {...assignments };
      if (group) next[project] = group;
      else delete next[project];
      setAssignments(next);
      gateway.req("groups.set", { groups, assignments: next, colors: groupColors }).catch(() => {});
    },
    [assignments, groups, groupColors, gateway],
  );

  /**
   * Record that the tour, or one hint, has been seen. Optimistic: the flag is set locally at once
   * so the box closes immediately, and the server is told after. A failed write costs one repeat
   * on the next load, which is the cheapest possible failure here.
   */
  const markSeen = useCallback(
    (what: { tour?: true; hint?: string }) => {
      setOnboarding((prev) => {
        const base = prev ?? { tourDone: false, hintsSeen: new Set<string>() };
        const hintsSeen = new Set(base.hintsSeen);
        if (what.hint) hintsSeen.add(what.hint);
        return { tourDone: base.tourDone || what.tour === true, hintsSeen };
      });
      gateway.req("onboarding.seen", what).catch(() => {});
    },
    [gateway],
  );

  // A group's color: user-chosen if set, else deterministic from the name.
  const colorOf = useCallback(
    (group: string) => groupColors[group] ?? groupColor(group),
    [groupColors],
  );

  const setGroupColor = useCallback(
    (group: string, color: string) => {
      const next = {...groupColors, [group]: color };
      setGroupColors(next); // optimistic
      gateway.req("groups.set", { groups, assignments, colors: next }).catch(() => {});
    },
    [groups, assignments, groupColors, gateway],
  );

  const deleteProject = useCallback(
    async (name: string) => {
      await gateway.req("projects.delete", { name });
      refresh();
    },
    [gateway, refresh],
  );

  // Hard-end a project's terminal session (even persistent). The mode toggle calls this when
  // leaving the terminal, so re-entering it starts fresh and current.
  const killTerminal = useCallback(
    (project: string | null) => {
      gateway.req("terminal.kill", { project }).catch(() => {});
    },
    [gateway],
  );

  const setAccount = useCallback(
    (id: string) => {
      setActiveAccount(id); // optimistic
      gateway
.req<{ active: string }>("claude.set_account", { account: id })
.then((r) => setActiveAccount(r.active))
.catch(() => {});
    },
    [gateway],
  );

  useEffect(() => {
    const off = gateway.onStatus(setStatus);
    gateway.start();
    return () => {
      off();
      gateway.stop();
    };
  }, [gateway]);

  // Load on connect, poll for new/removed folders, and reload on reconnect.
  useEffect(() => {
    if (status !== "ready") return;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [status, refresh]);

  // Session activity changes fast (open/drain/kill), poll it on a tighter cadence.
  useEffect(() => {
    if (status !== "ready") return;
    fetchActive();
    const timer = setInterval(fetchActive, 5000);
    return () => clearInterval(timer);
  }, [status, fetchActive]);

  return (
    <GatewayContext.Provider
      value={{
        gateway,
        status,
        projects,
        groups,
        assignments,
        accounts,
        activeAccount,
        setAccount,
        model,
        setModel,
        activeSessions,
        masterActive,
        sessionStats,
        persistentProjects,
        setPersistent,
        assignProject,
        groupColors,
        colorOf,
        setGroupColor,
        onboarding,
        markSeen,
        deleteProject,
        killTerminal,
        schedules,
        setSchedules,
        splits,
        setSplits,
        refresh,
      }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) throw new Error("useGateway must be used within GatewayProvider");
  return ctx;
}
