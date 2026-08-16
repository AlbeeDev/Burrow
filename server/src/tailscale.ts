/**
 * The Tailscale addon: publishes Burrow on the user's tailnet.
 *
 * Burrow does no networking itself. It runs `tailscale serve`, a one-shot command that
 * reconfigures the Tailscale daemon; the daemon terminates HTTPS and proxies to Burrow's loopback
 * port from then on, surviving reboots with Burrow out of the path. Burrow stays bound to
 * 127.0.0.1 throughout.
 *
 * The install type (container vs bare) is detected at request time, never recorded at install
 * time, so switching deployment styles cannot leave a stale answer.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long any tailscale call gets before we call it stuck. `serve` is normally instant. */
const TIMEOUT_MS = 15_000;

export type TailscaleState =
  /**
   * The container deployment, where a Tailscale sidecar publishes instead of the app. `running`
   * is checked (the sidecar is an opt-in compose profile, so it may not exist).
   */
  | { status: "container"; running: boolean }
  /** No `tailscale` binary on PATH. */
  | { status: "absent" }
  /** Installed but not signed in: `tailscale up` is the user's move, not ours. */
  | { status: "logged-out" }
  /** Ready. `serving` says whether Burrow is already published, and at what URL. */
  | { status: "ready"; host: string; url: string; serving: boolean; bin: string | null };

function inContainer(): boolean {
  // The compose deployment sets BURROW_HOST_EXEC; /.dockerenv covers every other container.
  return existsSync("/.dockerenv") || process.env.BURROW_HOST_EXEC === "1";
}

/**
 * Is the Tailscale sidecar actually there?
 *
 * Docker's embedded DNS resolves a container's name on the shared network only while that container
 * is running, so a lookup is a direct answer rather than an inference, no docker socket, no
 * privileged call, nothing to keep in sync with the compose file beyond the name itself.
 *
 * Either name works: `tailscale` is the compose service, `burrow-tailscale` the container. Both are
 * tried because an override file or a renamed project can change which one answers.
 */
async function sidecarRunning(): Promise<boolean> {
  const { lookup } = await import("node:dns/promises");
  for (const host of ["burrow-tailscale", "tailscale"]) {
    try {
      await lookup(host);
      return true;
    } catch {
      /* not this name */
    }
  }
  return false;
}

async function tailscaleJson(args: string[]): Promise<any | null> {
  try {
    const { stdout } = await run("tailscale", args, { timeout: TIMEOUT_MS });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** What the Settings row should show. Never throws, an addon must not be able to break settings. */
export async function tailscaleState(port: number): Promise<TailscaleState> {
  if (inContainer()) return { status: "container", running: await sidecarRunning() };

  const status = await tailscaleJson(["status", "--json"]);
  if (!status) return { status: "absent" };
  // BackendState is "Running" once signed in; "NeedsLogin"/"Stopped" otherwise.
  if (status.BackendState !== "Running") return { status: "logged-out" };

  // DNSName carries a trailing dot, which is correct in DNS and wrong in a URL.
  const host = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!host) return { status: "logged-out" };

  const serve = await tailscaleJson(["serve", "status", "--json"]);
  const serving = JSON.stringify(serve ?? {}).includes(`127.0.0.1:${port}`);
  // Where the binary is, so a "check again" can report what it saw rather than silently
  // re-rendering the same row.
  let bin: string | null = null;
  try {
    const { stdout } = await run("sh", ["-c", "command -v tailscale"], { timeout: 5_000 });
    bin = stdout.trim() || null;
  } catch {
    /* it answered `status` a moment ago, so this is cosmetic only */
  }
  return { status: "ready", host, url: `https://${host}`, serving, bin };
}

export type ServeResult = { ok: boolean; url?: string; message: string };

/**
 * Publish Burrow on the tailnet, or stop publishing it.
 *
 * A failure returns the command to run by hand rather than a shrug: `tailscale serve` talks to the
 * daemon's socket and usually needs root, so a Burrow started as an ordinary user will be refused, 
 * and "couldn't enable it" with no next step is the least useful thing we could say.
 */
export async function setServe(port: number, on: boolean): Promise<ServeResult> {
  const state = await tailscaleState(port);
  if (state.status === "container") {
    return {
      ok: false,
      message: state.running
        ? "This is the Docker deployment: the Tailscale sidecar already does this.": "This is the Docker deployment, where a Tailscale sidecar does this. It is not running:\n" +
          "  add COMPOSE_PROFILES=tailscale and TS_AUTHKEY to.env, then `docker compose up -d`.",
    };
  }
  if (state.status === "absent") {
    return { ok: false, message: "Tailscale is not installed on this machine." };
  }
  if (state.status === "logged-out") {
    return { ok: false, message: "Tailscale is installed but not signed in. Run `tailscale up` first." };
  }

  const args = on
    ? ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]: ["serve", "--https=443", "off"];
  try {
    await run("tailscale", args, { timeout: TIMEOUT_MS });
  } catch (err) {
    const detail = err instanceof Error ? err.message: String(err);
    const manual = `sudo tailscale ${args.join(" ")}`;
    if (!/permission|denied|access/i.test(detail)) {
      return { ok: false, message: `The command failed. Run it yourself to see why:\n  ${manual}` };
    }
    // `tailscale set --operator` grants a non-root user permanent daemon access, so it is offered
    // first: sudo fixes only this one press. Burrow cannot run it itself (granting the permission
    // needs the permission).
    const who = userInfo().username;
    return {
      ok: false,
      message:
        "Burrow is not running as root, so it cannot reconfigure the Tailscale daemon.\n\n" +
        `Grant your user permanent access (once, then this button works):\n  sudo tailscale set --operator=${who}\n\n` +
        `Or just do it by hand this time:\n  ${manual}`,
    };
  }

  if (!on) return { ok: true, message: "Burrow is no longer published on your tailnet." };

  // Pre-provision the cert so the first visit gets no browser warning. Fire-and-forget: cert
  // provisioning can exceed the client's request timeout, and the proxy is already live when
  // `serve` returns, so awaiting this turned successful publishes into reported timeouts.
  void run("tailscale", ["cert", state.host], { timeout: TIMEOUT_MS }).catch(() => {});

  return { ok: true, url: state.url, message: `Burrow is now reachable at ${state.url} from any device on your tailnet.` };
}
