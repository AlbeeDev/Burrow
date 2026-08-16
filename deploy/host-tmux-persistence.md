# Rebuild-proof terminal sessions (host-owned tmux server)

## The problem

Terminal sessions run as a tmux server reached via `nsenter` into the host. But `nsenter`
changes *namespaces*, not *cgroup*, so the tmux server ends up inside the **burrow-app
container's cgroup** (`/system.slice/docker-<id>.scope`). When the container is recreated
(any `docker compose up --build` / `--force-recreate` / `down`), that cgroup is destroyed
and every process in it: the tmux server, every session, every running `claude`, gets
SIGKILL'd. Result: **every deploy that rebuilds the container wipes all sessions.**

Verified on 2026-07-25: the live tmux server sat at
`/system.slice/docker-1c2032…​.scope`.

## The fix

Run the tmux server from a **host systemd service** on a dedicated socket (`-L burrow`).
A systemd service lives in `system.slice/burrow-tmux.service`, a **sibling** of the
container's cgroup, not a child, so recreating the container leaves it untouched.

Proven non-destructively on 2026-07-25: a `systemd-run` tmux server landed at
`/system.slice/burrow-tmux-test.service`, outside the docker scope.

Two pieces (both already in this branch):
- **`server/src/terminal.ts`**: all tmux calls now go through `tmuxCmd()`, which adds
  `-L <socket>` (`BURROW_TMUX_SOCKET`, default `burrow`). No behavior change until the
  host service owns that socket; if the service isn't running, `tmux -L burrow` just
  auto-starts a server as before: never *worse* than today.
- **`deploy/burrow-tmux.service`**: the host unit that owns the socket.

No `docker-compose.yml` change is needed (default socket name matches the service).

## The one unavoidable caveat

The sessions that exist *right now* are already trapped in the container's cgroup and
cannot be moved to the new socket. **The cutover costs exactly one final session wipe.**
Conversations are safe on disk (reopen + `claude -c` resumes them); only in-flight,
mid-task work in those sessions is lost. After this one time, deploys never wipe again.

Do the cutover when no important task is mid-flight.

## Cutover (run on the host, deliberate, attended)

1. **Install + start the host tmux service:**
   ```sh
   cp deploy/burrow-tmux.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now burrow-tmux.service
   # confirm it's in system.slice (NOT a docker scope):
   cat /proc/$(pgrep -f 'tmux: server' | head -1)/cgroup    # → …/system.slice/burrow-tmux.service
   ```

2. **Deploy the new `terminal.ts`** (it's a single-file server change, light path):
   ```sh
   docker cp server/src/terminal.ts burrow-app:/app/src/terminal.ts
   docker restart burrow-app
   ```
   (If you run this from inside a Burrow session, schedule the restart with
   `systemd-run --on-active=30` so it does not kill the command mid-flight.)

3. **The one wipe:** the old sessions are still on the *default* socket and now invisible
   to Burrow. Reopen your projects in the UI (each starts fresh on `-L burrow`, resuming
   its conversation via `claude -c`). Then reap the orphaned old server:
   ```sh
   nsenter -t 1 -m -u -i -n -p -- tmux kill-server   # default socket only; -L burrow is untouched
   ```

4. **Validate the win** (with a throwaway session open): rebuild or restart the container
   and confirm the session survives.
   ```sh
   docker restart burrow-app     # or a full rebuild
   # the terminal reconnects with its claude still running, no wipe
   ```
   Commit is on `feat/host-tmux-persistence`, so a future full rebuild re-bakes terminal.ts.

## Gotcha: `--dangerously-skip-permissions cannot be used with root`

Hit at first cutover (2026-07-26). The old nsenter-spawned tmux server inherited the
container's env, which sets **`IS_SANDBOX=1`**, the flag Claude Code requires to allow
`--dangerously-skip-permissions` while running as root. A systemd service starts with a
clean env, so without it every session failed to launch. Fixed by setting it (and `HOME`,
locale) on the unit via `Environment=`: tmux passes the server env to every pane, so all
sessions inherit it. If sessions ever fail with that error, check the service env:
`cat /proc/$(systemctl show -p MainPID --value burrow-tmux.service)/environ | tr '\0' '\n' | grep IS_SANDBOX`.

## Rollback (fully reversible)

- Stop owning the socket: `systemctl disable --now burrow-tmux.service`, Burrow falls
  back to auto-starting the server in-container (status quo).
- Or revert the code: `git revert` the terminal.ts change; `-L burrow` disappears.
