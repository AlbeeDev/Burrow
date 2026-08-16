/**
 * Plan-usage reader suite. Real stakes: this is a *permission-ish* signal, if a
 * failed read renders as 0% it looks like a full tank, which is exactly backwards, and the account
 * runs into a wall it was told wasn't there. Also pins the caching the source script's README
 * requires (each real call copies a cookie DB and makes two HTTPS calls to claude.ai).
 *
 * Runs against a STUB script via BURROW_USAGE_CMD, which also counts as "a provider is installed"
 *: the override is a deliberate statement and is never probed. A real provider is an executable
 * called `claude-usage` on PATH; Burrow ships none.
 */
import { afterAll, afterEach, beforeAll, expect, describe, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPath, readUsage, resetUsageCache } from "./usage.js";

let tmp: string;
let saved: string | undefined;
let counter: string;

/** Write a stub that prints `body`, exits `code`, and counts its own invocations. */
async function stub(body: string, code = 0): Promise<void> {
  const script = join(tmp, "stub.sh");
  await writeFile(
    script,
    `#!/bin/sh\necho 1 >> ${counter}\ncat <<'JSON'\n${body}\nJSON\nexit ${code}\n`,
    { mode: 0o755 },
  );
  process.env.BURROW_USAGE_CMD = script;
  resetUsageCache();
}

async function runs(): Promise<number> {
  try {
    return (await readFile(counter, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const OK_JSON = JSON.stringify({
  status: "ok",
  session_pct: 6.0,
  session_resets_at: "2026-07-30T08:00:00Z",
  weekly_pct: 59.0,
  weekly_resets_at: "2026-08-01T07:00:00Z",
  blocking: [{ kind: "weekly_scoped", percent: 100, scope: "Fable" }],
  credits_enabled: false,
  credits_spent: 66.81,
  credits_limit: 40.0,
});

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "usage-"));
  counter = join(tmp, "runs.log");
  saved = process.env.BURROW_USAGE_CMD;
});

afterAll(async () => {
  if (saved === undefined) delete process.env.BURROW_USAGE_CMD;
  else process.env.BURROW_USAGE_CMD = saved;
  await rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(counter, { force: true });
  resetUsageCache();
});

describe("readUsage", () => {
  it("parses the documented shape", async () => {
    await stub(OK_JSON);
    const r = await readUsage();
    expect(r.ok).toBe(true);
    expect(r.usage.session_pct).toBe(6);
    expect(r.usage.weekly_pct).toBe(59);
    expect(r.usage.blocking).toEqual([{ kind: "weekly_scoped", percent: 100, scope: "Fable" }]);
    expect(r.usage.credits_spent).toBeCloseTo(66.81);
  });

  it("accepts a real observed payload, nulls and all", async () => {
    // Verbatim from a live provider run the morning after this was
    // built. Two things the README's example didn't show: credits_limit is `null` (not absent)
    // when no limit is set, and the timestamps carry microseconds plus an offset. The null is what
    // crashed the UI panel on the first real click.
    await stub(
      JSON.stringify({
        status: "ok",
        session_pct: 9.0,
        session_resets_at: "2026-07-30T12:59:59.928663+00:00",
        weekly_pct: 65.0,
        weekly_resets_at: "2026-08-01T06:59:59.928682+00:00",
        blocking: [
          { kind: "weekly_scoped", percent: 100, resets_at: "2026-08-01T06:59:59.928890+00:00", scope: "Fable" },
        ],
        credits_enabled: true,
        credits_spent: 76.58,
        credits_limit: null,
      }),
    );
    const r = await readUsage();
    expect(r.ok).toBe(true);
    expect(r.usage.credits_limit).toBeNull();
    expect(r.usage.credits_spent).toBeCloseTo(76.58);
    expect(r.usage.blocking?.[0]?.scope).toBe("Fable");
    expect(Number.isNaN(new Date(r.usage.session_resets_at!).getTime())).toBe(false); // parseable
  });

  it("keeps the script's own failure status and never claims success", async () => {
    // exit 1 with JSON: the documented failure mode. The status is more useful than the exit code.
    await stub(JSON.stringify({ status: "unauthenticated" }), 1);
    const r = await readUsage();
    expect(r.ok).toBe(false);
    expect(r.usage.status).toBe("unauthenticated");
    expect(r.usage.session_pct).toBeUndefined(); // NOT 0, a zero would read as headroom
  });

  it("survives garbage output", async () => {
    await stub("Traceback (most recent call last): boom", 1);
    const r = await readUsage();
    expect(r.ok).toBe(false);
    expect(r.usage.status).toBe("request_failed");
    expect(r.usage.session_pct).toBeUndefined();
  });

  it("treats a missing script as unknown, not as zero usage", async () => {
    process.env.BURROW_USAGE_CMD = join(tmp, "does-not-exist.sh");
    resetUsageCache();
    const r = await readUsage();
    expect(r.ok).toBe(false);
    expect(r.usage.session_pct).toBeUndefined();
  });

  it("caches, so a page full of pollers costs one run", async () => {
    await stub(OK_JSON);
    const first = await readUsage();
    expect(first.cached).toBe(false);
    const second = await readUsage();
    const third = await readUsage();
    expect(second.cached).toBe(true);
    expect(third.usage.session_pct).toBe(6);
    expect(await runs()).toBe(1);
  });

  it("collapses concurrent callers into one run", async () => {
    await stub(OK_JSON);
    const all = await Promise.all([readUsage(), readUsage(), readUsage(), readUsage()]);
    expect(all.every((r) => r.ok)).toBe(true);
    expect(await runs()).toBe(1);
  });

  it("re-reads after resetUsageCache (what the UI's refresh relies on)", async () => {
    await stub(OK_JSON);
    await readUsage();
    resetUsageCache();
    await readUsage();
    expect(await runs()).toBe(2);
  });
});

