/**
 * Account-level plan usage, read from an optional provider Burrow does not ship: any executable
 * called `claude-usage` on PATH that prints the JSON documented in USAGE-PROVIDER.md.
 *
 * Invariants:
 *  - Results are cached (a provider may do real work per call); no per-render polling.
 *  - A failed read renders as "unknown", never as 0%: a zero reads as headroom.
 *  - "Never installed" (not_configured, no badge) is a different state from "installed but
 *    failing" (`usage ?`), and they must not collapse into each other.
 *  - With BURROW_HOST_EXEC=1 the provider lives on the host, so both the lookup and the call go
 *    through the same nsenter path tmux and `claude` use.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { asUser } from "./hostUser.js";

const execFileAsync = promisify(execFile);

export type UsageBlock = { kind: string; percent: number; scope?: string };

/** The script's JSON, as documented in its README. Optional because a failure carries only status. */
export type Usage = {
  status: string;
  session_pct?: number;
  session_resets_at?: string;
  weekly_pct?: number;
  weekly_resets_at?: string;
  blocking?: UsageBlock[];
  credits_enabled?: boolean;
  // null, not absent, when the account has no limit set, the live script really sends that.
  credits_spent?: number | null;
  credits_limit?: number | null;
};

/** What the gateway hands the client. `ok: false` means show "unknown", never a number. */
export type UsageResult = {
  ok: boolean;
  usage: Usage;
  at: number;
  cached: boolean;
  /**
   * Where the provider was found, or null. Reported so a "check again" button can say what it
   * saw: a check that produces no visible output is indistinguishable from a button that does
   * nothing.
   */
  provider?: string | null;
};

/**
 * The provider is an addon, not part of Burrow: any executable of this name on PATH that prints
 * the JSON above and exits 0. Burrow ships none, so a fresh install simply reports "not
 * configured" and the header says so.
 *
 * It used to be the absolute path to a private sibling project, the one hard dependency Burrow
 * had on anything outside its own repo, and a guaranteed permanent "usage ?" for everybody else.
 */
const COMMAND = "claude-usage";
const OK_TTL = 45_000; // README: 30–60s
const FAIL_TTL = 15_000; // don't hammer a broken login, but recover quickly once it's fixed
const TIMEOUT = 20_000; // cookie copy + two HTTPS calls; generous, still bounded

const HOST_EXEC = process.env.BURROW_HOST_EXEC === "1";

/**
 * A resolved provider: what to show, and how to run it.
 *
 * Two fields rather than one string because a Windows provider is not launched by its own path, 
 * see `windowsProvider()`. `display` is only ever shown; `file`/`args`/`cwd` are only ever run.
 */
export type Provider = { display: string; file: string; args: string[]; cwd?: string };

/**
 * The command to run. `BURROW_USAGE_CMD` overrides it, that exists so the read/cache/failure
 * logic can be exercised against a stub, because the real script shells out to `docker cp` and an
 * unattended run is not allowed to touch docker at all.
 */
function usageCommand(p: Provider): { file: string; args: string[] } {
  if (!HOST_EXEC) return { file: p.file, args: p.args };
  // Host-exec: the provider is installed on the HOST, not in the container, so the call has to
  // happen out there too, and as the user who installed it, for the same reason sessions do. A
  // provider is somebody's own tool, put on their own PATH; probing as root with the container's
  // PATH asks the wrong machine and then reports "not installed" with total confidence.
  const inner = asUser(p.file, p.args);
  return { file: "nsenter", args: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", inner.file, ...inner.args] };
}

/** Under WSL the Windows PATH is inherited, so a Windows-installed provider is reachable. */
function isWSL(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * First path out of `where`'s output.
 *
 * Separate and tested because every part of it is a small trap: `where` prints CRLF, prints one
 * line per match when several exist, and prints its "could not find" notice on stderr, so the
 * quiet failure to guard against is treating a blank stdout as a hit.
 */
export function firstPath(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const hit = line.replace(/\r$/, "").trim();
    if (hit) return hit;
  }
  return null;
}

/**
 * Ask Windows whether it has the provider, from inside WSL.
 *
 * Burrow cannot run on Windows: its sessions ARE tmux sessions, so WSL is how a Windows user runs
 * it, and their browser (which is what a provider reads) lives on the Windows side. A provider
 * installed over there is therefore the *normal* case for that user, not an edge case.
 *
 * It is asked and launched through `cmd.exe` rather than by its own path because Linux can only
 * exec real Windows binaries: the first one found in the wild was a `.bat`, which
 * `execFile` cannot start at all. Going through `cmd.exe` covers `.exe`, `.bat` and `.cmd` at once
 * and stops Burrow guessing at file extensions.
 *
 * The `cwd` is not cosmetic. Started from a WSL directory, `cmd.exe` prints a UNC-path warning on
 * stdout and the JSON parse then fails on a provider that worked perfectly; starting it somewhere
 * under `/mnt` gives it a real Windows directory and it stays quiet.
 */
async function windowsProvider(): Promise<Provider | null> {
  const cwd = "/mnt/c";
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/c", "where", COMMAND], { timeout: 5_000, cwd });
    const found = firstPath(stdout);
    if (!found) return null;
    return { display: found, file: "cmd.exe", args: ["/c", COMMAND], cwd };
  } catch {
    return null;
  }
}

