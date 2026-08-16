/**
 * MCP server selection per project: sharing the CLI's OWN store, so the terminal and the
 * bubble agree.
 *
 * Measured against the CLI (replacing an earlier wrong conclusion): Claude Code persists a
 * per-project disable list at `~/.claude.json → projects["<cwd>"].disabledMcpServers`, and it
 * covers user-scope servers (the ones from `~/.claude.json → mcpServers`). Found empirically, 
 * 27 real project entries on this box carry it with different sets each, and Burrow has never
 * written that file. The earlier conclusion ("no per-project key exists") came from the
 * *settings.json* keys, where only `disabledMcpjsonServers` exists and only covers `.mcp.json`
 * servers. So Burrow's private `disabledMcpByProject` was a parallel truth, exactly the
 * divergence: disable everything in the bubble, then `/mcp` in the terminal shows all
 * enabled.
 *
 * This module now reads and writes THAT list, keyed by absolute cwd like the CLI does. A
 * toggle in either surface is visible to the other because there is only one file.
 *
 * SETTLED against CLI 2.1.220: headless `claude` DOES apply this key itself.
 * Two sandboxed runs, identical but for the key: with the server enabled the model reached
 * `mcp__probeone__ping` and got "pong"; with it disabled the tool was not findable at all while a
 * second, still-enabled server stayed reachable. Rerun with
 * a live probe. (The stream's `init` frame is NOT the signal, it
 * lists every configured server as "pending" regardless.)
 *
 * The `--disallowed-tools mcp__<server>` spawn arg stays anyway, as a deliberate second layer:
 * reading the CLI's store gives the sync; the spawn arg gives the guarantee.
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const KEY = "disabledMcpServers";

/** The CLI's config file. CLAUDE_CONFIG_DIR relocates it (same override history.ts honors). */
function claudeJson(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? join(dir, ".claude.json"): join(homedir(), ".claude.json");
}

function readJson(file: string): Record<string, any> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed: {};
  } catch {
    return {};
  }
}

function serverNames(file: string): string[] {
  const mcp = readJson(file).mcpServers;
  return mcp && typeof mcp === "object" ? Object.keys(mcp): [];
}

export class McpManager {
  /** All MCP server names available for a project (user scope + the project's.mcp.json). */
  servers(cwd?: string): string[] {
    const names = new Set(serverNames(claudeJson()));
    if (cwd) for (const n of serverNames(join(cwd, ".mcp.json"))) names.add(n);
    return [...names].sort();
  }

  /** This project's disabled servers, as the CLI itself stores them. */
  disabled(cwd: string): string[] {
    const entry = readJson(claudeJson()).projects?.[cwd];
    const list = entry?.[KEY];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string"): [];
  }

  /**
   * Write the list back into the CLI's config.
   *
   * Every running `claude` also rewrites this file, so the window between read and write is
   * kept as small as possible and the write is atomic (temp file + rename), a concurrent
   * reader sees either the old file or the new one, never a truncated one. We touch exactly
   * one key of one project entry and preserve everything else verbatim.
   */
  setDisabled(cwd: string, list: string[]): void {
    const file = claudeJson();
    const config = readJson(file);
    if (!config.projects || typeof config.projects !== "object") config.projects = {};
    const entry = config.projects[cwd] && typeof config.projects[cwd] === "object" ? config.projects[cwd]: {};
    entry[KEY] = [...new Set(list.filter((x) => typeof x === "string" && x.trim()))];
    config.projects[cwd] = entry;
    const tmp = `${file}.burrow-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, file);
  }

  /**
   * Publish Burrow's own MCP server to the CLI's user-scope `mcpServers`, so every `claude`
   * on this box: terminal and bubble, already running or not, can call it on its next
   * spawn. Idempotent: an unchanged entry is not rewritten, because every live session reads
   * this file and there is no reason to churn it on a gateway restart.
   */
  registerBurrow(script: string): void {
    const file = claudeJson();
    const config = readJson(file);
    const entry = { type: "stdio", command: "node", args: [script] };
    if (JSON.stringify(config.mcpServers?.burrow) === JSON.stringify(entry)) return;
    if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
    config.mcpServers.burrow = entry;
    const tmp = `${file}.burrow-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, file);
  }

  /** disallowedTools entries that switch off this project's disabled servers at spawn. */
  disallowedTools(cwd: string): string[] {
    return this.disabled(cwd).map((s) => `mcp__${s}`);
  }
}
