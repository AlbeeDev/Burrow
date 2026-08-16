/**
 * Write the starter config from the installer's answers.
 *
 *   npx tsx scripts/write-config.ts <projectsRoot> <port>
 *
 * A file rather than an inline `tsx -e`, which is what this started as: quoting an ESM import
 * through execFileSync worked nowhere and failed with a stack trace that pointed at the wrong
 * thing entirely.
 *
 * It exists so the installed path and the never-installed path produce the same file. `npm start`
 * on a machine that skipped the installer calls `bootstrapConfig` too, just with derived values
 * instead of answers: one function, one format, no chance of the two drifting.
 */
import { bootstrapConfig } from "../src/bootstrap.js";

const [projectsRoot, rawPort] = process.argv.slice(2);
const port = Number(rawPort);

const result = bootstrapConfig(
  {},
  {
    ...(projectsRoot ? { projectsRoot }: {}),
    ...(Number.isInteger(port) && port > 0 ? { port }: {}),
  },
);

if (result.action === "written") console.log(`  ${result.path}`);
else if (result.action === "kept") console.log(`  kept the existing ${result.path}`);
else if (result.action === "failed") {
  console.error(`  could not write ${result.path}: ${result.message}`);
  process.exit(1);
}
