/**
 * Tiny shared settings store (/root/.burrow/settings.json) with merge semantics, so
 * different features (active account, disabled MCP servers, …) can persist keys
 * without clobbering each other.
 */

import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function settingsFile(): string {
  const base = process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow");
  return join(base, "settings.json");
}

export function readSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed: {};
  } catch {
    return {};
  }
}

export function patchSettings(patch: Record<string, unknown>): void {
  const next = {...readSettings(), ...patch };
  try {
    const file = settingsFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort persistence */
  }
}
