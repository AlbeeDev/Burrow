/**
 * The drain decision. This is the code that kills your work, and for weeks it had no test.
 *
 * Every case below is a way it could be wrong while still looking fine in code review.
 */

import { describe, it, expect } from "vitest";
import { drainVerdict, Holds } from "./drain.js";

const QUIET = 90_000;
const NOW = 1_800_000_000_000;
const base = { now: NOW, quietMs: QUIET };

describe("drainVerdict", () => {
  it("cancels when reattached, even if the session has been idle for hours", () => {
    // You came back. How long it was quiet before that is irrelevant, killing it now would
    // destroy the session you are looking at right this second.
    expect(drainVerdict({...base, reattached: true, activityMs: NOW - 6 * 3600_000 })).toEqual({
      action: "cancel",
      reason: "reattached",
    });
  });

  it("cancels: never kills: when the session is already gone", () => {
    // A kill against a name tmux can't resolve is at best a no-op and at worst reaps whatever
    // reused the name.
    expect(drainVerdict({...base, reattached: false, activityMs: null })).toEqual({
      action: "cancel",
      reason: "gone",
    });
  });

  it("kills exactly AT the threshold", () => {
    expect(drainVerdict({...base, reattached: false, activityMs: NOW - QUIET })).toEqual({
      action: "kill",
      idleMs: QUIET,
    });
  });

  it("waits one millisecond under the threshold", () => {
    expect(drainVerdict({...base, reattached: false, activityMs: NOW - QUIET + 1 })).toEqual({
      action: "wait",
    });
  });

  it("waits while the session is still producing output", () => {
    // The guarantee this whole mechanism exists for: an ephemeral session mid-task is not killed
    // just because its browser went away.
    expect(drainVerdict({...base, reattached: false, activityMs: NOW - 2_000 })).toEqual({
      action: "wait",
    });
  });

  it("waits rather than killing when activity is AHEAD of now (clock skew)", () => {
    // Negative idle must never satisfy `idle >= quiet`. A skewed clock or an output written in the
    // same millisecond we read it must cost a poll interval, not the session.
    expect(drainVerdict({...base, reattached: false, activityMs: NOW + 30_000 })).toEqual({
      action: "wait",
    });
  });

  it("shifts only the boundary when given a different quiet threshold", () => {
    const activityMs = NOW - 100_000;
    expect(drainVerdict({...base, quietMs: 90_000, reattached: false, activityMs }).action).toBe("kill");
    expect(drainVerdict({...base, quietMs: 900_000, reattached: false, activityMs }).action).toBe("wait");
  });

  it("puts reattached ahead of gone", () => {
    // Both true at once is a real state: the tick reads `hasLiveSession` from memory and tmux from
    // the host, and they can disagree. The in-memory attachment is the one that means "a human is
    // here", so it must win.
    expect(drainVerdict({...base, reattached: true, activityMs: null })).toEqual({
      action: "cancel",
      reason: "reattached",
    });
  });
});

/**
 * The hold refcount. Getting this wrong has two failure modes, and they fail in opposite
 * directions: too eager and you kill a session someone is still looking at; too lazy and you have
 * recreated the zombie-Claude problem the ephemeral default exists to prevent.
 */
describe("Holds", () => {
  it("reports a session as held while anything holds it", () => {
    const h = new Holds();
    expect(h.isHeld("burrow_a")).toBe(false);
    h.add("conn1:cell:1", "burrow_a", "a");
    expect(h.isHeld("burrow_a")).toBe(true);
  });

  it("survives closing ONE of two holders, the two-Warren case", () => {
    // The same project open in two layouts (or two browsers). Closing one must not kill a session
    // the other still shows. This is why it is a refcount and not an owner.
    const h = new Holds();
    h.add("conn1:cell:1", "burrow_a", "a");
    h.add("conn2:cell:7", "burrow_a", "a");
    expect(h.count("burrow_a")).toBe(2);

    const first = h.remove("conn1:cell:1");
    expect(first).toEqual({ name: "burrow_a", project: "a", last: false });
    expect(h.isHeld("burrow_a")).toBe(true);

    const second = h.remove("conn2:cell:7");
    expect(second).toEqual({ name: "burrow_a", project: "a", last: true });
    expect(h.isHeld("burrow_a")).toBe(false);
  });

  it("is idempotent: replaying the same hold set on reconnect counts nothing twice", () => {
    const h = new Holds();
    h.add("conn1:cell:1", "burrow_a", "a");
    expect(h.add("conn1:cell:1", "burrow_a", "a")).toBeNull();
    expect(h.count("burrow_a")).toBe(1);
  });

  it("reports the displaced hold when a view switches project", () => {
    // The single view's normal case: A → B. If the caller ignores this, session A has no holder
    // AND no countdown, and lives until the gateway restarts.
    const h = new Holds();
    h.add("conn1:single", "burrow_a", "a");
    expect(h.add("conn1:single", "burrow_b", "b")).toEqual({
      name: "burrow_a",
      project: "a",
      last: true,
    });
    expect(h.isHeld("burrow_a")).toBe(false);
    expect(h.isHeld("burrow_b")).toBe(true);
  });

  it("does not report a displaced hold as last when someone else still holds it", () => {
    const h = new Holds();
    h.add("conn1:single", "burrow_a", "a");
    h.add("conn2:cell:3", "burrow_a", "a");
    expect(h.add("conn1:single", "burrow_b", "b")).toEqual({
      name: "burrow_a",
      project: "a",
      last: false,
    });
    expect(h.isHeld("burrow_a")).toBe(true);
  });

  it("drops every hold a disconnected browser owned, and only those", () => {
    const h = new Holds();
    h.add("conn1:cell:1", "burrow_a", "a");
    h.add("conn1:cell:2", "burrow_b", "b");
    h.add("conn2:cell:9", "burrow_b", "b"); // another browser also holds b

    const released = h.removeConn("conn1");
    // Only sessions whose LAST hold went are returned, b is still held by conn2.
    expect(released).toEqual([{ name: "burrow_a", project: "a" }]);
    expect(h.isHeld("burrow_a")).toBe(false);
    expect(h.isHeld("burrow_b")).toBe(true);
  });

  it("treats the master shell (project null) as a normal holdable session", () => {
    const h = new Holds();
    h.add("conn1:cell:1", "burrow_master", null);
    expect(h.remove("conn1:cell:1")).toEqual({ name: "burrow_master", project: null, last: true });
  });

  it("ignores a release for a holder that never existed", () => {
    // A duplicate release, or one arriving after a reconnect wiped the map, must be harmless.
    expect(new Holds().remove("conn9:ghost")).toBeNull();
  });

  it("does not let one connection's prefix match another's", () => {
    // "conn1:" must not match holders of "conn10". A substring bug here would drop a live
    // browser's holds when a different one disconnects.
    const h = new Holds();
    h.add("conn1:cell:1", "burrow_a", "a");
    h.add("conn10:cell:1", "burrow_b", "b");
    expect(h.removeConn("conn1")).toEqual([{ name: "burrow_a", project: "a" }]);
    expect(h.isHeld("burrow_b")).toBe(true);
  });
});