describe("no provider installed", () => {
  /**
   * Hide any real provider for the duration.
   *
   * The first version of these tests just unset BURROW_USAGE_CMD and assumed nothing was
   * installed, and failed on the author's own machine, which has `claude-usage` on PATH. An
   * emptied PATH makes the `command -v` probe miss deterministically, and exercises the real
   * detection rather than a guess about the environment.
   */
  async function withoutProvider<T>(fn: () => Promise<T>): Promise<T> {
    const cmd = process.env.BURROW_USAGE_CMD;
    const path = process.env.PATH;
    delete process.env.BURROW_USAGE_CMD;
    process.env.PATH = "/nonexistent";
    resetUsageCache();
    try {
      return await fn();
    } finally {
      if (cmd === undefined) delete process.env.BURROW_USAGE_CMD;
      else process.env.BURROW_USAGE_CMD = cmd;
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      resetUsageCache();
    }
  }

  /*
   * "Never installed" and "installed but broken" are different states, and collapsing them is what
   * the old behaviour did: the path to a private sibling project was hardcoded, so everybody else
   * got a permanent "usage unknown", which reads as something being broken rather than something
   * never having been added.
   */
  it("reports not_configured rather than a failure", async () => {
    const r = await withoutProvider(() => readUsage());
    expect(r.ok).toBe(false);
    expect(r.usage.status).toBe("not_configured");
  });

  it("still never reports a number", async () => {
    // The rule this whole file exists for: a zero reads as headroom, which is the opposite of the
    // truth. Absence must be as unnumbered as failure.
    const r = await withoutProvider(() => readUsage());
    expect(r.usage.session_pct).toBeUndefined();
  });
});

/**
 * The Windows side of detection, as far as it can be tested from Linux.
 *
 * A WSL user's provider usually lives on the Windows side, next to the browser it reads, so Burrow
 * asks `cmd.exe /c where`. Whether that call happens is decided by `/proc/version` and cannot be
 * faked here, but its OUTPUT is the fiddly part, and getting it wrong means either missing an
 * installed provider or "finding" one that isn't there, which then fails on every read.
 */
describe("firstPath", () => {
  it("takes the first match and strips the CR Windows leaves behind", () => {
    // Two matches is normal: a.bat shim next to the real thing.
    const out = "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\claude-usage.bat\r\nD:\\claude-usage\\claude-usage.exe\r\n";
    expect(firstPath(out)).toBe("C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\claude-usage.bat");
  });

  it("answers null for nothing found", () => {
    // `where` puts its "could not find" notice on stderr, so a miss reaches us as blank stdout.
    // Reading that as a hit would report a provider that cannot be run.
    expect(firstPath("")).toBeNull();
    expect(firstPath("\r\n \r\n")).toBeNull();
  });
});
