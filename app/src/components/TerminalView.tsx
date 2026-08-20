import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Copy, ClipboardText } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import { FONT_EVENT, termFontSize } from "../lib/termFont";
import { panelFocusRequest, splitToggleRequest } from "../lib/shortcuts";

// Warm-dark terminal theme that matches the app's ember identity.
const THEME = {
  background: "#161009",
  foreground: "#efe9e0",
  cursor: "#f2792b",
  cursorAccent: "#161009",
  selectionBackground: "rgba(242,121,43,0.35)",
  black: "#241d15",
  red: "#e5604d",
  green: "#5fb87a",
  yellow: "#e0a94b",
  blue: "#6ea9d6",
  magenta: "#c98bd0",
  cyan: "#5fb8ad",
  white: "#efe9e0",
  brightBlack: "#6f6556",
  brightRed: "#ff7a68",
  brightGreen: "#7fd89a",
  brightYellow: "#ffc76b",
  brightBlue: "#8fc3ec",
  brightMagenta: "#e0a6e6",
  brightCyan: "#7fd8cd",
  brightWhite: "#ffffff",
} as const;

/**
 * `autoFocus`: should this terminal take the keyboard on mount? True for the single view. In a
 * split it must be true only for the FOCUSED panel: every panel calling `term.focus()` as it
 * mounts made the last one to finish steal the focused cell, so a saved split opened on whatever
 * panel happened to mount last. Read through a ref, so changing focus later never re-runs the
 * attach effect (that would tear down and reopen the tmux attachment).
 */
