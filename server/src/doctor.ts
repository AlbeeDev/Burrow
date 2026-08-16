/**
 * Preflight checks: "can this machine actually run Burrow, and if not, what do I type?"
 *
 * Why this exists. Auditing a fresh WSL box by hand turned up node missing,
 * `claude` missing, and `npm` silently resolving to the *Windows* install through WSL's PATH
 * interop. His point: every one of those is a setup step, and expecting a new user to already have
 * them is how an install fails silently. So the checklist belongs in the product, not in a message
 * I typed once.
 *
 * The bar is that a failed check must be actionable. "tmux: missing" is a bug report; "tmux:
 * missing: sudo apt install tmux" is an install step. Every failure below carries the command
 * that fixes it, chosen for the platform actually detected.
 *
 * This never blocks startup. The decision logic is pure and the probing is injected, so the
 * whole thing is testable without a machine that is missing things, and, more importantly, so a
 * running instance can never be refused a start by a check that was wrong about it. The Docker
 * deployment is exactly that case: with `BURROW_HOST_EXEC=1`, `tmux` and `claude` live on the host
 * and are invoked through `nsenter`, so probing the container's own PATH for them would report two
 * confident failures about a system that works fine.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Level = "ok" | "warn" | "fail";

export type Check = {
  name: string;
  level: Level;
  detail: string;
  /** The command that fixes it. Absent when there is nothing to do. */
  fix?: string;
};

/** What the checks need to know about the machine. Injected so this file stays testable. */
export type Probe = {
  /** Absolute path a command resolves to, or null when it isn't on PATH. */
  which: (cmd: string) => string | null;
  /** `process.versions.node`, e.g. "22.22.2". */
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** True when running under WSL: changes the advice, not the checks. */
  isWSL: boolean;
  /** True when tmux/claude are expected on the HOST rather than here (BURROW_HOST_EXEC=1). */
  hostExec: boolean;
  /**
   * Has Claude Code been logged in? `"unknown"` when we cannot prove either way, macOS keeps
   * credentials in the Keychain rather than a file, so a missing file there means nothing.
   */
  claudeAuth: "yes" | "no" | "unknown";
};

/** Burrow runs `tsx src/index.ts` directly; node 20 is where the APIs it uses settled. */
const NODE_MIN = 20;

function installHint(pkg: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return `brew install ${pkg}`;
  return `sudo apt install ${pkg}   # or your distro's package manager`;
}

/**
 * Decide the checklist from a set of probe results. Pure, no filesystem, no child processes.
 */
