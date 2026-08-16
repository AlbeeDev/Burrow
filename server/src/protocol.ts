/**
 * Burrow wire protocol: the entire client/server contract.
 *
 * Modeled on OpenClaw's gateway protocol (apps/android/.../gateway/GatewayProtocol.kt,
 * MIT) but deliberately stripped to what a single-user VPS client needs. Three JSON
 * frame types travel over the WebSocket:
 *
 *   req: client asks the server to do something (matched to a res by `id`)
 *   res: server's answer to one req
 *   event: server pushes something the client did not ask for (e.g. streamed output)
 */

export const PROTOCOL_VERSION = 1;

/** Client → server. */
export type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

/** Server → client, answering a specific req. */
export type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

/** Server → client, unprompted (streamed output, lifecycle notifications). */
export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

export type ErrorShape = { code: string; message: string };

/** Methods the client may call. */
export const Method = {
  Connect: "connect",
  ProjectsList: "projects.list",
  ProjectsCreate: "projects.create",
  ProjectsRename: "projects.rename",
  ProjectsDelete: "projects.delete",
  GroupsGet: "groups.get",
  GroupsSet: "groups.set",
  TerminalOpen: "terminal.open",
  TerminalInput: "terminal.input",
  TerminalResize: "terminal.resize",
  TerminalClose: "terminal.close",
  // A view exists and expects this session to be there. Detaching (scrolling a panel out of view,
  // remounting) does NOT release it: only closing the panel or losing the browser does.
  TerminalHold: "terminal.hold",
  TerminalRelease: "terminal.release",
  TerminalKill: "terminal.kill",
  TerminalSetPersistent: "terminal.set_persistent",
  SessionsActive: "sessions.active",
  SessionsKillAll: "sessions.kill_all", // danger zone: end every burrow tmux session
  ClaudeSend: "claude.send",
  ClaudeAbort: "claude.abort",
  ClaudeControl: "claude.control", // answer a CLI control_request (UI buttons)
  ClaudeHistory: "claude.history",
  ContextSize: "context.size",
  UsageGet: "usage.get", // account-level plan usage (5-hour + weekly windows), server-cached
  // The Tailscale addon: is it available here, and publish/unpublish Burrow on the tailnet.
  // What this INSTALL has already been shown: the first-run tour, and each first-use hint.
  // Server-side because Burrow is opened from several browsers and devices by the same person,
  // and a per-browser flag would replay the tour on every one of them.
  OnboardingGet: "onboarding.get",
  OnboardingSeen: "onboarding.seen",
  TailscaleState: "tailscale.state",
  TailscaleServe: "tailscale.serve",
  ClaudeAccounts: "claude.accounts",
  ClaudeSetAccount: "claude.set_account",
  CommandsList: "commands.list",
  McpList: "mcp.list",
  McpSetDisabled: "mcp.set_disabled",
  ScheduleGet: "schedule.get",
  ScheduleSet: "schedule.set",
  SplitsGet: "splits.get",
  SplitsSet: "splits.set",
  SearchHistory: "search.history", // Cmd-K: full-text across all projects' session histories
  ImagesRecent: "images.recent", // images Claude pushed for a project (late attach / reload)
} as const;

/** Events the server may push. */
export const Event = {
  TerminalData: "terminal.data",
  TerminalExit: "terminal.exit",
  // Claude mode: each carries { project, message }, where message is either a raw
  // Claude Agent SDK message or a Burrow lifecycle marker (turn_start/turn_end/error).
  ClaudeEvent: "claude.event",
  // Claude called the `burrow` MCP server's show_image tool: { project, image }.
  // Broadcast, not per-conn: every browser looking at that project should see it.
  ImagePush: "image.push",
  // The strip changed with nothing new arriving (an `unshow`): refetch, do not open anything.
  PushChanged: "push.changed",
} as const;

export const ErrorCode = {
  Unauthorized: "unauthorized",
  InvalidRequest: "invalid_request",
  UnknownMethod: "unknown_method",
  NotFound: "not_found",
  Internal: "internal",
} as const;

export function isReqFrame(value: unknown): value is ReqFrame {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === "req" && typeof v.id === "string" && typeof v.method === "string";
}