export function TerminalView({ project, autoFocus = true }: { project: string | null; autoFocus?: boolean }) {
  const { gateway, status } = useGateway();
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<string | null>(null);
  // Project terminals auto-launch Claude; cover the raw startup with a loading overlay
  // until the first output arrives. Master (null) is a plain shell, no overlay.
  const [booting, setBooting] = useState(project !== null);
  // Touch devices only: a phone keyboard has no arrow/Esc/Ctrl keys, so a native TUI menu
  // (resume prompt, permission ask, /model) is unanswerable. Desktop keeps its real keyboard.
  const [isTouch] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
  );

  // Paste = clipboard → terminal input (right-click on desktop, button on mobile).
  // Safety: strip control chars (a stray tmux prefix / ESC in the clipboard would otherwise
  // run as a COMMAND: that's what split the pane), then wrap in bracketed-paste markers so
  // the shell/app treats it as literal text, never executable input.
  function paste() {
    const id = sessionRef.current;
    if (!id) return;
    navigator.clipboard
      ?.readText()
.then((raw) => {
        if (!raw) return;
        const clean = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // keep \t \n \r
        const data = `\x1b[200~${clean}\x1b[201~`;
        gateway.req("terminal.input", { sessionId: id, data }).catch(() => {});
      })
.catch(() => {});
  }

  // Copy = current selection (from a Shift+drag, which bypasses tmux's mouse grab), or the
  // whole visible screen as a fallback when there's no selection (handy on touch).
  function copy() {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text) {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        if (line) lines.push(line.translateToString(true));
      }
      text = lines.join("\n").replace(/\s+$/, "");
    }
    if (text) void navigator.clipboard?.writeText(text).catch(() => {});
  }

  // Focus follows the split's focused panel. `autoFocus` is only read at open below, which was
  // enough while focus could ONLY change by clicking (the click focuses the terminal itself), 
  // Cmd/Ctrl-1…4 rebound the header while the browser kept typing into the panel you came from.
  // Runs on every flip to true; re-focusing an already-focused terminal is a no-op, so clicking
  // behaves exactly as before.
  useEffect(() => {
    if (autoFocus) termRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (status !== "ready" || !hostRef.current) return;
    let disposed = false;
    let sessionId: string | null = null;
    setBooting(project !== null); // show the loading overlay on every (re)open, incl. after rename

    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: termFontSize(),
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    // Mobile input hardening: xterm's hidden input otherwise inherits the phone keyboard's
    // autocorrect / prediction / composition, which double-inserts characters on Android & iOS.
    // These attributes are no-ops on desktop, so this can't affect normal typing.
    const ta = hostRef.current.querySelector<HTMLTextAreaElement>("textarea");
    if (ta) {
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("spellcheck", "false");
    }
    // WebGL renderer draws box-drawing/powerline glyphs itself, so TUI borders (Claude's
    // rounded input box, bars, arrows) render crisply instead of falling back to _ / -.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* no WebGL (rare): falls back to the DOM renderer */
    }
    fit.fit();

    // Cmd/Ctrl-K belongs to the app (command palette), not the shell. Returning false makes
    // xterm ignore the key entirely: it neither writes ^K to the PTY nor calls
    // preventDefault/stopPropagation, so the event keeps bubbling to App's window listener
    // and the palette opens. Without this, the palette opened AND the shell ate a ^K.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") return false;
      // Same deal for Cmd/Ctrl-1…4 (focus a split panel): the app owns it, the shell never
      // sees it. Returning false leaves the event to bubble up to App's window listener.
      if (panelFocusRequest(e)) return false;
      // …and Cmd/Ctrl-0, which leaves the split (or reopens the last one).
      if (splitToggleRequest(e)) return false;
      return true;
    });

    term.onData((data) => {
      if (sessionId) gateway.req("terminal.input", { sessionId, data }).catch(() => {});
    });

    // Clipboard, path 1: OSC 52: apps (Claude's /login code, tmux, etc.) ask the terminal
    // to put text on the system clipboard. xterm ignores it by default, so the app says
    // "copied" but nothing lands. Wire it to the browser clipboard (HTTPS gives us a
    // secure context). Payload is "<selection>;<base64>"; "?" is a read request we deny.
    term.parser.registerOscHandler(52, (payload) => {
      const semi = payload.indexOf(";");
      const b64 = semi === -1 ? payload: payload.slice(semi + 1);
      if (b64 === "?") return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        void navigator.clipboard?.writeText(new TextDecoder().decode(bytes)).catch(() => {});
      } catch {
        /* malformed base64: ignore */
      }
      return true;
    });

    // Clipboard, path 2: copy the current selection on pointer/touch release. Tying it to
    // the release gesture satisfies the browser's clipboard-permission requirement and
    // matches the native-terminal expectation that selecting text copies it.
    const host = hostRef.current;
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard?.writeText(sel).catch(() => {});
    };
    host.addEventListener("mouseup", copySelection);
    host.addEventListener("touchend", copySelection);

    // Touch-drag to scroll (mobile): xterm has no built-in touch scrolling. Translate a one-
    // finger vertical drag into wheel events dispatched on the terminal, so xterm treats it
    // exactly like a mouse wheel: scrolls scrollback in the normal buffer, and forwards to the
    // app (e.g. the Claude TUI, which runs mouse mode) when it owns the screen.
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      touchY = e.touches.length === 1 && t ? t.clientY: null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (touchY === null || e.touches.length !== 1 || !t) return;
      // We own single-finger vertical drags in the terminal, so suppress the browser's native
      // gesture (page scroll / pull-to-refresh), scoped to the terminal via this listener, so
      // pull-to-refresh reload still works everywhere else in the app.
      if (e.cancelable) e.preventDefault();
      const y = t.clientY;
      const dy = touchY - y; // finger up → scroll down
      if (Math.abs(dy) < 3) return;
      touchY = y;
      const target = host.querySelector(".xterm-viewport") ?? host.querySelector(".xterm") ?? host;
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
    };
    const onTouchEnd = () => {
      touchY = null;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });

    // Live font-size updates from the settings panel (per-browser preference).
    const onFont = (e: Event) => {
      term.options.fontSize = (e as CustomEvent<number>).detail;
      fit.fit();
    };
    window.addEventListener(FONT_EVENT, onFont);

    const offData = gateway.on("terminal.data", (p) => {
      if (p.sessionId === sessionId) {
        term.write(p.data);
        setBooting(false); // first output → Claude is up, drop the overlay
      }
    });
    const offExit = gateway.on("terminal.exit", (p) => {
      if (p.sessionId === sessionId) term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
    });

    gateway
