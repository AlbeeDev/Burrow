/**
 * The install's questions.
 *
 * Kept apart from `setup.mjs` because the two answer different needs: setup is a sequence of
 * commands, this is a conversation. Also plain Node with no dependencies, it runs before anything
 * is installed.
 *
 * Three rules, and they are the whole design:
 *
 *  - Never ask twice. An existing `server/.env` means this machine has been configured, so a
 *    re-run says so and changes nothing. Re-running the installer after fixing a missing `claude`
 *    must not re-interrogate someone about answers they already gave.
 *  - Never block a script. With no TTY, CI, a pipe, `npm install` inside another tool, every
 *    question silently takes its default. An installer that hangs waiting for input nobody can
 *    give is worse than one that guesses.
 *  - Only ask what the answer changes. Two questions. Bind address and tokens
 *    stay in the generated file with comments, because almost nobody changes them and asking makes
 *    an install feel like an interrogation.
 *  - Never dead-end: offer. Borrowed from `create-vite`, which on a non-empty target directory
 *    does not simply stop. The first version of this file answered a path that did not exist with
 *    *"Create it first, or give another path"*, which sends someone to a second terminal in the
 *    middle of an install. Anything the installer can do itself, it should offer to do, and where
 *    it genuinely has to refuse, as it does for a projects root that is not empty, the refusal
 *    arrives with a suggestion already loaded as the default, so the way out is one keypress.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";

export const DEFAULT_PORT = 8317;

/**
 * A folder of Burrow's own, rather than your home directory.
 *
 * Home was the first default and it is wrong for everyone who is not root on a VPS: every directory
 * directly inside becomes a project, so a normal account opens Burrow to Downloads, Documents, snap
 * and.config's neighbours presented as things to work in. It also silences the first-run tour,
 * which has nothing to teach someone who already appears to have twenty projects.
 *
 * The question is still asked and any path is still accepted, but it has to be empty or not exist
 * yet: this root is a namespace Burrow owns, not a window onto somewhere you already keep things.
 * Somebody who wants Burrow to reach existing code can symlink or move it in, which is a deliberate
 * act rather than a side effect of pressing enter.
 */
export const DEFAULT_PROJECTS_DIR = "burrow-projects";

/** Is anything listening on this port already? */
async function portFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * Ctrl-C or Ctrl-D in the middle of a question.
 *
 * Readline rejects with an AbortError, and left alone that prints a Node stack trace over an
 * install: for a keypress people use all the time to mean "not now". Nothing has been written at
 * this point, so saying so and leaving is the whole correct behaviour. 130 is the shell's
 * convention for interrupted.
 */
function cancelled(err) {
  if (err?.code === "ABORT_ERR") {
    console.log("\n\nCancelled. Nothing was written.\n");
    process.exit(130);
  }
  throw err;
}

function expand(input) {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed: resolve(process.cwd(), trimmed);
}

/**
 * Ask the two questions. Returns `{ projectsRoot, port }`, always, defaults when there is no
 * terminal to ask.
 */