/**
 * Is a provider installed? Returns how to run it, or null.
 *
 * Asked through the same wrapper the real call uses, so the answer is about the machine that would
 * actually run it. An explicit `BURROW_USAGE_CMD` counts as installed without being probed, it is
 * a deliberate statement and is not second-guessed.
 */
export async function usageProvider(): Promise<Provider | null> {
  const override = process.env.BURROW_USAGE_CMD?.trim();
  if (override) {
    const [file, ...args] = override.split(/\s+/);
    return { display: override, file: file ?? COMMAND, args };
  }
  // Asked exactly the way it will be run, including as which user, a probe that consults a
  // different PATH than the call is a probe that can be confidently wrong in both directions.
  const look = asUser("sh", ["-c", `command -v ${COMMAND}`]);
  const probe = HOST_EXEC
    ? { file: "nsenter", args: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", look.file, ...look.args] }: { file: "sh", args: ["-c", `command -v ${COMMAND}`] };
  try {
    const { stdout } = await execFileAsync(probe.file, probe.args, { timeout: 5_000 });
    const hit = stdout.trim();
    if (hit) return { display: hit, file: hit, args: [] };
  } catch {
    /* nothing on this side: the Windows side may still have it */
  }
  return isWSL() ? windowsProvider(): null;
}

let cache: UsageResult | null = null;
let inflight: Promise<UsageResult> | null = null;

function parse(stdout: string): Usage | null {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && typeof (parsed as Usage).status === "string") {
      return parsed as Usage;
    }
  } catch {
    /* not JSON: fall through */
  }
  return null;
}

function run(found: Provider): Promise<UsageResult> {
  const { file, args } = usageCommand(found);
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT, maxBuffer: 1 << 20, cwd: found.cwd }, (err, stdout) => {
      const usage = parse(String(stdout ?? ""));
      // Exit 1 still prints JSON with a failure status, and that status is more informative than
      // anything we could invent, so it wins over the exit code.
      if (usage) {
        resolve({ ok: usage.status === "ok", usage, at: Date.now(), cached: false });
        return;
      }
      resolve({
        ok: false,
        usage: { status: err ? "request_failed": "unreadable" },
        at: Date.now(),
        cached: false,
      });
    });
  });
}

/**
 * Current usage, cached. Concurrent callers share one run, with several browser tabs open this is
 * the difference between one cookie copy and five.
 */
export async function readUsage(): Promise<UsageResult> {
  /*
   * No provider installed is a DIFFERENT state from a provider that failed, and collapsing them
   * was the old behaviour: everybody without the private sibling project got a permanent "usage
   * unknown", which reads as "something is broken" rather than "you never installed this".
   *
   * Checked before the cache, and cheaply: a `command -v` on the same machine that would run it.
   */
  const found = await usageProvider();
  if (!found) {
    return { ok: false, usage: { status: "not_configured" }, at: Date.now(), cached: false, provider: null };
  }
  const ttl = cache?.ok ? OK_TTL: FAIL_TTL;
  if (cache && Date.now() - cache.at < ttl) return {...cache, cached: true, provider: found.display };
  if (inflight) return inflight;
  inflight = run(found)
.then((r) => ({...r, provider: found.display }))
.then((r) => {
      cache = r;
      return r;
    })
.finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test seam: drop the cache so a stub change is picked up immediately. */
export function resetUsageCache(): void {
  cache = null;
  inflight = null;
}
