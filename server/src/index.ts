/**
 * Burrow gateway entry point. Reads config from the environment, starts an HTTP
 * server that (a) serves the web terminal from./web and (b) hosts the WebSocket
 * gateway on the same port, and wires the two together. See.env.example for config.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createGateway } from "./gateway.js";
import { bootstrapConfig, defaultProjectsRoot } from "./bootstrap.js";
import { formatChecks, realProbe, runChecks } from "./doctor.js";

/*
 * Drop the launcher's own variables before anything downstream can inherit them.
 *
 * Started with `npm start`, this process carries npm's bookkeeping, including
 * `npm_config_prefix`, pointing at `server/`. Every shell Burrow opens then greets its user with
 * *"nvm is not compatible with the npm_config_prefix environment variable"*, and their node
 * manager stops working. Reported from a real install.
 *
 * It has to happen here, not at the spawn site. That was the first attempt and it changed
 * nothing: tmux hands new sessions the environment of the tmux SERVER, which Burrow starts on its
 * first tmux command and which therefore inherits from *this* process. Cleaning the pty call
 * leaves the server, and so every session, polluted anyway. One deletion at the root covers the
 * tmux server, `claude`, and anything either of them spawns.
 *
 * (An already-running tmux server keeps whatever it started with; `tmux -L burrow kill-server`
 * is the one-time cost of having shipped the bug.)
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("npm_") || key === "NODE_OPTIONS") delete process.env[key];
}

// First run with no configuration at all: write a starter server/.env derived from THIS machine,
// so a fresh install describes the box it is on instead of assuming the author's. No-ops when a
// file already exists or when the environment is already configured (the container case).
const boot = bootstrapConfig();

// Load server/.env if present (BURROW_* config + CLAUDE_CODE_OAUTH_TOKEN for Claude mode).
// Existing shell env still applies; this just fills in what isn't already set.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no.env file: fine */
}

if (boot.action === "written") {
  console.log(
    `[burrow] first run: wrote ${boot.path}\n` +
      `         projects root: ${boot.projectsRoot} (every directory inside it is a project)\n` +
      `         edit that file to point Burrow somewhere else, then restart.`,
  );
} else if (boot.action === "failed") {
  // Not fatal: every setting has a working default, so the gateway still starts.
  console.warn(`[burrow] could not write ${boot.path} (${boot.message}), using defaults.`);
}

const token = process.env.BURROW_TOKEN?.trim() || "";
const host = process.env.BURROW_BIND?.trim() || "127.0.0.1";
const port = Number(process.env.BURROW_PORT?.trim() || "8317");
// Derived, not hardcoded: as root this is `/root`, the old literal, so nothing changes for an
// existing install, and for anyone else it is at least their own home rather than someone's VPS.
const projectsRoot = process.env.BURROW_PROJECTS_ROOT?.trim() || defaultProjectsRoot();

// Security posture: Burrow grants root shell access, so it must not be openly reachable.
// Bind to a Tailscale/loopback address, or set BURROW_TOKEN. A public bind (0.0.0.0)
// with no token is refused: UNLESS BURROW_TRUST_NETWORK is set, which declares the
// perimeter is handled externally (the Docker + Tailscale sidecar pattern: no host
// ports published, only the sidecar can reach the container).
const trustNetwork = /^(1|true|yes)$/i.test(process.env.BURROW_TRUST_NETWORK?.trim() || "");
const publicBind = host === "0.0.0.0" || host === ":";
if (publicBind && !token && !trustNetwork) {
  console.error(
    "[burrow] refusing to start: BURROW_BIND is public (0.0.0.0) with no BURROW_TOKEN.\n" +
      "         Bind to your Tailscale IP, set BURROW_TOKEN, or set BURROW_TRUST_NETWORK=1\n" +
      "         if the perimeter is external (Docker + Tailscale sidecar, no published ports).",
  );
  process.exit(1);
}
if (!token) {
  const how = trustNetwork ? "external perimeter (BURROW_TRUST_NETWORK)": `bound to ${host}`;
  console.warn(`[burrow] no BURROW_TOKEN set, relying on network-level security (${how}).`);
}

// Preflight. Reports, never refuses: a check that is wrong about a working machine must not be
// able to take it down, and every failure here still leaves most of Burrow usable. `npm run doctor`
// is the same checklist with an exit code, for use as an install gate.
{
  const problems = runChecks(realProbe()).filter((c) => c.level !== "ok");
  if (problems.length) {
    console.warn(`[burrow] preflight found ${problems.length} thing(s) worth fixing:`);
    console.warn(formatChecks(problems));
    console.warn("[burrow] run `npm run doctor` for the full checklist.");
  }
}

const webDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

const gateway = createGateway({ token, projectsRoot, port });

const httpServer = createServer(async (req, res) => {
  // Per-project file bridge (upload/download/list) is served over HTTP; try it first.
  if (await gateway.handleHttp(req, res)) return;

  const requested = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = normalize(requested === "/" ? "/index.html": requested).replace(/^(\.\.[/\\])+/, "");
  const file = join(webDir, rel);
  if (!file.startsWith(webDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    // Hashed assets are immutable and cached forever; index.html must always revalidate
    // so a new deploy's bundle is picked up immediately (no stale-bundle lock-in).
    const cache = rel.startsWith("/assets/")
      ? "public, max-age=31536000, immutable": "no-cache";
    res
.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": cache,
      })
.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server: httpServer });
gateway.attach(wss);

httpServer.listen(port, host, () => {
  console.log(`[burrow] gateway on http://${host}:${port}  (web terminal + ws, projects root: ${projectsRoot})`);
});
httpServer.on("error", (err) => {
  console.error("[burrow] server error:", err.message);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[burrow] ${signal}: shutting down`);
    // tmux holds the sessions independently, so don't wait to drain the WebSocket terminals, 
    // httpServer.close(cb) would hang on those open connections until Docker SIGKILLs us. Stop
    // the listener and exit promptly instead.
    httpServer.close();
    process.exit(0);
  });
}
