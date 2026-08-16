/**
 * Claude account selection. Tokens come from the user's ~/.bashrc, the single source of
 * truth they already manage: NOT a frozen copy in Burrow's.env (which drifted and caused
 * a 401 loop). We read it fresh on every call, so editing bashrc updates Burrow with no
 * rebuild. A labelled numbered form gives named accounts; a plain literal gives "default".
 *
 *   export CLAUDE_CODE_OAUTH_TOKEN_1="sk-ant-oat01-…"  # Team account   → id "team"
 *   export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-…"                     → id "default"
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettings, patchSettings } from "./settings.js";

export type Account = { id: string; token: string };

function bashrcPath(): string {
  // Derived rather than hardcoded to `/root/.bashrc`: as root the value is identical, and for any
  // other operator it points at their own shell profile instead of one that doesn't exist.
  return process.env.BURROW_BASHRC?.trim() || join(homedir(), ".bashrc");
}

/** Read Claude tokens from ~/.bashrc, sorted by id. Falls back to env if bashrc is unreadable. */
export function listAccounts(): Account[] {
  let text = "";
  try {
    text = readFileSync(bashrcPath(), "utf8");
  } catch {
    text = "";
  }
  const accounts: Account[] = [];
  const seen = new Set<string>();

  // Numbered + optionally labelled: export CLAUDE_CODE_OAUTH_TOKEN_2="sk-…"  # Pro account
  const numbered = /export\s+CLAUDE_CODE_OAUTH_TOKEN_(\d+)\s*=\s*"(sk-[^"]+)"[^\n]*?(?:#\s*([A-Za-z0-9 _-]+))?$/gim;
  for (let m = numbered.exec(text); m; m = numbered.exec(text)) {
    const [, num, token, rawLabel] = m;
    if (seen.has(token!)) continue;
    const id = (rawLabel?.replace(/account/i, "").trim() || `account${num}`).toLowerCase().replace(/\s+/g, "-");
    accounts.push({ id, token: token! });
    seen.add(token!);
  }

  // Plain literal (skips `="$VAR"` references, which don't match the "sk- prefix").
  const plain = /export\s+CLAUDE_CODE_OAUTH_TOKEN\s*=\s*"(sk-[^"]+)"/im.exec(text);
  if (plain && !seen.has(plain[1]!)) {
    accounts.push({ id: "default", token: plain[1]! });
    seen.add(plain[1]!);
  }

  accounts.sort((a, b) => a.id.localeCompare(b.id));
  if (accounts.length === 0) {
    const fallback = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (fallback) accounts.push({ id: "default", token: fallback });
  }
  return accounts;
}

export class AccountManager {
  private active: string | null;

  constructor() {
    this.active = this.readActive();
  }

  private readActive(): string | null {
    const v = readSettings().activeAccount;
    return typeof v === "string" ? v: null;
  }

  /** Account ids for the client (never the tokens themselves). */
  ids(): string[] {
    return listAccounts().map((a) => a.id);
  }

  activeId(): string {
    const accounts = listAccounts();
    if (this.active && accounts.some((a) => a.id === this.active)) return this.active;
    return accounts[0]?.id ?? "default";
  }

  setActive(id: string): boolean {
    if (!listAccounts().some((a) => a.id === id)) return false;
    this.active = id;
    patchSettings({ activeAccount: id });
    return true;
  }

  /** Token for the active account (used to auth the Claude subprocess). */
  activeToken(): string | undefined {
    const id = this.activeId();
    return listAccounts().find((a) => a.id === id)?.token;
  }
}
