/**
 * Per-project MCP suite. Real stakes: this module reads and
 * writes the CLI's OWN config (`~/.claude.json → projects[cwd].disabledMcpServers`) so the
 * terminal's `/mcp` and the bubble's modal cannot disagree. Two things must hold, the exact
 * spawn args stay correct, and a write must never damage the rest of that file, which every
 * running Claude session also reads. Temp CLAUDE_CONFIG_DIR, the real ~/.claude.json is never
 * touched.
 */
import { afterAll, beforeAll, beforeEach, expect, describe, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./mcp.js";

let tmp: string;
let saved: string | undefined;
const A = "/root/alpha";
const B = "/root/beta";

async function seed(extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(tmp, ".claude.json"),
    JSON.stringify({
      // Fields the CLI owns and Burrow must never disturb.
      numStartups: 42,
      oauthAccount: { emailAddress: "someone@example.com" },
      mcpServers: { codegraph: {}, context7: {}, playwright: {} },
      projects: {
        [A]: { hasTrustDialogAccepted: true, lastCost: 1.23, allowedTools: ["Bash"] },
        [B]: { hasTrustDialogAccepted: true },
      },
...extra,
    }),
  );
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mcp-"));
  saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(() => seed());

describe("McpManager (shares the CLI's per-project store)", () => {
  it("reads a disable list the TUI wrote", async () => {
    await seed({
      projects: { [A]: { hasTrustDialogAccepted: true, disabledMcpServers: ["context7", "playwright"] } },
    });
    const mcp = new McpManager();
    expect(mcp.disabled(A)).toEqual(["context7", "playwright"]);
    expect(mcp.disallowedTools(A)).toEqual(["mcp__context7", "mcp__playwright"]);
  });

  it("keeps projects isolated", () => {
    const mcp = new McpManager();
    mcp.setDisabled(A, ["codegraph"]);
    expect(mcp.disabled(A)).toEqual(["codegraph"]);
    expect(mcp.disabled(B)).toEqual([]);
    expect(mcp.disallowedTools(B)).toEqual([]);
  });

  it("writes where the CLI reads, so a bubble toggle is visible to /mcp", async () => {
    new McpManager().setDisabled(A, ["context7"]);
    const raw = JSON.parse(await readFile(join(tmp, ".claude.json"), "utf8"));
    expect(raw.projects[A].disabledMcpServers).toEqual(["context7"]);
  });

  it("preserves every other field in the CLI's config", async () => {
    new McpManager().setDisabled(A, ["codegraph"]);
    const raw = JSON.parse(await readFile(join(tmp, ".claude.json"), "utf8"));
    expect(raw.numStartups).toBe(42);
    expect(raw.oauthAccount.emailAddress).toBe("someone@example.com");
    expect(Object.keys(raw.mcpServers).sort()).toEqual(["codegraph", "context7", "playwright"]);
    expect(raw.projects[A].hasTrustDialogAccepted).toBe(true);
    expect(raw.projects[A].lastCost).toBe(1.23);
    expect(raw.projects[A].allowedTools).toEqual(["Bash"]);
    expect(raw.projects[B]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("creates the project entry when the CLI has never seen that cwd", async () => {
    const mcp = new McpManager();
    mcp.setDisabled("/root/brand-new", ["codegraph"]);
    const raw = JSON.parse(await readFile(join(tmp, ".claude.json"), "utf8"));
    expect(raw.projects["/root/brand-new"].disabledMcpServers).toEqual(["codegraph"]);
    expect(mcp.disabled("/root/brand-new")).toEqual(["codegraph"]);
  });

  it("sanitizes: no duplicates, no blanks, no non-strings", () => {
    const mcp = new McpManager();
    mcp.setDisabled(A, ["codegraph", "codegraph", "", "  ", 7 as unknown as string]);
    expect(mcp.disabled(A)).toEqual(["codegraph"]);
  });

  it("enabling everything writes an empty list, not a missing key", async () => {
    const mcp = new McpManager();
    mcp.setDisabled(A, ["codegraph"]);
    mcp.setDisabled(A, []);
    const raw = JSON.parse(await readFile(join(tmp, ".claude.json"), "utf8"));
    expect(raw.projects[A].disabledMcpServers).toEqual([]);
    expect(mcp.disallowedTools(A)).toEqual([]);
  });

  it("lists user-scope servers and a project's own.mcp.json", async () => {
    const proj = await mkdtemp(join(tmpdir(), "mcpproj-"));
    await writeFile(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
    expect(new McpManager().servers(proj)).toEqual(["codegraph", "context7", "local", "playwright"]);
    await rm(proj, { recursive: true, force: true });
  });

  it("survives an unreadable config instead of throwing", async () => {
    await writeFile(join(tmp, ".claude.json"), "{ truncated");
    const mcp = new McpManager();
    expect(mcp.disabled(A)).toEqual([]);
    expect(mcp.servers()).toEqual([]);
  });
});
