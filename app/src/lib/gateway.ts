/**
 * Burrow gateway client: speaks the req/res/event protocol over a WebSocket.
 * Mirrors the server's protocol.ts. Handles request/response correlation by id,
 * pushes terminal events to subscribers, and auto-reconnects.
 */

export type ConnStatus = "connecting" | "ready" | "closed";

export type Project = { name: string; description: string | null };

/** One scheduled loop broadcast row (mirrors server/src/schedule.ts ScheduleRow). */
export type Schedule = {
  id: string;
  enabled: boolean;
  time: string; // "HH:MM", server-local
  days: number[]; // 0=Sun … 6=Sat
  message: string;
  chats: string[];
  lastFired: string | null;
};

/**
 * One saved split layout (mirrors server/src/splits.ts SavedSplit). A panel is `null` when
 * empty, `{ project: null }` for the master shell, else the project it holds. Focus is not
 * stored: a split opens on its first panel.
 */
export type SavedSplit = {
  id: string;
  name: string;
  panels: ({ project: string | null } | null)[];
};

/**
 * Something Claude pushed through the `burrow` MCP server (mirrors server/src/images.ts
 * PushedItem).
 *
 * Metadata only. v1 carried base64 bytes on the socket; v2 sends "this arrived, here is its
 * id and kind" and the browser fetches the file from `/push/<id>/<name>`, which supports Range,
 * so video and audio can seek and a PDF viewer can read its index without pulling the whole file.
 */
export type PushKind = "image" | "markdown" | "video" | "audio" | "pdf" | "html";

export type PushedItem = {
  id: string;
  name: string;
  rel: string;
  kind: PushKind;
  mime: string;
  size: number;
  caption?: string;
  at: number;
  ver: number;
};

/**
 * Where a pushed item's bytes live. The item's own filename is part of the path on purpose: a
 * pushed HTML page's relative `style.css` then resolves to `/push/<id>/style.css`, which the
 * gateway serves from the same directory. A bare `/push/<id>` would break every relative link.
 *
 * `?v=<mtime>` is what makes a rewritten file actually appear. An item that is pushed again at the
 * same path keeps its id on purpose, so without this the URL never changes, and an `<img>`/`<iframe>`
 * whose src is unchanged simply never requests anything, the gateway's `no-store` is irrelevant
 * because there is no request for it to answer. The gateway ignores the parameter.
 */
export function pushUrl(item: PushedItem): string {
  const path = `/push/${encodeURIComponent(item.id)}/${encodeURIComponent(item.name)}`;
  return fileUrl(path, item.ver ? { v: String(item.ver) }: {});
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type EventListener = (payload: any) => void;

export class Gateway {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private statusListeners = new Set<(s: ConnStatus) => void>();
  private eventListeners = new Map<string, Set<EventListener>>();

  status: ConnStatus = "connecting";

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  start(): void {
    this.closedByUser = false;
    this.open();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  /** Subscribe to a server event (e.g. "terminal.data"). Returns an unsubscribe fn. */
  on(event: string, cb: EventListener): () => void {
    let set = this.eventListeners.get(event);
    if (!set) this.eventListeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  req<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("gateway not connected"));
        return;
      }
      const id = String(this.nextId++);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 15000);
    });
  }

  private setStatus(s: ConnStatus): void {
    this.status = s;
    for (const cb of this.statusListeners) cb(s);
  }

  private open(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = async () => {
      try {
        await this.req("connect", this.token ? { token: this.token }: {});
        this.setStatus("ready");
      } catch {
        this.setStatus("closed"); // auth failed, do not spin reconnect on a bad token
        ws.close();
      }
    };

    ws.onmessage = (ev) => {
      let frame: any;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (frame.type === "res") {
        const p = this.pending.get(frame.id);
        if (p) {
          this.pending.delete(frame.id);
          frame.ok ? p.resolve(frame.payload): p.reject(new Error(frame.error?.message ?? "request failed"));
        }
      } else if (frame.type === "event") {
        const set = this.eventListeners.get(frame.event);
        if (set) for (const cb of set) cb(frame.payload);
      }
    };

    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error("connection closed"));
      this.pending.clear();
      if (this.status !== "closed") this.setStatus("closed");
      if (!this.closedByUser) this.reconnectTimer = setTimeout(() => this.open(), 1500);
    };

    ws.onerror = () => ws.close();
  }
}

/**
 * Build a URL for the HTTP file bridge (`/files/*`), same-origin as the app. Carries the
 * build-time token when one is set (dev / token-gated deploys); harmless when empty.
 */
export function fileUrl(path: string, params: Record<string, string>): string {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const token = import.meta.env.VITE_BURROW_TOKEN as string | undefined;
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

/** In dev, point at the gateway explicitly; in prod, use the app's own origin. */
export function gatewayUrl(): string {
  const explicit = import.meta.env.VITE_GATEWAY_URL as string | undefined;
  if (explicit) return explicit;
  const proto = location.protocol === "https:" ? "wss": "ws";
  return `${proto}://${location.host}`;
}
