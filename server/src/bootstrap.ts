/**
 * First-run configuration.
 *
 * The problem this solves. Burrow had no first run. A stranger cloned it, started it, and the
 * gateway silently assumed their projects lived in `/root`, so they got an empty sidebar and
 * nothing telling them why. Nothing was broken and nothing was reported; the app simply described
 * a machine that wasn't theirs. Every value was already overridable (13 `BURROW_*` switches), but
 * you cannot override a default you were never told about.
 *
 * So on a start with no configuration at all, write one, derived from the machine actually running
 * it, and say on stdout where it went. From then on it is an ordinary file the operator edits.
 *
 * It uses `.env` rather than a new format on purpose. `index.ts` already calls
 * `process.loadEnvFile()` on `server/.env` before reading anything, and every setting in Burrow is
 * already an environment variable. A `burrow.config.json` would mean a second source of truth and
 * a merge order to explain, to express exactly what a `.env` already expresses.
 *
 * It never overwrites and never runs when the environment is already configured. A container
 * gets its settings from compose, so there is nothing to bootstrap; writing a file inside it would
 * be noise regenerated on every rebuild. Absence of config is the whole trigger.
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Settings whose presence proves somebody already configured this instance. */
const CONFIGURED_BY_ENV = ["BURROW_PROJECTS_ROOT", "BURROW_BIND", "BURROW_PORT", "BURROW_DATA_DIR"];

export function envFilePath(): string {
  return fileURLToPath(new URL("../.env", import.meta.url));
}

/**
 * Where a fresh install should look for projects.
 *
 * The home directory of whoever is running the gateway. As root that is `/root`, which is exactly
 * the old hardcoded value, so this changes nothing for an existing install while giving everyone
 * else somewhere that is at least *theirs*. It is written into the generated file as a plain line
 * to edit, because "my code is in ~/dev" is the common case and guessing that is not our job.
 */
export function defaultProjectsRoot(): string {
  return homedir();
}

/** Where a fresh install should read Claude account tokens from. */
export function defaultBashrc(): string {
  return join(homedir(), ".bashrc");
}

export type BootstrapResult =
  | { action: "written"; path: string; projectsRoot: string }
  | { action: "kept"; path: string }
  | { action: "skipped"; reason: "env" }
  | { action: "failed"; path: string; message: string };

/** The file we generate. Comments included, it is the first documentation a new operator reads. */
export function renderEnv(projectsRoot: string, port: number = 8317): string {
  return `# Burrow configuration: generated on first run.
# Every line here is optional; delete one to fall back to its default.

# Where your projects live. Each DIRECTORY directly inside this path shows up in
# the sidebar as a project. Point it wherever your code actually is (~/dev, /srv, …).
BURROW_PROJECTS_ROOT=${projectsRoot}

# Which address and port the gateway listens on. Burrow gives a browser a shell on
# this machine, so it binds to loopback by default. Before exposing it anywhere,
# put it behind a private network (Tailscale, WireGuard, an SSH tunnel) or set
# BURROW_TOKEN below: the server refuses a public bind with neither.
BURROW_BIND=127.0.0.1
BURROW_PORT=${port}

# Optional shared secret, required as ?token= on every connection.
# BURROW_TOKEN=

# Run tmux and \`claude\` on the host instead of inside a container, via nsenter.
# Only meaningful in the Docker deployment; leave off when running directly.
# BURROW_HOST_EXEC=0

`;
}

/**
 * Write a starter config if, and only if: this instance has none.
 *
 * Best-effort by design: an unwritable directory must not stop the gateway from starting, because
 * every value has a working default anyway. The caller reports the outcome; nothing here throws.
 */
export function bootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
  answers: { projectsRoot?: string; port?: number } = {},
): BootstrapResult {
  if (CONFIGURED_BY_ENV.some((key) => (env[key]?.trim() ?? "") !== "")) {
    return { action: "skipped", reason: "env" };
  }
  const path = envFilePath();
  if (existsSync(path)) return { action: "kept", path };

  // The installer asks; the gateway, reaching here on a `npm start` that skipped the installer,
  // derives. Same file either way, so there is one shape of config and not two.
  const projectsRoot = answers.projectsRoot ?? defaultProjectsRoot();
  try {
    // wx: never clobber a file that appeared between the check and here.
    writeFileSync(path, renderEnv(projectsRoot, answers.port), { flag: "wx" });
    return { action: "written", path, projectsRoot };
  } catch (err) {
    return { action: "failed", path, message: err instanceof Error ? err.message: String(err) };
  }
}
