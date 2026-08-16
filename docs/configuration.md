# Configuration

Both installers write a config file and you rarely need to touch it. This is the full list for when
you do.

**Bare install:** `server/.env`
**Docker:** `.env` in the repo root, which Compose reads

## The ones you might change

| | |
| --- | --- |
| `BURROW_PROJECTS_ROOT` | Where projects live. Every directory directly inside becomes a project. Defaults to `~/burrow-projects` |
| `BURROW_PORT` | Port the gateway listens on. Default `8317` |
| `BURROW_BIND` | Address to bind. Default `127.0.0.1`. Binding to `0.0.0.0` with no `BURROW_TOKEN` is refused at startup |
| `BURROW_TOKEN` | Shared secret a browser must send on connect. Optional, and no substitute for a private network |

## Docker only

| | |
| --- | --- |
| `BURROW_HOME` | Your home directory. Mounted at the same path inside the container and used as `HOME` there, which is how Burrow finds `~/.claude`, `~/.burrow` and `~/.bashrc`. It must be the home that actually holds them, never a subfolder |
| `COMPOSE_PROFILES` | Set to `tailscale` to start the Tailscale sidecar. The installer writes this when you say yes |
| `TS_AUTHKEY` | Auth key for that sidecar, first registration only |
| `BURROW_TS_HOSTNAME` | The sidecar's node name, and so the URL. Default `burrow` |

## Claude

| | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Optional: without it, sessions use the CLI's own `/login`. Recommended anyway, because several sessions sharing one login all stop together when it expires |
| `CLAUDE_CONFIG_DIR` | Where Claude keeps its config and history. Defaults to `~/.claude` |
| `BURROW_BASHRC` | File to read account tokens from. Defaults to `~/.bashrc` |

## Host exec

| | |
| --- | --- |
| `BURROW_HOST_EXEC` | `1` runs tmux and `claude` in the host's namespaces through `nsenter`, giving sessions the host's tools. Set by the Docker deployment. `0` keeps everything in the container |
| `BURROW_HOST_USER` | Who those sessions run as. Unset means root. Set, and they start through a login shell for that user, so their PATH and version manager work and the files they create belong to them |
| `BURROW_TMUX_SOCKET` | tmux socket name. Default `burrow` |

## Paths and addons

| | |
| --- | --- |
| `BURROW_DATA_DIR` | Where Burrow keeps its own state. Defaults to `~/.burrow` |
| `BURROW_MCP_SOCK` | The screen's unix socket. Defaults to a path inside the data dir |
| `BURROW_USAGE_CMD` | Full command line for a plan usage provider, overriding detection. See [USAGE-PROVIDER.md](../USAGE-PROVIDER.md) |
| `BURROW_TRUST_NETWORK` | Allows a non-loopback bind without a token. Set by the Docker deployment, where the only ways in are a loopback port mapping and the sidecar |
