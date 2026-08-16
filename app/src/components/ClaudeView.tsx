import { memo, useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PaperPlaneRight,
  Terminal as TerminalIcon,
  PencilSimple,
  FileText,
  MagnifyingGlass,
  Wrench,
  Sparkle,
  Warning,
  Plus,
  ArrowsInSimple,
  Stop,
  Brain,
  CaretDown,
  Robot,
} from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import { Markdown } from "./Markdown";
import { ToolDiff, isDiffTool, diffStats } from "./ToolDiff";
import { parseCommandText, looksLikeExpansion } from "../lib/slashCommand";

/** One rendered item in the Claude conversation. */
type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "thinking"; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  // A slash command the user ran: shown as a compact `/name args` chip, never as the CLI's
  // raw `<command-name>` markup (the terminal hides that, so the bubble mirror does too).
  | { kind: "command"; name: string; args: string }
  // A `!` bash-mode line and, as its own item, whatever it printed, same reason as above:
  // the CLI stores `<bash-input>` / `<bash-stdout>` tag soup that the terminal never shows.
  | { kind: "bash"; command: string }
  | { kind: "bashOut"; stdout: string; stderr: string }
  // The instruction text the CLI replays as a user turn after a command, collapsed by
  // default so a skill's whole body doesn't wall off the conversation.
  | { kind: "expansion"; text: string }
  // An image block in a user message (pasted/attached), rendered inline as a thumbnail.
  | { kind: "image"; src: string }
  // An interactive control request from the CLI (question/permission prompt), rendered as
  // real buttons; answering sends a control_response back over the persistent process' stdin.
  | { kind: "control"; id: string; title: string; detail?: string; options: string[]; answered?: string };