export function runChecks(probe: Probe): Check[] {
  const checks: Check[] = [];

  // --- node ------------------------------------------------------------------
  const major = Number(probe.nodeVersion.split(".")[0] ?? 0);
  checks.push(
    major >= NODE_MIN
      ? { name: "node", level: "ok", detail: `v${probe.nodeVersion}` }: {
          name: "node",
          level: "fail",
          detail: `v${probe.nodeVersion}: Burrow needs ${NODE_MIN} or newer`,
          fix: "nvm install 22   # https://github.com/nvm-sh/nvm",
        },
  );

  // The WSL trap that cost a real half hour: `npm` resolves to C:\Program Files\nodejs and then
  // cannot find `node`, because Windows' PATH is appended to WSL's. Nothing is broken on either
  // side: the two halves just belong to different machines.
  const npmPath = probe.which("npm");
  if (probe.isWSL && npmPath?.startsWith("/mnt/c/")) {
    checks.push({
      name: "npm",
      level: "warn",
      detail: `resolving to Windows (${npmPath}), WSL inherits the Windows PATH`,
      fix: "install node inside WSL (nvm install 22); it takes precedence once installed",
    });
  }

  // --- tmux ------------------------------------------------------------------
  // Not optional: terminal sessions ARE tmux sessions, and surviving a disconnect is the product.
  if (probe.hostExec) {
    checks.push({
      name: "tmux",
      level: "ok",
      detail: "expected on the host (BURROW_HOST_EXEC=1), not checked here",
    });
  } else {
    const tmux = probe.which("tmux");
    checks.push(
      tmux
        ? { name: "tmux", level: "ok", detail: tmux }: {
            name: "tmux",
            level: "fail",
            detail: "not found: terminal sessions cannot start without it",
            fix: installHint("tmux", probe.platform),
          },
    );
  }

  // --- claude ----------------------------------------------------------------
  if (probe.hostExec) {
    checks.push({
      name: "claude",
      level: "ok",
      detail: "expected on the host (BURROW_HOST_EXEC=1), not checked here",
    });
  } else {
    const claude = probe.which("claude");
    checks.push(
      claude
        ? { name: "claude", level: "ok", detail: claude }: {
            name: "claude",
            level: "fail",
            detail: "Claude Code is not installed: Burrow is a front door to it",
            fix: "npm install -g @anthropic-ai/claude-code   # then run `claude` once to log in",
          },
    );
  }

  // --- claude's login --------------------------------------------------------
  // Installed is not the same as ready: a `claude` that has never been logged in opens a login
  // prompt, and in Burrow that prompt appears inside a browser terminal with no explanation of
  // why. Deliberately a warn and not a blocker, for two reasons, logging in from that browser
  // terminal genuinely works, and on macOS the credentials live in the Keychain where this cannot
  // see them, so failing would be a false blocker on a perfectly good machine.
  if (!probe.hostExec && probe.which("claude") && probe.claudeAuth !== "yes") {
    checks.push({
      name: "login",
      level: "warn",
      detail:
        probe.claudeAuth === "no"
          ? "Claude Code is installed but has never been logged in": "could not tell whether Claude Code is logged in",
      fix: "run `claude` once and sign in, before starting Burrow",
    });
  }

  // --- git -------------------------------------------------------------------
  // Genuinely optional: Burrow shows git state where it finds it and shrugs otherwise.
  const git = probe.which("git");
  checks.push(
    git
      ? { name: "git", level: "ok", detail: git }: { name: "git", level: "warn", detail: "not found, optional", fix: installHint("git", probe.platform) },
  );

  return checks;
}

/** The real machine. The only impure part of this file, and the only part not unit-tested. */
export function realProbe(): Probe {
  return {
    which: (cmd: string) => {
      try {
        return execFileSync("command", ["-v", cmd], { shell: "/bin/sh", encoding: "utf8" }).trim() || null;
      } catch {
        return null;
      }
    },
    nodeVersion: process.versions.node,
    platform: process.platform,
    isWSL: (() => {
      try {
        return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
      } catch {
        return false;
      }
    })(),
    hostExec: process.env.BURROW_HOST_EXEC === "1",
    claudeAuth: claudeAuthState(),
  };
}

/**
 * Look for evidence that `claude` has been signed in, without running it.
 *
 * Three independent signals, any one of which is proof: an injected token, the credentials file
 * Claude Code writes on login, and the `oauthAccount` key it adds to its own config. On macOS the
 * credentials go to the Keychain instead, so "no file" is not evidence of absence there, hence
 * `"unknown"` rather than `"no"`.
 */
function claudeAuthState(): "yes" | "no" | "unknown" {
  if ((process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) return "yes";
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  if (existsSync(join(base, ".credentials.json"))) return "yes";
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    if (cfg?.oauthAccount) return "yes";
  } catch {
    /* no config yet, or unreadable: falls through */
  }
  return process.platform === "darwin" ? "unknown": "no";
}

/** Anything that stops Burrow being usable, as opposed to merely reduced. */
export function blockers(checks: Check[]): Check[] {
  return checks.filter((c) => c.level === "fail");
}

/** The checklist as a person should read it. */
export function formatChecks(checks: Check[]): string {
  const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  const lines = checks.map((c) => {
    const head = `[${mark[c.level]}] ${c.name.padEnd(7)} ${c.detail}`;
    return c.fix && c.level !== "ok" ? `${head}\n${" ".repeat(11)}→ ${c.fix}`: head;
  });
  return lines.join("\n");
}
