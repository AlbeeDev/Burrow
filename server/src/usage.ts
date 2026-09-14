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
  // The account id the provider read for, echoed back from what Burrow sent (null when none sent).
  // Burrow asserts this matches its request, a mismatch means the switch did not take on their side.
  account?: string | null;
  // Which Claude org the numbers are for; provider-side attribution, unused by Burrow so far.
  org_uuid?: string;
  // The account's plan as an opaque string (e.g. "claude_max 5x"); null/absent when unavailable.
  plan?: string | null;
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

// Cached PER ACCOUNT: different accounts return different numbers, so a global cache would serve the
// previous account's figures for a whole TTL after a switch. Keyed by the id sent ("" when none).
const cache = new Map<string, UsageResult>();
const inflight = new Map<string, Promise<UsageResult>>();

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

function run(found: Provider, account?: string): Promise<UsageResult> {
  const { file, args } = usageCommand(found);
  // The active account rides along on every read (the provider keys a stored session by it); absent
  // it falls back to whatever the browser is logged into, exactly the old behaviour.
  const env = account ? {...process.env, BURROW_USAGE_ACCOUNT: account }: process.env;
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT, maxBuffer: 1 << 20, cwd: found.cwd, env }, (err, stdout) => {
      const usage = parse(String(stdout ?? ""));
      // Exit 1 still prints JSON with a failure status, and that status is more informative than
      // anything we could invent, so it wins over the exit code.
      if (usage) {
        // The provider echoes the id it read for. If we asked for one and got a different one back,
        // the session swap did not take on their side: render unknown rather than a plausible wrong
        // number for the other account (their contract asks us to assert this).
        if (account && usage.account != null && usage.account !== account) {
          resolve({ ok: false, usage: { status: "request_failed" }, at: Date.now(), cached: false });
          return;
        }
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
export async function readUsage(account?: string): Promise<UsageResult> {
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
  const key = account ?? "";
  const hit = cache.get(key);
  const ttl = hit?.ok ? OK_TTL: FAIL_TTL;
  if (hit && Date.now() - hit.at < ttl) return {...hit, cached: true, provider: found.display };
  const pending = inflight.get(key);
  if (pending) return pending;
  const started = run(found, account)
.then((r) => ({...r, provider: found.display }))
.then((r) => {
      cache.set(key, r);
      return r;
    })
.finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, started);
  return started;
}

/** Test seam: drop the cache so a stub change is picked up immediately. */
export function resetUsageCache(): void {
  cache.clear();
  inflight.clear();
  plansCache = null;
  plansInflight = null;
}

/** One configured account and the plan it is on, as `claude-usage --plans` reports it. */
export type AccountPlan = { account: string; status: string; plan?: string | null };

/** The `--plans` answer: every configured account in one call, each with its own status. */
export type PlansResult = { ok: boolean; status: string; accounts: AccountPlan[]; at: number; cached: boolean };

let plansCache: PlansResult | null = null;
let plansInflight: Promise<PlansResult> | null = null;

function parsePlans(stdout: string): { status: string; accounts: AccountPlan[] } | null {
  try {
    const p = JSON.parse(stdout);
    if (p && typeof p === "object" && typeof p.status === "string" && Array.isArray(p.accounts)) {
      const accounts = p.accounts
.filter((a: unknown): a is Record<string, unknown> => !!a && typeof a === "object")
.map((a: Record<string, unknown>) => ({
          account: String(a.account ?? ""),
          status: typeof a.status === "string" ? a.status: "unreadable",
          plan: typeof a.plan === "string" ? a.plan: null,
        }));
      return { status: p.status, accounts };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Every account's plan in ONE provider call (`--plans`): one browser connection for all of them,
 * cached 60s. Preferred over one `--account` read per account (the provider serialises those behind
 * a lock anyway). Each row carries its own status; a failed row simply has no plan. Cached
 * separately from the usage read.
 */
export async function readAccountPlans(): Promise<PlansResult> {
  const found = await usageProvider();
  if (!found) return { ok: false, status: "not_configured", accounts: [], at: Date.now(), cached: false };
  if (plansCache && Date.now() - plansCache.at < OK_TTL) return {...plansCache, cached: true };
  if (plansInflight) return plansInflight;
  const { file, args } = usageCommand({...found, args: [...found.args, "--plans"] });
  plansInflight = new Promise<PlansResult>((resolve) => {
    execFile(file, args, { timeout: TIMEOUT, maxBuffer: 1 << 20, cwd: found.cwd }, (err, stdout) => {
      const parsed = parsePlans(String(stdout ?? ""));
      resolve(
        parsed
          ? { ok: parsed.status === "ok", status: parsed.status, accounts: parsed.accounts, at: Date.now(), cached: false }: { ok: false, status: err ? "request_failed": "unreadable", accounts: [], at: Date.now(), cached: false },
      );
    });
  })
.then((r) => {
      plansCache = r;
      return r;
    })
.finally(() => {
      plansInflight = null;
    });
  return plansInflight;
}
