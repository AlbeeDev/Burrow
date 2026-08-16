# Usage provider: the addon contract

Burrow can show how much of your Claude plan window is left, in the header. It ships no way of
finding that out, and hardcodes no path to one. Anything that satisfies this contract will do.

This document is for people writing a provider. If you only want to use one, there is nothing here
for you: install it, and Burrow finds it.

Deliberately **not** a plugin framework, no registry, no discovery, no lifecycle. One command, one
JSON shape, one Settings row. A framework for a single integration buys nothing and costs
everything.

## What a provider must do

**Be called `claude-usage`, and be on PATH.** That is the entire detection mechanism:
`command -v claude-usage`.

**On WSL, the Windows PATH counts too.** If nothing answers on the Linux side, Burrow asks
`cmd.exe /c where claude-usage` and runs whatever that finds through `cmd.exe`. A Windows user
reaches Burrow through WSL, and the browser a provider reads is usually on the Windows side, so a
provider installed over there is the normal case rather than an exception. `.exe`, `.bat` and `.cmd`
all work and the extension never needs to be named, going through `cmd.exe` is also what makes
`.bat` possible at all, since Linux cannot exec one.

**Print one JSON object to stdout and exit 0.**

```json
{
  "status": "ok",
  "session_pct": 42,
  "session_resets_at": "2026-08-06T04:00:00Z",
  "weekly_pct": 81,
  "weekly_resets_at": "2026-08-09T06:59:00Z",
  "blocking": [{ "kind": "opus", "percent": 100, "scope": "weekly" }],
  "credits_enabled": false,
  "credits_spent": null,
  "credits_limit": null
}
```

Only `status` is required. Everything else is optional, Burrow renders what is present and stays
quiet about the rest. The authority is the `Usage` type in `server/src/usage.ts`, mirrored in
`app/src/lib/usage.ts`; if this document and that type ever disagree, the type wins.

`credits_spent` and `credits_limit` must be **`null`, not absent**, when the account has no limit
set. The client distinguishes the two.

**On failure, exit non-zero, and still print `{"status":"<why>"}` if you can.** The reason reaches
the badge tooltip ("Plan usage unknown (rate_limited)"), which is far more useful than a bare `?`.

**Two operational constraints:**

- Return within a second or two. Burrow caches for 45 seconds, but a slow command blocks the read.
- Never require a TTY. It runs as a child process of the gateway.

**The rule that must not be broken, on either side:** a failed read shows as *unknown*, never as a
number. A 0% bar reads as plenty of headroom, which is the exact opposite of what a failure means.

## What Burrow does with it

Detection runs at the moment you ask, not at install time, so installing a provider while Burrow is
running and pressing **Check again** in Settings picks it up with no restart.

Three states, kept distinct on purpose:

| | |
| --- | --- |
| **No provider** | no badge at all: nothing has been installed, and that is not a fault |
| **Provider, read failed** | `usage ?`, something is installed and it did not answer |
| **Provider, read fine** | the number |

Collapsing the first two is the mistake this replaced: Burrow used to point at one specific script
by absolute path, so everybody who was not its author got a permanent "unknown", which reads as
something being broken rather than something never having been added.

With `BURROW_HOST_EXEC=1` both the lookup and the call go through the same host path that tmux and
`claude` use, so the answer is about the machine that would actually run it rather than the
container's own PATH.

`BURROW_USAGE_CMD` overrides everything, a full command line, for an odd install location or your
own implementation. An explicit override is treated as installed without being probed, because it is
a deliberate statement and second-guessing it would only produce a confusing disagreement.

## An open question

Command versus HTTP endpoint. A command is simpler and matches what exists; an endpoint would let
the provider run on another machine. Staying with the command unless there is a reason not to.
