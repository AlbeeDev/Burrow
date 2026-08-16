# What Burrow does to your machine

Burrow gives a browser a shell on the machine it runs on. That is the product, not a side effect,
and every property below follows from it.

## What it actually does

**Runs Claude Code with `--dangerously-skip-permissions`.** Sessions do not stop to ask before
running a command. That is why they can work while you are asleep, and why the machine you point
Burrow at should be one you would let Claude work on unattended.

**Runs as root, unless you say otherwise.** In the Docker deployment the container is root because
`nsenter` needs it. Set `BURROW_HOST_USER` and sessions start as that user instead, which is worth
doing on a machine with real user accounts.

**Undoes its own containerisation.** The compose file is `privileged` with `pid: host` and mounts
your home directory, then uses `nsenter` to run tmux and `claude` in the host's namespaces. This is
deliberate. Tool parity with a plain SSH session is the point of the product, and a container that
prevented it would be a different, weaker thing. Containerising Burrow buys packaging, not
confinement. The bare install needs none of it.

**Has no authentication of its own.** `BURROW_TOKEN` adds a shared secret, and that is all there is.

## So where is the boundary

Outside Burrow, and you choose it.

It binds to `127.0.0.1` by default and refuses a public bind without a token. To reach it from your
other devices, put something in front that already handles identity: Tailscale (one button, see the
addon), WireGuard, or an SSH tunnel.

**Do not put it on a public port.** There is no boundary inside Burrow to fall back on.

## What it is not built for

Multi-tenancy. Untrusted users. Anything where two people using it need to be kept apart.

If you want to share it with a second person, run a second instance: its own projects root, its own data directory,
its own port, and `BURROW_HOST_USER` pointing at an unprivileged account. That is filesystem
permissions doing the work, which is a boundary, rather than role checks in application code, which
is a fence.

If you fork this for anything multi-user or public, you are taking on a threat model Burrow does not
implement: real isolation, per-user accounts or containers, and permission deny-lists.
