/**
 * Preflight decisions.
 *
 * The value of this checklist is entirely in being right about a machine it is not running on, so
 * the probe is injected and every interesting case is a fabricated machine. Two failure modes
 * matter:
 *
 *  - A false blocker. Reporting "tmux missing" on the Docker deployment, where tmux lives on
 *    the host behind nsenter, would send someone installing packages to fix a system that works.
 *  - A useless message. "claude: missing" with no command next to it is a bug report, not an
 *    install step. Every non-ok line must carry a fix.
 */
import { expect, describe, it } from "vitest";
import { blockers, formatChecks, runChecks, type Probe } from "./doctor.js";

/** A machine with everything, as the baseline to deviate from. */
const healthy: Probe = {
  which: (cmd) => `/usr/bin/${cmd}`,
  nodeVersion: "22.22.2",
  platform: "linux",
  isWSL: false,
  hostExec: false,
  claudeAuth: "yes",
};
const probe = (over: Partial<Probe> = {}): Probe => ({...healthy, ...over });
const find = (p: Probe, name: string) => runChecks(p).find((c) => c.name === name)!;
/** A machine missing exactly these commands. */
const without = (...missing: string[]) =>
  probe({ which: (cmd) => (missing.includes(cmd) ? null: `/usr/bin/${cmd}`) });

describe("a machine with everything", () => {
  it("reports no blockers", () => {
    expect(blockers(runChecks(healthy))).toEqual([]);
  });
});

describe("things that stop Burrow working", () => {
  it("flags a missing tmux: sessions are tmux sessions", () => {
    const c = find(without("tmux"), "tmux");
    expect(c.level).toBe("fail");
    expect(c.fix).toContain("tmux");
  });

  it("flags a missing claude: Burrow is a front door to it", () => {
    const c = find(without("claude"), "claude");
    expect(c.level).toBe("fail");
    expect(c.fix).toContain("@anthropic-ai/claude-code");
  });

  it("flags a node older than 20", () => {
    expect(find(probe({ nodeVersion: "18.19.0" }), "node").level).toBe("fail");
    expect(find(probe({ nodeVersion: "20.0.0" }), "node").level).toBe("ok");
  });

  it("does not flag a missing git: it is genuinely optional", () => {
    expect(find(without("git"), "git").level).toBe("warn");
    expect(blockers(runChecks(without("git")))).toEqual([]);
  });
});

describe("the Docker deployment", () => {
  it("does not report tmux and claude missing when they live on the host", () => {
    // BURROW_HOST_EXEC=1 runs both through nsenter in the host's namespaces, so the container's
    // own PATH says nothing about them. Two confident false blockers, without this.
    const p = probe({ hostExec: true, which: () => null });
    expect(find(p, "tmux").level).toBe("ok");
    expect(find(p, "claude").level).toBe("ok");
    expect(blockers(runChecks(p))).toEqual([]);
  });
});

describe("WSL", () => {
  it("explains npm resolving to the Windows install", () => {
    // The actual trap, from a real fresh box: WSL appends the Windows PATH, so `npm` is
    // C:\Program Files\nodejs\npm and dies looking for a `node` that is on the other side.
    const p = probe({ isWSL: true, which: (cmd) => (cmd === "npm" ? "/mnt/c/Program Files/nodejs/npm": `/usr/bin/${cmd}`) });
    const c = find(p, "npm");
    expect(c.level).toBe("warn");
    expect(c.detail).toContain("Windows");
    expect(c.fix).toContain("inside WSL");
  });

  it("says nothing about npm when it is a real Linux one", () => {
    const p = probe({ isWSL: true });
    expect(runChecks(p).some((c) => c.name === "npm")).toBe(false);
  });

  it("says nothing about a /mnt/c npm when not under WSL", () => {
    const p = probe({ isWSL: false, which: () => "/mnt/c/Program Files/nodejs/npm" });
    expect(runChecks(p).some((c) => c.name === "npm")).toBe(false);
  });
});

describe("the advice itself", () => {
  it("gives every problem a command to run", () => {
    // The whole bar for this feature: a failure a reader cannot act on is not worth printing.
    const p = probe({ nodeVersion: "18.0.0", which: () => null, isWSL: false });
    for (const c of runChecks(p).filter((c) => c.level !== "ok")) {
      expect(c.fix, `${c.name} has no fix`).toBeTruthy();
    }
  });

  it("matches the advice to the platform", () => {
    expect(find(probe({ platform: "darwin", which: (c) => (c === "tmux" ? null: "/x") }), "tmux").fix).toContain("brew");
    expect(find(without("tmux"), "tmux").fix).toContain("apt");
  });

  it("prints the fix underneath the problem, and not for healthy lines", () => {
    const out = formatChecks(runChecks(without("tmux")));
    expect(out).toMatch(/FAIL.*tmux/);
    expect(out).toContain("→ ");
    expect(out.split("\n").filter((l) => l.includes("→ "))).toHaveLength(1);
  });
});
