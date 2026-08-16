/**
 * Passive audit log: a written record of everything Burrow's session layer does, so its
 * behavior can be reviewed after the fact instead of taken on trust.
 *
 * Append-only JSONL at ~/.burrow/audit.log (on the /root mount, so it survives container
 * rebuilds and accumulates across days of use). One line per event:
 *   {"ts":"…","level":"info","event":"session_kill","name":"burrow_x","reason":"idle_92000ms"}
 *
 * Deliberately does NOT record terminal keystrokes or output, only lifecycle actions, 
 * so it stays small and privacy-preserving. Logging is best-effort: it never throws and
 * never blocks the gateway. `warn`/`error` lines are the ones to grep for; they mark
 * things that should not normally happen.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { inheritOwner } from "./hostUser.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Level = "info" | "warn" | "error";

function auditFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "audit.log");
}

let ensuredDir = false;

export function audit(event: string, data: Record<string, unknown> = {}, level: Level = "info"): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + "\n";
  void (async () => {
    try {
      const file = auditFile();
      if (!ensuredDir) {
        await mkdir(dirname(file), { recursive: true });
        await inheritOwner(dirname(file));
        ensuredDir = true;
      }
      await appendFile(file, line);
    } catch {
      /* best-effort: never let logging break the gateway */
    }
  })();
  // Surface anomalies on stderr too (visible in `docker logs`), not just the file.
  if (level !== "info") console.error(`[burrow:${level}] ${event}`, JSON.stringify(data));
}
