/**
 * Multi-schedule store logic: pure tests only (parseStore / normalizeRows / dueRows).
 * Deliberately NO fs, NO timers, NO tmux and nothing armed: the roadmap red line for this
 * feature is that tests must never fire an injection. The whole fire decision is the pure
 * dueRows(); the gateway tick is a thin wrapper around it.
 */
import { describe, expect, it } from "vitest";
import { dueRows, normalizeRows, parseStore, type ScheduleRow, keptChats } from "./schedule.js";

function row(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "r1",
    enabled: true,
    time: "01:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    message: "/loop",
    chats: ["burrow"],
    lastFired: null,
...over,
  };
}

// 2026-07-27 01:00 local: a Monday (getDay() === 1).
const MON_0100 = new Date(2026, 6, 27, 1, 0);

describe("parseStore (read + legacy migration)", () => {
  it("migrates the legacy single-object shape to one row, preserving every field", () => {
    const legacy = {
      enabled: true,
      time: "01:00",
      days: [0, 1, 2],
      message: "/loop 25m /night-build",
      chats: ["calene", "burrow"],
      lastFired: "2026-07-25",
    };
    const rows = parseStore(legacy);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.enabled).toBe(true);
    expect(r.time).toBe("01:00");
    expect(r.days).toEqual([0, 1, 2]);
    expect(r.message).toBe("/loop 25m /night-build");
    expect(r.chats).toEqual(["calene", "burrow"]);
    expect(r.lastFired).toBe("2026-07-25"); // preserved → migration can't cause same-day re-fire
    expect(r.id).toBeTruthy(); // generated
  });

  it("reads the current { schedules: [...] } shape", () => {
    const rows = parseStore({ schedules: [row({ id: "a" }), row({ id: "b", time: "03:15" })] });
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[1]!.time).toBe("03:15");
  });

  it("returns [] for garbage / empty / wrong types", () => {
    expect(parseStore(null)).toEqual([]);
    expect(parseStore({})).toEqual([]);
    expect(parseStore("nope")).toEqual([]);
    expect(parseStore({ schedules: "nope" })).toEqual([]);
  });

  it("sanitizes bad fields per-row instead of dropping the row", () => {
    const rows = parseStore({ schedules: [{ id: "x", time: "99:99", days: [9, -1, 3], enabled: "yes" }] });
    const r = rows[0]!;
    expect(r.time).toBe("02:30"); // default
    expect(r.days).toEqual([3]); // invalid days filtered
    expect(r.enabled).toBe(false); // non-boolean → default
  });
});

describe("normalizeRows (schedule.set path)", () => {
  it("keeps the stored lastFired when the row's time is unchanged (client value ignored)", () => {
    const prev = [row({ id: "a", lastFired: "2026-07-26" })];
    const next = normalizeRows([row({ id: "a", lastFired: "2099-01-01" })], prev);
    expect(next[0]!.lastFired).toBe("2026-07-26");
  });

  it("clears lastFired when the row's time changed", () => {
    const prev = [row({ id: "a", time: "01:00", lastFired: "2026-07-26" })];
    const next = normalizeRows([row({ id: "a", time: "02:00" })], prev);
    expect(next[0]!.lastFired).toBeNull();
  });

  it("new rows start with lastFired null regardless of what the client sends", () => {
    const next = normalizeRows([row({ id: "fresh", lastFired: "2026-07-26" })], []);
    expect(next[0]!.lastFired).toBeNull();
  });

  it("deleting a row just drops it; non-array input becomes []", () => {
    expect(normalizeRows([], [row({})])).toEqual([]);
    expect(normalizeRows("junk", [row({})])).toEqual([]);
  });
});

describe("dueRows (the fire decision: every guard)", () => {
  it("fires an armed row at its exact time on a selected day", () => {
    expect(dueRows([row({})], MON_0100).map((r) => r.id)).toEqual(["r1"]);
  });

  it("does not fire when disabled", () => {
    expect(dueRows([row({ enabled: false })], MON_0100)).toEqual([]);
  });

  it("does not fire with no chats", () => {
    expect(dueRows([row({ chats: [] })], MON_0100)).toEqual([]);
  });

  it("does not fire at a different minute", () => {
    expect(dueRows([row({ time: "01:01" })], MON_0100)).toEqual([]);
  });

  it("does not fire on an unselected day", () => {
    expect(dueRows([row({ days: [0, 6] })], MON_0100)).toEqual([]); // Monday not in Sun/Sat
  });

  it("does not fire twice on the same day (lastFired guard)", () => {
    expect(dueRows([row({ lastFired: "2026-07-27" })], MON_0100)).toEqual([]);
    expect(dueRows([row({ lastFired: "2026-07-26" })], MON_0100)).toHaveLength(1); // yesterday ok
  });

  it("selects only the due rows out of many, independently", () => {
    const rows = [
      row({ id: "due" }),
      row({ id: "other-time", time: "03:00" }),
      row({ id: "already", lastFired: "2026-07-27" }),
      row({ id: "off", enabled: false }),
    ];
    expect(dueRows(rows, MON_0100).map((r) => r.id)).toEqual(["due"]);
  });
});

describe("keptChats", () => {
  const persistent = new Set(["skyblock", "burrow"]);

  it("keeps the persistent ones and drops the rest", () => {
    expect(keptChats(["f1", "skyblock", "burrow"], persistent)).toEqual(["skyblock", "burrow"]);
  });

  it("is not inverted", () => {
    // The whole reason this is a function. Inverted, every row loses every chat the next time it
    // fires: silently, with no symptom until a night when nothing runs.
    expect(keptChats(["skyblock"], persistent)).toEqual(["skyblock"]);
    expect(keptChats(["f1"], persistent)).toEqual([]);
  });

  it("leaves an already-clean row untouched", () => {
    const chats = ["burrow"];
    expect(keptChats(chats, persistent)).toEqual(chats);
  });
});
