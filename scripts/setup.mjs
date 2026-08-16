/**
 * Burrow's install. Runs from the repo root as `npm install`'s postinstall step.
 *
 * Deliberately plain Node with no dependencies, because it has to run BEFORE anything is
 * installed: including the `tsx` that the rest of the tooling is written in. That constraint is
 * also why the node-version check is duplicated here in three lines rather than imported from
 * `server/src/doctor.ts`: catching "your node is too old" after a two-minute install, in a stack
 * trace from a syntax error, is the worst possible time to learn it.
 *
 * Order matters and is the whole design:
 *
 *   1. node version: cheapest check, and everything below it assumes the answer
 *   2. ask: before the wait, so nobody watches a progress bar to then be quizzed
 *   3. install both halves: app and server are separate packages, not a workspace
 *   4. build the frontend: Vite's outDir is../server/web, so the gateway can serve it
 *   5. write the config: from the answers given in step 2
 *   6. full preflight: now that `tsx` exists, the real checklist with its fixes
 *
 * A blocker in step 6 fails the install. It first reported success on the grounds that the
 * tree was complete and only the machine was short a package, a distinction nobody outside this
 * file cares about. npm then printed "found 0 vulnerabilities" underneath, which buried the one line
 * that mattered. Exiting non-zero costs nothing: npm does not roll back, so the tree stays
 * installed, the answers stay saved, and re-running after the fix is instant.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { askConfig } from "./prompt.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, "server", ".env");
const NODE_MIN = 20;

function run(label, cmd, args, cwd) {
  process.stdout.write(`\n▸ ${label}\n`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

const major = Number(process.versions.node.split(".")[0]);
if (major < NODE_MIN) {
  console.error(
    `\nBurrow needs Node ${NODE_MIN} or newer, this is v${process.versions.node}.\n` +
      `  → nvm install 22    (https://github.com/nvm-sh/nvm)\n`,
  );
  process.exit(1);
}

// Already configured: a re-run (after installing a missing `claude`, say) must not re-interrogate
// someone about answers they already gave.
const configured = existsSync(envFile);
const answers = configured ? null: await askConfig();
if (configured) console.log(`\nUsing the configuration already in ${envFile}.`);

try {
  run("installing the gateway", "npm", ["install", "--no-audit", "--no-fund"], join(root, "server"));
  run("installing the web app", "npm", ["install", "--no-audit", "--no-fund"], join(root, "app"));
  run("building the web app", "npm", ["run", "build"], join(root, "app"));
} catch {
  // execFileSync already printed the real error; adding a stack trace on top helps nobody.
  console.error("\nInstall failed above. Fix that, then run `npm install` again.\n");
  process.exit(1);
}

// Write the config now that `tsx` exists, reusing the gateway's own bootstrap so the installed and
// the never-installed paths can never drift into producing different files.
if (answers) {
  run(
    "writing your configuration",
    "npx",
    ["tsx", "scripts/write-config.ts", answers.projectsRoot, String(answers.port)],
    join(root, "server"),
  );
}

console.log("\n▸ checking this machine\n");
try {
  execFileSync("npm", ["run", "--silent", "doctor"], { cwd: join(root, "server"), stdio: "inherit" });
} catch {
  // The checklist has already printed each blocker WITH the command that fixes it, so there is
  // nothing to add here beyond the fact that your answers survive the retry.
  console.log("\nYour answers are saved: fix the above and run `./install.sh` again.\n");
  process.exit(1);
}

console.log(`\nDone. \`npm start\` to run Burrow.\n`);