export async function askConfig({ intro } = {}) {
  const defaults = { projectsRoot: join(homedir(), DEFAULT_PROJECTS_DIR), port: DEFAULT_PORT };

  if (!stdin.isTTY) {
    // Same reason as the default below: it is a folder that usually does not exist yet, and there
    // is nobody here to be asked. Best-effort, a failure to create it is not worth aborting an
    // install over, and the gateway reports a missing projects root clearly enough on its own.
    try {
      mkdirSync(defaults.projectsRoot, { recursive: true });
    } catch {
      /* permissions, or a file in the way: say nothing, there is no terminal reading this */
    }
    return {...defaults, interactive: false };
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    // The Docker install asks one more question and writes a different file, so the two lines
    // naming both are its to supply. Everything below is identical on purpose.
    console.log(
      intro ??
        "\nTwo questions, then Burrow installs itself.\n" +
          "Press enter to take the default in [brackets]; everything else lives in server/.env.\n",
    );

    // --- where the projects are ---
    let projectsRoot = defaults.projectsRoot;
    for (;;) {
      const answer = (await rl.question(`Where do your projects live? [${defaults.projectsRoot}] `).catch(cancelled)).trim();
      // The default goes through the same checks as a typed answer, rather than being taken on
      // trust. It has to, since it stopped being the home directory it is a folder that usually
      // does not exist yet, and accepting it unexamined would start Burrow on a missing path.
      const path = answer ? expand(answer): defaults.projectsRoot;

      if (!existsSync(path)) {
        // Offer, don't refuse. Creating a directory is the installer's job as much as anyone's.
        const yes = (await rl.question(`  ${path} doesn't exist. Create it? [Y/n] `).catch(cancelled)).trim().toLowerCase();
        if (yes === "n" || yes === "no") {
          console.log("");
          continue;
        }
        try {
          mkdirSync(path, { recursive: true });
          console.log(`  created ${path}`);
        } catch (err) {
          // Permissions, a file in the way, a read-only mount, say which, and ask again.
          console.log(`  could not create it: ${err.message}\n`);
          continue;
        }
      } else if (!statSync(path).isDirectory()) {
        console.log(`  ${path} is a file, not a directory.\n`);
        continue;
      } else {
        /*
         * A directory that is not empty is refused. Every folder in it would
         * appear as a project on the first screen, named after something nobody meant as one, and,
         * because a fresh install would then look like an established one, the tour would decide it
         * had nothing to teach and stay silent. This root is a namespace Burrow owns; it is not a
         * view onto somewhere you already keep things.
         *
         * Files count too, not just folders. A file dropped in here is not shown by anything and
         * belongs to no project, so it is not harmless, it is lost, and a rule
         * of "empty" is one somebody can hold in their head, where "no subdirectories, files are
         * fine" is a footnote nobody reads.
         *
         * Hidden entries are still ignored: a `.git` or a `.DS_Store` is invisible to Burrow and to
         * the person reading this message, and refusing over one is an installer picking a fight it
         * cannot explain on screen.
         */
        let existing = [];
        try {
          existing = readdirSync(path, { withFileTypes: true })
.filter((e) => !e.name.startsWith("."))
.map((e) => e.name);
        } catch {
          /* unreadable: `boundPath` will have its own opinion later; not this question's problem */
        }
        if (existing.length) {
          // One line. An installer that lectures you for typing a path is worse than one that just
          // says no; the bracketed default on the next line already offers the way out.
          console.log(`  ${path} is not empty. Burrow needs a folder of its own.\n`);
          continue;
        }
      }
      projectsRoot = path;
      break;
    }
    console.log("");

    // --- the port ---
    let port = defaults.port;
    for (;;) {
      const answer = (await rl.question(`Port for the web interface? [${defaults.port}] `).catch(cancelled)).trim();
      const wanted = answer ? Number(answer): defaults.port;
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) {
        console.log("  Needs to be a number between 1 and 65535.\n");
        continue;
      }
      if (!(await portFree(wanted))) {
        // Not fatal: it may be Burrow itself from an earlier run, so offer rather than refuse.
        const again = (
          await rl.question(`  Something is already listening on ${wanted}. Use it anyway? [y/N] `).catch(cancelled)
        )
.trim()
.toLowerCase();
        if (again !== "y" && again !== "yes") continue;
      }
      port = wanted;
      break;
    }
    console.log("");
    return { projectsRoot, port, interactive: true };
  } finally {
    rl.close();
  }
}

/**
 * The Docker-only third question: publish on your tailnet?
 *
 * Lives here rather than in `docker-setup.mjs` because this file is where the install *talks*, and
 * the same three rules apply: no TTY means no, and the answer is only asked because it changes
 * something real (whether the sidecar service exists at all).
 *
 * Returns `{ tailscale: false }` or `{ tailscale: true, authKey }`.
 */
export async function askTailscale() {
  if (!stdin.isTTY) return { tailscale: false };

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const yes = (await rl.question("Publish on your tailnet, via a Tailscale sidecar? [y/N] ").catch(cancelled))
.trim()
.toLowerCase();
    if (yes !== "y" && yes !== "yes") return { tailscale: false };
    // Asked now rather than left as a blank to fill in, because a sidecar with no key does not
    // fail loudly: it starts, fails to authenticate, and restarts forever while the app itself
    // looks fine. Better to be asked once here.
    console.log("  Reusable key: https://login.tailscale.com/admin/settings/keys");
    const authKey = (await rl.question("  Auth key: ").catch(cancelled)).trim();
    if (!authKey) console.log("  Blank: set TS_AUTHKEY in.env before starting.");
    console.log("");
    return { tailscale: true, authKey };
  } finally {
    rl.close();
  }
}
