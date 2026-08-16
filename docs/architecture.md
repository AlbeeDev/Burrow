# Architecture

```
Browser            ──ws───►  Gateway (Node/TS)  ──►  tmux sessions  ──►  claude / bash
React + xterm.js             ws + node-pty           (persistence)       (real Claude Code)
```

## The two halves

**`app/`** is a Vite + React + TypeScript client, with Tailwind and xterm.js. It builds to
`server/web`, which the gateway serves. There is no separate web server.

**`server/`** is the gateway, run through `tsx` with no build step. It speaks a JSON
request/response/event protocol over `ws`, spawns PTYs through `@lydell/node-pty`, and uses tmux as
an invisible persistence layer.

Projects are subfolders of the projects root. Descriptions come from each folder's `CLAUDE.md`, so
the app and the disk stay in sync with no extra tooling.

## Why sessions survive

Every project is a tmux session (`tmux new-session -A`). The browser attaches to a PTY that attaches
to tmux, so closing the browser detaches rather than kills.

The tmux prefix key is disabled on Burrow's sessions. The terminal is a puppet for Claude and
nothing else, so a pasted `Ctrl-b` must never be read as a tmux command.

Sessions survive browser reconnects and gateway restarts on their own. Surviving a *container
rebuild* needs `deploy/burrow-tmux.service`, which starts the tmux server in the host's own cgroup
rather than the container's, making it a sibling of the app rather than a child.

## Two ways to talk to Claude

**Terminal** streams the real Claude Code TUI to the browser.

**Bubble** runs `claude --output-format stream-json` per turn.

Both run the real CLI and write the same session file on disk, so they are one conversation viewed
two ways rather than two conversations.

## Host exec

With `BURROW_HOST_EXEC=1` the gateway runs tmux and `claude` in the host's namespaces through
`nsenter`, instead of inside its own container. Sessions then have the same tools a plain SSH
session would: the host's PATH, its docker, its Python.

This is why the compose file is `privileged` with `pid: host`. The container exists for packaging,
and host exec undoes the isolation on purpose. A bare install needs none of it.

`BURROW_HOST_USER` decides who those sessions run as. Unset means root. Set, and they start through
a login shell for that user, which is how a version manager like nvm gets loaded and how files a
session creates end up owned by a person rather than by root.

## The screen

`server/mcp/burrow-mcp.mjs` is the MCP server behind the screen beside the terminal. Two tools:
`write_media` replaces the list of files shown, `list_media` reads it back.

It runs on the host, next to `claude`, so the gateway copies it into `~/.burrow/` at startup and
registers it in `~/.claude.json`. They talk over a unix socket in that directory. There is no TCP
path between host and container and no published port.

The socket carries only metadata. The browser fetches the bytes from `/push/<id>/<name>`, which
streams with Range support, so video seeks work and a pushed page's own assets resolve.

## State on disk

Everything lives under `~/.burrow/` (`BURROW_DATA_DIR` to move it):

| File | Holds |
| --- | --- |
| `groups.json` | groups, project assignments |
| `persistence.json` | which projects stay alive after you leave |
| `splits.json` | saved layouts |
| `schedule.json` | scheduled messages |
| `settings.json` | onboarding state and preferences |
| `pushes.json` | what is currently on the screen |
| `audit.log` | append-only event log |
| `trash/` | soft-deleted projects |

## Repo layout

```
app/            React web client (Vite)
server/         Node/TS gateway; serves the built client from server/web
server/mcp/     the MCP server behind the screen
scripts/        the two installers and the questions they ask
deploy/         the systemd unit that makes sessions survive a rebuild
docs/           this
.github/        CI: typecheck, tests and a real build on every push
```

## Tests

`npm test` in `server/`. Only pure logic with real stakes is unit tested: path containment, the push
bridge, schedule decisions, delivery detection, the drain rules that decide when a session may be
killed, plan usage parsing.

Two live harnesses (`npm run harness`) spawn real Claude turns and a real tmux session on their own
socket. They cover multi-turn on one process, graceful interrupt, waking a dead session, injecting
into a scrolled-back pane, and the timeout path. They need a Claude account, so they are a local
step and not part of CI.