type Usage = { input: number; output: number; cost: number };
// `pending` = messages queued mid-turn. They live OUTSIDE items[] (rendered at the feed's
// bottom) so the streaming reducer never has to reach past them, and each one enters the
// real feed only when its own turn starts, keeping user→reply order correct.
type State = { items: Item[]; working: boolean; usage?: Usage; pending: string[] };
type Action =
  | { t: "reset" }
  | { t: "user"; text: string }
  | { t: "queue_push"; text: string }
  | { t: "queue_started" }
  | { t: "queue_cleared" }
  | { t: "assistant"; text: string }
  | { t: "tool"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; result: string; isError: boolean }
  | { t: "note"; text: string }
  | { t: "command"; name: string; args: string }
  | { t: "bash"; command: string }
  | { t: "bash_out"; stdout: string; stderr: string }
  | { t: "expansion"; text: string }
  | { t: "usage"; usage: Usage }
  | { t: "stream_start" }
  | { t: "stream_delta"; text: string }
  | { t: "stream_stop" }
  | { t: "thinking"; text: string }
  | { t: "thinking_start" }
  | { t: "thinking_delta"; text: string }
  | { t: "error"; text: string }
  | { t: "working"; on: boolean }
  | { t: "image"; src: string }
  | { t: "control"; id: string; title: string; detail?: string; options: string[] }
  | { t: "control_answered"; id: string; answer: string };

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case "reset":
      return { items: [], working: false, pending: [] };
    case "stream_start":
      return {...state, items: [...state.items, { kind: "assistant", text: "", streaming: true }] };
    case "stream_delta": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        const items = state.items.slice(0, -1);
        return {...state, items: [...items, {...last, text: last.text + a.text }] };
      }
      return {...state, items: [...state.items, { kind: "assistant", text: a.text, streaming: true }] };
    }
    case "stream_stop": {
      // Finalize whichever block was streaming: text (assistant) or reasoning (thinking).
      const last = state.items[state.items.length - 1];
      if ((last?.kind === "assistant" || last?.kind === "thinking") && last.streaming) {
        const items = state.items.slice(0, -1);
        return {...state, items: [...items, {...last, streaming: false }] };
      }
      return state;
    }
    case "thinking":
      return {...state, items: [...state.items, { kind: "thinking", text: a.text }] };
    case "thinking_start":
      return {...state, items: [...state.items, { kind: "thinking", text: "", streaming: true }] };
    case "thinking_delta": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        const items = state.items.slice(0, -1);
        return {...state, items: [...items, {...last, text: last.text + a.text }] };
      }
      return {...state, items: [...state.items, { kind: "thinking", text: a.text, streaming: true }] };
    }
    case "note":
      return {...state, items: [...state.items, { kind: "note", text: a.text }] };
    case "command":
      return {...state, items: [...state.items, { kind: "command", name: a.name, args: a.args }] };
    case "bash":
      return {...state, items: [...state.items, { kind: "bash", command: a.command }] };
    case "bash_out":
      return {
...state,
        items: [...state.items, { kind: "bashOut", stdout: a.stdout, stderr: a.stderr }],
      };
    case "expansion":
      return {...state, items: [...state.items, { kind: "expansion", text: a.text }] };
    case "usage":
      return {...state, usage: a.usage };
    case "user":
      return {...state, items: [...state.items, { kind: "user", text: a.text }] };
    case "queue_push":
      return {...state, pending: [...state.pending, a.text] };
    case "queue_cleared":
      // Stop dropped the server-side queue: remove the never-delivered bubbles to match.
      return {...state, pending: [] };
    case "queue_started": {
      // A new turn began: the oldest queued message enters the feed NOW, below the previous
      // reply, so the transcript reads user→reply→user→reply.
      const [next, ...rest] = state.pending;
      if (next === undefined) return state;
      return {...state, items: [...state.items, { kind: "user", text: next }], pending: rest };
    }
    case "image":
      return {...state, items: [...state.items, { kind: "image", src: a.src }] };
    case "assistant":
      return {...state, items: [...state.items, { kind: "assistant", text: a.text }] };
    case "tool":
      return {
...state,
        items: [...state.items, { kind: "tool", id: a.id, name: a.name, input: a.input }],
      };
    case "tool_result":
      return {
...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.id === a.id ? {...it, result: a.result, isError: a.isError }: it,
        ),
      };
    case "error":
      return {...state, items: [...state.items, { kind: "error", text: a.text }], working: false };
    case "working":
      return {...state, working: a.on };
    case "control":
      return {
...state,
        items: [...state.items, { kind: "control", id: a.id, title: a.title, options: a.options, ...(a.detail ? { detail: a.detail }: {}) }],
      };
    case "control_answered":
      return {
...state,
        items: state.items.map((it) =>
          it.kind === "control" && it.id === a.id ? {...it, answered: a.answer }: it,
        ),
      };
  }
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k`: String(n);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
.map((b) => (b && typeof b === "object" && "text" in b ? String((b as any).text): ""))
.join("");
  return "";
}

/**
 * Mutable per-conversation state dispatchContent needs across messages: a command's
 * expansion is only identifiable as "the text-only user message right after a command".
 */
type CmdCtx = { awaitingExpansion: boolean };

/**
 * Map one message's content to reducer actions. Shared by live events and by history
 * replay, so a stored session renders identically to a live one. A user message may be
 * a prompt (text), slash-command markup, or tool results; an assistant message is text
 * and/or tool_use blocks.
 */
function dispatchContent(
  dispatch: (a: Action) => void,
  role: string,
  content: unknown,
  ctx: CmdCtx,
) {
  if (role === "user") {
    if (typeof content === "string") {
      const cmd = parseCommandText(content);
      if (cmd) {
        ctx.awaitingExpansion = cmd.kind === "command";
        if (cmd.kind === "command") {
          dispatch({ t: "command", name: cmd.name, args: cmd.args });
          if (cmd.output) dispatch({ t: "note", text: cmd.output });
        } else if (cmd.kind === "output") {
          dispatch({ t: "note", text: cmd.text });
        } else if (cmd.kind === "bash") {
          dispatch({ t: "bash", command: cmd.command });
        } else if (cmd.kind === "bashOutput") {
          dispatch({ t: "bash_out", stdout: cmd.stdout, stderr: cmd.stderr });
        }
        return; // "drop" renders nothing: it's terminal plumbing
      }
      ctx.awaitingExpansion = false;
      if (content.trim()) dispatch({ t: "user", text: content });
      return;
    }
    const blocks = (content as any[]) ?? [];
    if (ctx.awaitingExpansion) {
      ctx.awaitingExpansion = false;
      const joined = blocks.map((b) => (b?.type === "text" ? String(b.text ?? ""): "")).join("\n");
      if (looksLikeExpansion(blocks, joined)) {
        dispatch({ t: "expansion", text: joined });
        return;
      }
    }
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) {
        const cmd = parseCommandText(b.text);
        if (cmd?.kind === "command") {
          ctx.awaitingExpansion = true;
          dispatch({ t: "command", name: cmd.name, args: cmd.args });
          if (cmd.output) dispatch({ t: "note", text: cmd.output });
        } else if (cmd?.kind === "output") dispatch({ t: "note", text: cmd.text });
        else if (cmd?.kind === "bash") dispatch({ t: "bash", command: cmd.command });
        else if (cmd?.kind === "bashOutput")
          dispatch({ t: "bash_out", stdout: cmd.stdout, stderr: cmd.stderr });
        else if (!cmd) dispatch({ t: "user", text: b.text });
      } else if (b.type === "image" && b.source?.type === "base64" && b.source.data)
        dispatch({ t: "image", src: `data:${b.source.media_type ?? "image/png"};base64,${b.source.data}` });
      else if (b.type === "tool_result")
        dispatch({
          t: "tool_result",
          id: b.tool_use_id,
          result: textOf(b.content).slice(0, 4000),
          isError: !!b.is_error,
        });
    }
    return;
  }
  if (role === "assistant") {
    ctx.awaitingExpansion = false; // a reply ends the command→expansion pair
    if (typeof content === "string") {
      if (content.trim()) dispatch({ t: "assistant", text: content });
      return;
    }
    for (const b of (content as any[]) ?? []) {
      if (b.type === "text" && b.text?.trim()) dispatch({ t: "assistant", text: b.text });
      else if (b.type === "thinking" && b.thinking?.trim()) dispatch({ t: "thinking", text: b.thinking });
      else if (b.type === "tool_use") dispatch({ t: "tool", id: b.id, name: b.name, input: b.input });
    }
  }
}

type SlashCommand = { name: string; description: string | null; scope: string };

export function ClaudeView({ project }: { project: string | null }) {
  const { gateway, status, model } = useGateway();
  const [state, dispatch] = useReducer(reducer, { items: [], working: false, pending: [] });
  const [draft, setDraft] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [confirmNew, setConfirmNew] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const freshRef = useRef(false); // arm a brand-new session for the next send
  // Shared by the live stream and history replay so both see the same command→expansion pairing.
  const cmdCtx = useRef<CmdCtx>({ awaitingExpansion: false });

  // Custom slash-command autocomplete: match while the draft is just "/name".
  const slashMatch = /^\/([\w:-]*)$/.exec(draft);
  const suggestions = slashMatch
    ? commands.filter((c) => c.name.startsWith(slashMatch[1] ?? "")).slice(0, 8): [];
  const showPalette = suggestions.length > 0;
  function complete(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  // Stream Claude events for this project into the conversation model.
  useEffect(() => {
    const off = gateway.on("claude.event", ({ project: p, message }: { project: string | null; message: any }) => {
      if ((p ?? null) !== project) return;
      switch (message.type) {
        case "turn_start":
          dispatch({ t: "working", on: true });
          dispatch({ t: "queue_started" }); // if a queued message started this turn, un-badge it
          break;
        case "turn_end":
          dispatch({ t: "working", on: false });
          break;
        case "error":
          dispatch({ t: "error", text: message.error ?? "Claude error" });
          break;
        case "stream_event": {
          const ev = message.event;
          if (ev?.type === "content_block_start") {
            if (ev.content_block?.type === "text") dispatch({ t: "stream_start" });
            else if (ev.content_block?.type === "thinking") dispatch({ t: "thinking_start" });
          } else if (ev?.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta") dispatch({ t: "stream_delta", text: ev.delta.text });
            else if (ev.delta?.type === "thinking_delta")
              dispatch({ t: "thinking_delta", text: ev.delta.thinking });
          } else if (ev?.type === "content_block_stop") dispatch({ t: "stream_stop" });
          break;
        }
        case "assistant":
          // Text already arrived via stream deltas; here we only add tool-call cards.
          for (const b of message.message?.content ?? [])
            if (b.type === "tool_use") dispatch({ t: "tool", id: b.id, name: b.name, input: b.input });
          break;
        case "user":
          dispatchContent(dispatch, "user", message.message?.content ?? [], cmdCtx.current);
          break;
        case "system":
          if (message.subtype === "compact_boundary") dispatch({ t: "note", text: "Context compacted" });
          break;
        // `rate_limit_event` is deliberately ignored. It only speaks mid-turn and
        // only once you've already hit the wall; the header's usage bar reads the account's real
        // windows from usage-check instead, whether or not a turn is running.
        case "control_request": {
          // Interactive request from the CLI (question / permission prompt). Shapes vary by
          // subtype, so extract defensively; unrenderable requests still show raw detail.
          const req = message.request ?? {};
          const rawOpts: unknown[] = Array.isArray(req.options) ? req.options: [];
          const options = rawOpts
.map((o: any) => (typeof o === "string" ? o: (o?.label ?? o?.name ?? "")))
.filter(Boolean);
          dispatch({
            t: "control",
            id: message.request_id ?? "",
            title:
              typeof req.question === "string"
                ? req.question: typeof req.tool_name === "string"
                  ? `Allow ${req.tool_name}?`: "Claude is asking",
...(typeof req.header === "string" ? { detail: req.header }: {}),
            options: options.length ? options: ["Allow", "Deny"],
          });
          break;
        }
        case "result":
          // Don't re-enable input here; wait for turn_end (by which point the server has
          // freed the turn) so a fast reply isn't rejected as "already running".
          if (message.usage)
            dispatch({
              t: "usage",
              usage: {
                input: (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
                output: message.usage.output_tokens ?? 0,
                cost: message.total_cost_usd ?? 0,
              },
            });
          break;
      }
    });
    return off;
  }, [gateway, project]);

  // Mirror the real on-disk conversation: load this project's latest Claude session and
  // render it. Reopening a project re-reads from disk (the source of truth), so switching
  // away and back keeps the conversation.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    gateway
.req<{ messages: { role: string; content: unknown }[] }>("claude.history", { project })
.then((r) => {
        if (cancelled) return;
        dispatch({ t: "reset" });
        cmdCtx.current.awaitingExpansion = false;
        for (const m of r.messages ?? []) dispatchContent(dispatch, m.role, m.content, cmdCtx.current);
      })
.catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gateway, status, project]);

  // Load this project's custom slash commands for the composer palette.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    gateway
.req<{ commands: SlashCommand[] }>("commands.list", { project })
.then((r) => !cancelled && setCommands(r.commands ?? []))
.catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gateway, status, project]);

  // Keep the feed pinned to the newest message. Markdown + syntax highlighting reflow AFTER
  // mount, so a single rAF fires too early and leaves a freshly-loaded history stuck at the
  // top. A ResizeObserver on the content re-pins whenever its height changes (history load,
  // streaming, reflow), but only while the user is already near the bottom, so scrolling up
  // to read earlier messages isn't hijacked. Re-inits per project (each opens at the bottom).
  useEffect(() => {
    const el = feedRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let stick = true;
    const onScroll = () => {
      stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const pin = () => {
      if (stick) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(pin);
    ro.observe(content);
    pin(); // land at the bottom on open
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [project]);

  function send() {
    const text = draft.trim();
    if (!text || status !== "ready") return;
    // Mid-turn sends queue server-side (FIFO), shown as pending bubbles at the feed's
    // bottom, entering the real transcript when their own turn starts.
    if (state.working) dispatch({ t: "queue_push", text });
    else {
      dispatch({ t: "user", text });
      dispatch({ t: "working", on: true });
    }
    setDraft("");
    const fresh = freshRef.current;
    freshRef.current = false;
    gateway
.req("claude.send", { project, message: text, ...(model ? { model }: {}), ...(fresh ? { fresh }: {}) })
.catch((e) => dispatch({ t: "error", text: e.message }));
  }

  // Red "New": clear the feed and start a fresh session on the next message.
  function newChat() {
    if (state.working) return;
    dispatch({ t: "reset" });
    freshRef.current = true;
    inputRef.current?.focus();
  }

  // Stop the in-flight turn (interrupts the persistent CLI process server-side).
  function abort() {
    dispatch({ t: "queue_cleared" });
    gateway.req("claude.abort", { project }).catch(() => {});
  }

  // Answer an interactive control request (buttons in a ControlCard).
  function answerControl(id: string, answer: string) {
    dispatch({ t: "control_answered", id, answer });
    gateway.req("claude.control", { project, requestId: id, response: { answer } }).catch(() => {});
  }

  // What the working indicator says, and whether to show it at all. While text/thinking is
  // visibly streaming the indicator is redundant (the live bubble already shows progress).
  const lastItem = state.items[state.items.length - 1];
  const streamingVisible =
    (lastItem?.kind === "assistant" || lastItem?.kind === "thinking") && !!lastItem.streaming;
  const activity =
    lastItem?.kind === "tool" && lastItem.result === undefined
      ? lastItem.name === "Task"
        ? "Running a subagent": `Running ${lastItem.name}`: lastItem?.kind === "thinking"
        ? "Thinking": "Working";

  // Blue "Compact": run /compact to summarize context (works headlessly, verified).
  function compact() {
    if (state.working || status !== "ready") return;
    dispatch({ t: "working", on: true });
    gateway
.req("claude.send", { project, message: "/compact" })
.catch((e) => dispatch({ t: "error", text: e.message }));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-end gap-2 border-b border-line px-3 py-2">
        <button
          onClick={compact}
          disabled={state.working || status !== "ready"}
          title="Compact context (/compact)"
          className="flex items-center gap-1 rounded-lg border border-sky-400/40 px-2.5 py-1 text-xs font-medium text-sky-400 hover:bg-sky-400/10 disabled:opacity-40"
        >
          <ArrowsInSimple size={14} weight="bold" /> Compact
        </button>
        <button
          onClick={() => setConfirmNew(true)}
          disabled={state.working}
          title="Start a new session"
          className="flex items-center gap-1 rounded-lg border border-danger/40 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
        >
          <Plus size={14} weight="bold" /> New
        </button>
      </div>

      {confirmNew &&
        createPortal(
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
            onClick={() => setConfirmNew(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="text-base font-semibold text-ink">Start a new session?</h2>
              <p className="mt-1.5 text-sm text-muted">
                This clears the current view, and your next message begins a fresh chat. Your current
                conversation stays saved on the VPS: you can still reach it later.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setConfirmNew(false)}
                  className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:text-ink"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setConfirmNew(false);
                    newChat();
                  }}
                  className="rounded-lg bg-danger px-4 py-1.5 text-sm font-medium text-white"
                >
                  Start new
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={contentRef} className="flex flex-col gap-3">
          {state.items.length === 0 && !state.working && <Welcome project={project} />}
          {state.items.map((it, i) =>
            it.kind === "control" ? (
              <ControlCard key={i} item={it} onAnswer={(ans) => answerControl(it.id, ans)} />
            ): (
              <ItemView key={i} item={it} />
            ),
          )}
          {state.working && !streamingVisible && <Working activity={activity} />}
          {state.pending.map((text, i) => (
            <div key={`pending-${i}`} className="flex flex-col items-end gap-0.5">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-bg opacity-60">
                {text}
              </div>
              <span className="pr-1 text-[10px] text-faint">queued</span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-line p-3">
        {(state.pending.length > 0 || state.usage) && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-faint">
            {/* Queued messages are visible as dimmed bubbles in the feed, but the feed may be
                scrolled away: the composer is where you're looking when you queue another. */}
            {state.pending.length > 0 && (
              <span className="inline-flex shrink-0 items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-medium text-accent">
                {state.pending.length} queued
              </span>
            )}
            {state.usage && (
              <span className="truncate">
                ctx {fmtTokens(state.usage.input)} · out {fmtTokens(state.usage.output)} · $
                {state.usage.cost.toFixed(4)}
              </span>
            )}
          </div>
        )}
        {showPalette && (
          <div className="mb-2 max-h-52 overflow-y-auto rounded-lg border border-line bg-bg">
            {suggestions.map((c) => (
              <button
                key={c.name}
                onClick={() => complete(c.name)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised"
              >
                <span className="shrink-0 font-mono text-xs text-accent">/{c.name}</span>
                {c.description && <span className="truncate text-xs text-faint">{c.description}</span>}
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-faint">
                  {c.scope}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-bg px-3 py-2 focus-within:border-accent">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (showPalette && e.key === "Tab") {
                e.preventDefault();
                const top = suggestions[0];
                if (top) complete(top.name);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={status === "ready" ? "Message Claude…  (/ for commands)": "Connecting…"}
            className="max-h-40 flex-1 resize-none bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
          />
          {state.working ? (
            <div className="flex shrink-0 gap-1.5">
              {draft.trim() && (
                <button
                  onClick={send}
                  className="grid size-9 place-items-center rounded-lg border border-accent/50 text-accent transition-colors hover:bg-accent hover:text-bg"
                  aria-label="Queue message"
                  title="Queue: sends when the current turn ends"
                >
                  <PaperPlaneRight size={16} weight="fill" />
                </button>
              )}
              <button
                onClick={abort}
                className="grid size-9 place-items-center rounded-lg bg-danger text-white"
                aria-label="Stop"
                title="Stop (also clears queued messages)"
              >
                <Stop size={16} weight="fill" />
              </button>
            </div>
          ): (
            <button
              onClick={send}
              disabled={!draft.trim() || status !== "ready"}
              className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-bg transition-opacity disabled:opacity-40"
              aria-label="Send"
            >
              <PaperPlaneRight size={17} weight="fill" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Memoized: message bubbles are expensive (markdown parsing), and the composer's `draft`
// state lives in the parent: without this, every keystroke re-rendered every bubble. Item
// refs are stable across renders (the reducer only replaces changed items), so memo skips
// all unchanged bubbles while you type.
const ItemView = memo(function ItemView({ item }: { item: Item }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-bg">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "assistant") {
    return (
      <div className="flex max-w-[85%] gap-2.5">
        <Avatar />
        <div className="min-w-0 break-words rounded-xl rounded-tl-sm border border-line bg-raised px-3.5 py-2 text-sm text-ink">
          {item.text ? <Markdown>{item.text}</Markdown>: <span className="text-faint">▌</span>}
        </div>
      </div>
    );
  }
  if (item.kind === "error") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
        <Warning size={16} weight="fill" /> {item.text}
      </div>
    );
  }
  if (item.kind === "note") {
    return (
      <div className="mx-auto rounded-full bg-raised px-3 py-0.5 text-[11px] text-faint">
        · {item.text} ·
      </div>
    );
  }
  if (item.kind === "image") {
    // Pasted/attached image in a user message, thumbnail, aligned with user bubbles.
    return (
      <div className="flex justify-end">
        <img
          src={item.src}
          alt="attached"
          className="max-h-56 max-w-[70%] rounded-xl rounded-br-sm border border-line object-contain"
        />
      </div>
    );
  }
  if (item.kind === "command") {
    // A slash command reads as an action, not a sentence, so it gets its own compact chip
    // on the user side instead of a full message bubble.
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-baseline gap-1.5 overflow-hidden rounded-lg rounded-br-sm border border-accent/40 bg-accent/10 px-2.5 py-1 font-mono text-xs">
          <span className="shrink-0 font-semibold text-accent">{item.name}</span>
          {item.args && <span className="truncate text-muted">{item.args}</span>}
        </div>
      </div>
    );
  }
  if (item.kind === "bash") {
    // `!ls` is a shell line, not a message: same compact chip treatment as a slash command,
    // but neutral-bordered so it doesn't read as one of Claude's own commands.
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-baseline gap-1.5 overflow-hidden rounded-lg rounded-br-sm border border-line bg-raised px-2.5 py-1 font-mono text-xs">
          <span className="shrink-0 font-semibold text-accent">!</span>
          <span className="truncate text-ink">{item.command}</span>
        </div>
      </div>
    );
  }
  if (item.kind === "bashOut") {
    // What the shell printed. Clamped so a 500-line dump can't swallow the conversation;
    // stderr is separated and colored, because "it failed" is the part you're scanning for.
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-bg">
        {item.stdout && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted">
            {item.stdout}
          </pre>
        )}
        {item.stderr && (
          <pre
            className={`max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-danger ${
              item.stdout ? "border-t border-line": ""
            }`}
          >
            {item.stderr}
          </pre>
        )}
      </div>
    );
  }
  if (item.kind === "expansion") return <ExpansionCard item={item} />;
  if (item.kind === "thinking") return <ThinkingCard item={item} />;
  if (item.kind === "control") return null; // rendered via ControlCard at the call site
  return <ToolCard item={item} />;
});

// An interactive request from Claude (question / permission ask) rendered as real buttons.
// Answering sends a control_response back to the persistent CLI process and locks the card.
function ControlCard({
  item,
  onAnswer,
}: {
  item: Extract<Item, { kind: "control" }>;
  onAnswer: (answer: string) => void;
}) {
  return (
    <div className="ml-9 max-w-[85%] rounded-xl border border-accent/40 bg-accent/5 px-3.5 py-2.5">
      <p className="text-sm text-ink">{item.title}</p>
      {item.detail && <p className="mt-0.5 text-xs text-muted">{item.detail}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.options.map((opt) => (
          <button
            key={opt}
            disabled={!!item.answered}
            onClick={() => onAnswer(opt)}
            className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
              item.answered === opt
                ? "bg-accent text-bg": item.answered
                  ? "border border-line text-faint opacity-50": "border border-accent/50 text-accent hover:bg-accent hover:text-bg"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// The instruction text a command expands into, replayed by the CLI as a user turn. Collapsed
// by default (it's often hundreds of lines), the conversation stays readable, but the real
// text is one click away when you're debugging what a command actually sent.
function ExpansionCard({ item }: { item: Extract<Item, { kind: "expansion" }> }) {
  const [open, setOpen] = useState(false);
  const lines = item.text.split("\n").length;
  return (
    <div className="ml-9 max-w-[85%] overflow-hidden rounded-lg border border-line-soft bg-bg/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <FileText size={14} weight="bold" className="shrink-0 text-muted" />
        <span className="text-xs font-medium text-muted">
          Command instructions · {lines} line{lines === 1 ? "": "s"}
        </span>
        <CaretDown
          size={12}
          weight="bold"
          className={`ml-auto shrink-0 text-faint transition-transform ${open ? "rotate-180": ""}`}
        />
      </button>
      {open && (
        <div className="max-h-80 overflow-y-auto border-t border-line-soft px-3 py-2">
          <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-faint">
            {item.text}
          </div>
        </div>
      )}
    </div>
  );
}

// Claude's reasoning, streamed as a collapsible bubble. Auto-open while it streams so you can
// watch it think; stays togglable after. Muted styling keeps it visually secondary to answers.
function ThinkingCard({ item }: { item: Extract<Item, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(!!item.streaming);
  return (
    <div className="ml-9 max-w-[85%] overflow-hidden rounded-lg border border-line-soft bg-bg/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <Brain size={14} weight="bold" className="shrink-0 text-muted" />
        <span className="text-xs font-medium text-muted">
          Thinking{item.streaming ? "…": ""}
        </span>
        <CaretDown
          size={12}
          weight="bold"
          className={`ml-auto shrink-0 text-faint transition-transform ${open ? "rotate-180": ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-line-soft px-3 py-2">
          <div className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-faint">
            {item.text || "…"}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  // File edits open by default so the diff is visible without a tap; other tools
  // (Bash/Read, which can be long) stay collapsed.
  const [open, setOpen] = useState(isDiffTool(item.name));
  const isTask = item.name === "Task";
  const summary = toolSummary(item.name, item.input);
  const stats = diffStats(item.name, item.input);
  return (
    <div
      className={`ml-9 max-w-[85%] shrink-0 overflow-hidden rounded-lg border ${
        isTask ? "border-accent-2/40 bg-accent-2/5": "border-line-soft bg-bg/60"
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span className={isTask ? "text-accent-2": "text-muted"}>{toolIcon(item.name)}</span>
        <span className="font-mono text-xs font-medium text-muted">{isTask ? "Subagent": item.name}</span>
        {summary && <span className="truncate font-mono text-xs text-faint">{summary}</span>}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            {stats.added > 0 && <span className="text-ok">+{stats.added}</span>}
            {stats.added > 0 && stats.removed > 0 && " "}
            {stats.removed > 0 && <span className="text-danger">−{stats.removed}</span>}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {item.result === undefined ? (
            <span className="size-2 animate-pulse rounded-full bg-accent-2" />
          ): (
            <span className={`size-2 rounded-full ${item.isError ? "bg-danger": "bg-ok"}`} />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-line-soft px-3 py-2">
          {isDiffTool(item.name) ? (
            <div className="mb-2">
              <ToolDiff name={item.name} input={item.input} />
            </div>
          ): (
            <pre className="mb-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          )}
          {item.result !== undefined && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-line-soft pt-2 font-mono text-[11px] text-faint">
              {item.result || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function toolIcon(name: string) {
  const props = { size: 15, weight: "bold" as const };
  if (name === "Task") return <Robot {...props} />;
  if (name === "Bash") return <TerminalIcon {...props} />;
  if (name === "Edit" || name === "Write" || name === "MultiEdit") return <PencilSimple {...props} />;
  if (name === "Read") return <FileText {...props} />;
  if (name === "Grep" || name === "Glob") return <MagnifyingGlass {...props} />;
  return <Wrench {...props} />;
}

function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Task") return input.description ?? input.subagent_type ?? "";
  if (name === "Bash") return input.description ?? input.command ?? "";
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit")
    return input.file_path ?? "";
  if (name === "Grep") return input.pattern ?? "";
  if (name === "Glob") return input.pattern ?? "";
  const first = Object.values(input)[0];
  return typeof first === "string" ? first: "";
}

function Avatar() {
  return (
    <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
      <Sparkle size={15} weight="fill" />
    </div>
  );
}

function Working({ activity }: { activity: string }) {
  return (
    <div className="flex items-center gap-2.5 text-muted">
      <Avatar />
      <div className="flex items-center gap-2 rounded-xl rounded-tl-sm border border-line bg-raised px-3.5 py-2.5">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1.5 animate-bounce rounded-full bg-faint"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          ))}
        </span>
        <span className="text-xs text-faint">{activity}…</span>
      </div>
    </div>
  );
}

function Welcome({ project }: { project: string | null }) {
  return (
    <div className="m-auto max-w-sm text-center">
      <div className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-accent-soft text-accent">
        <Sparkle size={20} weight="fill" />
      </div>
      <p className="text-sm text-muted">
        Claude Code, running in{" "}
        <span className="font-mono text-ink">{project ?? "the VPS root"}</span>. Ask it to build,
        debug, or explain: its tools and replies stream in here.
      </p>
    </div>
  );
}
