/**
 * `npm run doctor`: check this machine can run Burrow, and print what to type if it can't.
 *
 * Exits 1 when something is genuinely blocking, so it works as an install gate in a script or a
 * README. The gateway runs the same checks at startup but only ever warns; see src/doctor.ts for
 * why refusing to start on a check would be worse than starting reduced.
 */
import { blockers, formatChecks, realProbe, runChecks } from "../src/doctor.js";

const checks = runChecks(realProbe());
console.log("Burrow preflight\n");
console.log(formatChecks(checks));

const bad = blockers(checks);
if (bad.length) {
  console.log(
    `\n${bad.length} blocker(s): Burrow will not work until these are fixed.\n` +
      `Run the command(s) above, then \`npm install\` again.`,
  );
  process.exit(1);
}
console.log("\nReady. `npm start` to run the gateway.");