.req<{ sessionId: string }>("terminal.open", { project, cols: term.cols, rows: term.rows })
.then((r) => {
        if (disposed) {
          gateway.req("terminal.close", { sessionId: r.sessionId }).catch(() => {});
        } else {
          sessionId = r.sessionId;
          sessionRef.current = r.sessionId;
        }
      })
.catch((e) => term.writeln(`\r\n\x1b[31m${e.message}\x1b[0m`));

    // Debounced resize; only tell the server when the grid actually changed.
    let lastCols = term.cols;
    let lastRows = term.rows;
    let timer: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fit.fit();
        if (sessionId && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          gateway.req("terminal.resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
        }
      }, 120);
    });
    ro.observe(hostRef.current);
    if (autoFocusRef.current) term.focus();

    return () => {
      disposed = true;
      clearTimeout(timer);
      ro.disconnect();
      host.removeEventListener("mouseup", copySelection);
      host.removeEventListener("touchend", copySelection);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener(FONT_EVENT, onFont);
      offData();
      offExit();
      if (sessionId) gateway.req("terminal.close", { sessionId }).catch(() => {});
      term.dispose();
      termRef.current = null;
      sessionRef.current = null;
    };
  }, [gateway, status, project]);

  if (status !== "ready") {
    return (
      <Panel>
        <div className="grid h-full place-items-center text-sm text-faint">
          {status === "connecting" ? "Connecting to gateway…": "Gateway offline, retrying…"}
        </div>
      </Panel>
    );
  }
  return (
    <Panel>
      <div className="flex h-full w-full flex-col">
        <div className="relative min-h-0 flex-1">
          {/* Right-click pastes (and never shows the browser's context menu). */}
          <div
            ref={hostRef}
            className="h-full w-full"
            onContextMenu={(e) => {
              e.preventDefault();
              paste();
            }}
          />
          {/* Copy/Paste toolbar: works on touch where there's no right-click or Shift. */}
          <div className="absolute right-2.5 top-2.5 z-20 flex gap-1">
            <button
              onClick={copy}
              title="Copy selection (or visible screen)"
              aria-label="Copy"
              className="grid size-7 place-items-center rounded-md border border-line bg-black/40 text-muted backdrop-blur transition-colors hover:text-ink"
            >
              <Copy size={14} weight="bold" />
            </button>
            <button
              onClick={paste}
              title="Paste from clipboard"
              aria-label="Paste"
              className="grid size-7 place-items-center rounded-md border border-line bg-black/40 text-muted backdrop-blur transition-colors hover:text-ink"
            >
              <ClipboardText size={14} weight="bold" />
            </button>
          </div>
          {booting && (
            <div className="absolute inset-0 grid place-items-center bg-[#161009]">
              <div className="flex flex-col items-center gap-3 text-muted">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-bounce rounded-full bg-accent"
                      style={{ animationDelay: `${i * 120}ms` }}
                    />
                  ))}
                </div>
                <span className="text-sm">Starting Claude…</span>
              </div>
            </div>
          )}
        </div>
        {/* Touch-only key bar: sends the terminal signals a phone keyboard can't. `term.input`
            feeds them through the same path as typing, so no server change. Scrolling is untouched
            (it already works by touch). */}
        {isTouch && (
          <div className="flex shrink-0 items-stretch gap-1 border-t border-line bg-[#161009] px-1.5 py-1.5">
            {[
              { label: "↑", seq: "\x1b[A", aria: "Arrow up" },
              { label: "↓", seq: "\x1b[B", aria: "Arrow down" },
              { label: "↵", seq: "\r", aria: "Enter" },
              { label: "esc", seq: "\x1b", aria: "Escape" },
              { label: "^C", seq: "\x03", aria: "Interrupt (Ctrl-C)" },
            ].map((k) => (
              <button
                key={k.label}
                aria-label={k.aria}
                onClick={() => termRef.current?.input(k.seq)}
                className="flex-1 rounded-md border border-line bg-black/30 py-2 font-mono text-sm text-muted active:bg-raised active:text-ink"
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-hidden rounded-xl border border-line bg-[#161009] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
      {children}
    </div>
  );
}
