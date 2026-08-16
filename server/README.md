# Burrow Gateway (Phase 1: terminal mode)

The always-on server that lives on your VPS. The Burrow app connects to it over a
WebSocket; the gateway spawns real shells (via tmux) and streams their output back as
events. The phone holds no state: everything lives here.

```
Phone app  ⟷  WebSocket  ⟷  Burrow gateway  ⟷  tmux session  ⟷  bash
```

This is a deliberately small reimplementation of the pattern used by
[OpenClaw](https://github.com/openclaw/openclaw) (MIT). The PTY wrapper (`src/pty.ts`)
and terminal manager (`src/terminal.ts`) are adapted from its server-side TypeScript;
the sprawling agent-OS, multi-channel, and device-pairing layers are intentionally left out.

## Protocol

Three JSON frame types over the WebSocket:

| Frame   | Direction | Shape |
|---------|-----------|-------|
| `req`   | client → server | `{type:"req", id, method, params}` |
| `res`   | server → client | `{type:"res", id, ok, payload?, error?}` (matched to a req by `id`) |
| `event` | server → client | `{type:"event", event, payload}` (unprompted, e.g. streamed output) |

**Methods** (`src/protocol.ts`):
- `connect` `{token}` → `{protocol}`: must be called first; token is the shared secret
- `projects.list` → `{projects: [{name, description}]}`, folders under the projects root, described by their CLAUDE.md
- `terminal.open` `{project|null, cols, rows}` → `{sessionId, pid, tmux}`, opens/reattaches a project's tmux session (`project:null` = master terminal at the root)
- `terminal.input` `{sessionId, data}`: write keystrokes/commands
- `terminal.resize` `{sessionId, cols, rows}`
- `terminal.close` `{sessionId}`: detach (the tmux session keeps running)

**Events**:
- `terminal.data` `{sessionId, seq, data}`, a chunk of shell output
- `terminal.exit` `{sessionId, exitCode}`

## Session persistence

Each `terminal.open` runs `tmux new-session -A -s burrow_<project>`. Dropping the
connection detaches the client but leaves the tmux session (and any running processes)
alive on the server. Reconnecting and reopening reattaches. This is Burrow's
"connection drops don't kill your work" guarantee, verified by the smoke test.

## Setup & run

```bash
npm install
cp .env.example .env      # optionally set BURROW_TOKEN; set BURROW_BIND to your Tailscale IP
npm start                 # or: npm run dev  (auto-reload)
```

Then open `http://<tailscale-ip>:<port>/` in any browser (desktop or phone on the
Tailnet) for the **web terminal**: an xterm.js Terminal-mode client with a project
switcher, served from the gateway itself. It's the quickest way to try Burrow before
the mobile app exists. (xterm.js loads from a CDN, so the browser needs internet.)

Config (see `.env.example`): `BURROW_TOKEN` (optional), `BURROW_BIND` (default the
Tailscale IP: Tailnet-only), `BURROW_PORT` (8317), `BURROW_PROJECTS_ROOT` (`/root`).

Security model: bind to the Tailscale IP so the gateway is only reachable inside your
Tailnet, which is already encrypted and authenticated, that alone is enough for
personal use. `BURROW_TOKEN` is an optional second layer (defense-in-depth), since the
gateway grants root shell access. Binding to a public address (`0.0.0.0`) with no token
is refused at startup.

## Test

```bash
BURROW_TOKEN=... npm run smoke
```

End-to-end check: connect+auth → open a tmux terminal → run a command → receive
streamed output → reconnect → confirm the session survived.

## Not yet built (next phases)

- **Claude mode**: same pipe, but `terminal.open` spawns `claude` in the project dir instead of bash
- The **React Native / Expo app** (the client)
