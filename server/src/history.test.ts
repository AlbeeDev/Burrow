/**
 * readHistory session-resolution suite: the mode-switch history race.
 * The bug: the newest-mtime.jsonl was trusted blindly, so a just-created empty session
 * file (terminal `claude` booting/dying mid-switch) or an `agent-*` sidecar rendered the
 * bubble chat empty while the real conversation existed one file down. These tests pin
 * the deterministic behavior: newest file WITH messages wins; agent sidecars are ignored.
 *
 * Uses a temp CLAUDE_CONFIG_DIR (history.ts reads it per call), no real ~/.claude touched.
 */
import { afterAll, beforeAll, expect, describe, it } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory } from "./history.js";

const CWD = "/root/fakeproj"; // encoded by history.ts to -root-fakeproj
let tmp: string;
let projDir: string;
let savedEnv: string | undefined;

function entry(type: "user" | "assistant", text: string, sessionId: string): string {
  return JSON.stringify({ type, sessionId, message: { role: type, content: text } }) + "\n";
}
function meta(sessionId: string): string {
  return JSON.stringify({ type: "summary", sessionId }) + "\n";
}
/** Set a file's mtime to a fixed offset (seconds) so recency ordering is deterministic. */
async function ageFile(path: string, secondsAgo: number): Promise<void> {
  const t = new Date(2026, 0, 1, 12, 0, 0, 0).getTime() / 1000 - secondsAgo;
  await utimes(path, t, t);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "history-"));
  savedEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  projDir = join(tmp, "projects", "-root-fakeproj");
  await mkdir(projDir, { recursive: true });

  // Oldest: the real conversation.
  const full = join(projDir, "aaa-full.jsonl");
  await writeFile(full, entry("user", "hello", "sess-full") + entry("assistant", "hi", "sess-full"));
  await ageFile(full, 300);

  // Newer: a just-created session with no messages yet (the race window).
  const empty = join(projDir, "bbb-empty.jsonl");
  await writeFile(empty, meta("sess-empty"));
  await ageFile(empty, 100);

  // Newest of all: an agent (Task) sidecar: has messages but is NOT the conversation.
  const agent = join(projDir, "agent-zzz.jsonl");
  await writeFile(agent, entry("user", "subagent prompt", "sess-agent"));
  await ageFile(agent, 10);
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  await rm(tmp, { recursive: true, force: true });
});

describe("readHistory session resolution", () => {
  it("returns the newest session that actually has messages, not the newest file", async () => {
    const h = await readHistory(CWD);
    expect(h.sessionId).toBe("sess-full");
    expect(h.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("never resolves to an agent-* sidecar even when it is the newest file", async () => {
    const h = await readHistory(CWD);
    expect(h.sessionId).not.toBe("sess-agent");
  });

  it("falls back to the newest (empty) session when no session has messages", async () => {
    // A second project dir containing only an empty session.
    const dir2 = join(tmp, "projects", "-root-emptyproj");
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "only.jsonl"), meta("sess-lonely"));
    const h = await readHistory("/root/emptyproj");
    expect(h.sessionId).toBe("sess-lonely");
    expect(h.messages).toEqual([]);
  });

  it("returns empty for a project with no session dir at all", async () => {
    const h = await readHistory("/root/never-existed");
    expect(h.sessionId).toBeNull();
    expect(h.messages).toEqual([]);
  });
});
