/**
 * The Docker install's questions, and the `.env` they produce.
 *
 * Why this exists. With Docker the two most important answers, which directory is visible, and
 * which port is published: are decided *before* the app process exists. They are Compose's
 * business, not the server's, so no first-run wizard inside the container could ever set them: a
 * browser cannot mount a directory the container was never given. That is why every self-hosted
 * tool has you write a `.env` first. This replaces "read the README, edit YAML, hope" with the same
 * conversation the bare install has, and it deliberately reuses `askConfig()` verbatim so the two
 * installs cannot drift into asking differently.
 *
 * Run straight from a fresh clone, with no `npm install` first, for the Docker path the image
 * builds everything, so nothing is installed on the host at all. Hence plain Node, no dependencies,
 * nothing imported from `server/`.
 *
 *   node scripts/docker-setup.mjs
 *   docker compose up -d --build
 *
 * It checks before it asks and reports rather than fails, the way `npm run doctor` does. The one
 * exception is an existing `.env`: that means this machine is configured, and re-running must never
 * silently rewrite answers already given (or, worse, a working auth key).
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { askConfig, askTailscale } from "./prompt.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const overrideFile = join(root, "docker-compose.override.yml");

/** Does the command exist? Used only for reporting, so a failure is just "no". */
function has(cmd) {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function quiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

console.log("\nBurrow: Docker setup\n");

/*
 * Three checks, cheapest first, and each failure carries the command that fixes it. `docker info`
 * is the one that catches the common case: Docker is installed and you are simply not in the
 * docker group, which otherwise surfaces much later as a permission error under `compose up`.
 */
const blockers = [];
if (!has("docker")) {
  blockers.push("Docker is not installed.\n  → https://docs.docker.com/engine/install/");
} else {
  if (!quiet("docker", ["compose", "version"])) {
    blockers.push(
      "The Docker Compose plugin is missing (`docker compose version` failed).\n" +
        "  → sudo apt install docker-compose-plugin   (or see docs.docker.com/compose/install)",
    );
  }
  if (!quiet("docker", ["info"])) {
    blockers.push(
      "Docker is installed but this user cannot talk to it.\n" +
        `  → sudo usermod -aG docker ${process.env.USER ?? "$USER"} && newgrp docker\n` +
        "  → or run this and `docker compose` with sudo",
    );
  }
}
if (blockers.length) {
  console.error(blockers.map((b) => `✗ ${b}`).join("\n\n") + "\n");
  process.exit(1);
}

/*
 * Docker Desktop is a different machine.
 *
 * Its containers run inside its own utility VM, not in the Linux you typed this in, so `pid: host`
 * and `nsenter -t 1` land in that VM, and Burrow would run your sessions on a throwaway box with
 * none of your tools, while appearing to work. On WSL specifically this is the likely default,
 * because Docker Desktop's WSL integration puts `docker` on your PATH without installing an engine
 * in your distro. Detected here rather than left to be discovered from the inside.
 */
function dockerDesktop() {
  try {
    const out = execFileSync("docker", ["info", "--format", "{{.OperatingSystem}}{{.Name}}"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return /docker desktop/i.test(out);
  } catch {
    return false;
  }
}
if (dockerDesktop()) {
  console.log(
    "! This is Docker Desktop, whose containers run in its own VM rather than on this machine.\n" +
      "  Burrow runs your sessions in the host's namespaces, so they would land in that VM, \n" +
      "  a different filesystem, without your tools or your Claude login.\n" +
      "  → install Docker Engine here instead: https://docs.docker.com/engine/install/\n" +
      "  → or set BURROW_HOST_EXEC=0 in.env and accept in-container sessions\n",
  );
}

/*
 * Not blockers, because the compose file ships with BURROW_HOST_EXEC=1 and both of these live on
 * the HOST under that setting: the image carries its own copies purely as the in-container
 * fallback. Missing them produces sessions that fail to start, with nothing on screen explaining
 * why, so they are worth saying out loud even though the install can complete without them.
 */
const missing = ["tmux", "claude"].filter((c) => !has(c));
if (missing.length) {
  console.log(
    `! ${missing.join(" and ")} not found.\n` +
      "  Sessions run on this machine, as you, so they need these on your PATH:\n" +
      "  → sudo apt install tmux\n" +
      "  → npm install -g @anthropic-ai/claude-code\n",
  );
}

// Configured already. Saying so and stopping is the whole behaviour, rewriting this file would
// throw away a working auth key to re-ask a question that was already answered.
if (existsSync(envFile)) {
  console.log(`Already configured: ${envFile}\n\nStart it with:\n  docker compose up -d --build\n`);
  process.exit(0);
}

const { projectsRoot, port } = await askConfig({
  intro:
    "\nThree questions, then Burrow is ready to build.\n" +
    "Press enter to take the default in [brackets]; everything else lives in.env.\n",
});
const ts = await askTailscale();

/*
 * HOME is derived, never asked. The first version made the projects answer drive HOME as well, and
 * answering "~/projects" then moved HOME there too, so Burrow looked for the Claude login,
 * ~/.burrow and ~/.bashrc inside a folder that had never held them. The installer does know: it is running as the person whose
 * home it is.
 */
const home = homedir();

/*
 * Mounting the home covers a projects root inside it, which is the normal case and the default. A
 * root somewhere else: /srv, a data disk: needs its own mount, and Compose's own override file is
 * where an install's local additions belong. Written only when it is actually needed, so the usual
 * install has one file to read instead of two.
 */
const inHome = projectsRoot === home || projectsRoot.startsWith(home.endsWith("/") ? home: home + "/");
if (!inHome && !existsSync(overrideFile)) {
  writeFileSync(
    overrideFile,
    `# Written by scripts/docker-setup.mjs: your projects live outside your home directory, so\n` +
      `# they need a mount of their own. Same path inside and out, like the home mount, with\n` +
      `# host-exec, a path the container reports has to exist unchanged on the host.\n` +
      `services:\n  app:\n    volumes:\n      - ${projectsRoot}:${projectsRoot}\n`,
    { flag: "wx" },
  );
  console.log(`Wrote ${overrideFile}: ${projectsRoot} is outside ${home}, so it gets its own mount.\n`);
}

/*
 * Commented-out rather than blank for everything optional. An empty CLAUDE_CODE_OAUTH_TOKEN is not
 * the same as an absent one: it reaches the container as a set-but-empty variable, and a token
 * that exists and is empty fails authentication instead of falling back to the CLI's own login.
 */
const env = `# Burrow's Docker configuration, written by scripts/docker-setup.mjs.
# Re-running that script will not touch this file. Edit it directly, then:
#   docker compose up -d --build

# Your home directory, mounted into the container at the same path and used as HOME in there.
# This is how Burrow finds ~/.claude (your Claude login and session history), ~/.burrow and
# ~/.bashrc, so it has to be the home that actually holds them.
BURROW_HOME=${home}

# Where projects are scanned for. Every directory directly inside it becomes a project.
# Anywhere inside BURROW_HOME needs nothing further; anywhere else gets its own mount in
# docker-compose.override.yml.
BURROW_PROJECTS_ROOT=${projectsRoot}

# Who sessions run as on the host. The container is root, so without this every session is
# root holding the container's PATH, which finds none of your tools, and leaves root-owned
# files in your folders. With it, sessions start as a login shell for this user, so nvm and
# anything else in your profile works exactly as it does in your own terminal.
BURROW_HOST_USER=${userInfo().username}

# The port published on 127.0.0.1. Loopback only, see docker-compose.yml.
BURROW_PORT=${port}

# --- Tailscale sidecar (optional) --------------------------------------------
# Publishes Burrow on your tailnet over HTTPS, with no ports open to the network.
# Uncomment COMPOSE_PROFILES to turn it on; the service does not start without it.
${ts.tailscale ? "": "# "}COMPOSE_PROFILES=tailscale
${ts.tailscale ? "": "# "}TS_AUTHKEY=${ts.authKey ?? ""}
# The node name, and so the URL: https://<name>.<your-tailnet>.ts.net
# BURROW_TS_HOSTNAME=burrow

# --- Claude authentication (optional, recommended) ---------------------------
# A token from \`claude setup-token\`. Without one, Terminal sessions still work and
# use the CLI's own /login, but with several sessions sharing one login, an expiry
# stops all of them at once.
# CLAUDE_CODE_OAUTH_TOKEN=

`;

// "wx": never clobber. The existsSync above is the friendly path; this is the one that holds when
// two terminals race, and it is the reason a re-run can never destroy a working configuration.
writeFileSync(envFile, env, { flag: "wx" });

console.log(`Wrote ${envFile}\n`);
console.log("Start Burrow:\n  docker compose up -d --build\n");
console.log(
  ts.tailscale
    ? "It will come up on your tailnet, and at http://127.0.0.1:" + port + " here.\n": "Then open http://127.0.0.1:" + port + "\n",
);
