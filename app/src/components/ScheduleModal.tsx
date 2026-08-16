import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Clock, Circle, Plus, CaretDown, TrashSimple } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import type { Schedule } from "../lib/gateway";

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"]; // 0=Sun … 6=Sat
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_PRESETS = ["22:00", "00:00", "01:00", "02:00", "03:00", "04:00"];

/**
 * Convert an "HH:MM" wall-clock in server time (UTC) to the READER'S local time, using today's
 * date so daylight saving is applied correctly. Returns "" if the input isn't a time.
 *
 * This used to be pinned to `Europe/Rome` and captioned "in Italy". Correct for one person, quietly
 * wrong for everyone else, and worse than no conversion, because it looks authoritative. The
 * browser already knows where it is, so it is asked instead of assumed.
 */
function toLocalTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return "";
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The reader's zone, named: "= 03:00 your time" is vague when you have devices in two places. */
function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

function freshRow(): Schedule {
  return {
    id: crypto.randomUUID(),
    // Armed. If you add a schedule, set a time, write a message and pick a chat, you meant it to
    // run, and a row born disarmed fails by doing nothing, which is the failure nobody notices
    // (a fully filled-in schedule once sat switched off and never fired). The toggle
    // stays, for pausing something that already exists.
    enabled: true,
    time: "01:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    // Empty, with the example moved to the placeholder below. A pre-filled value is a value: it
    // saves, it fires, and it named `/night-build`, a skill that exists on exactly one machine.
    message: "",
    chats: [],
    lastFired: null,
  };
}

/** Compact day summary: "every day", "Mon–Fri", or listed names. */
function daysLabel(days: number[]): string {
  if (days.length === 7) return "every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "Mon–Fri";
  return days.map((d) => DAY_NAMES[d]).join(" ");
}

/**
 * Scheduled loop broadcasts: N independent rows, each with its own time, days, message and
 * chats. A row fires its message into each selected chat's LIVE terminal session at its time;
 * chats not running that moment are skipped. Persistent chats only. Owner-only.
 */
export function ScheduleModal({ onClose }: { onClose: () => void }) {
  const { projects, persistentProjects, activeSessions, schedules, setSchedules } = useGateway();

  const [rows, setRows] = useState<Schedule[]>(schedules);
  const [expanded, setExpanded] = useState<string | null>(null);

  const persistentList = projects.filter((p) => persistentProjects.has(p.name));

  function patch(id: string, over: Partial<Schedule>) {
    setRows((prev) => prev.map((r) => (r.id === id ? {...r, ...over }: r)));
  }
  function addRow() {
    const r = freshRow();
    setRows((prev) => [...prev, r]);
    setExpanded(r.id);
  }
  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (expanded === id) setExpanded(null);
  }
  function save() {
    setSchedules(rows);
    onClose();
  }

  const armedCount = rows.filter((r) => r.enabled).length;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        data-tour="schedule-modal"
        className="flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Clock size={18} weight="fill" className="text-accent" />
            <div>
              <h2 className="text-base font-semibold text-ink">Schedules</h2>
              <p className="text-xs text-faint">Each schedule sends one message to its chats at its time.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {rows.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-faint">
              No schedules yet. Add one to broadcast a nightly <span className="font-mono">/loop</span>.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const open = expanded === row.id;
              const selectedCount = persistentList.filter((p) => row.chats.includes(p.name)).length;
              return (
                <div key={row.id} className="rounded-xl border border-line bg-bg">
                  {/* row summary */}
                  <div className="flex w-full items-center gap-3 px-3 py-2.5">
                    {/* arm toggle */}
                    <button
                      onClick={() => patch(row.id, { enabled: !row.enabled })}
                      title={row.enabled ? "Disarm": "Arm"}
                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${row.enabled ? "bg-accent": "bg-line"}`}
                    >
                      <span
                        className={`absolute top-0.5 size-4 rounded-full bg-surface transition-all ${row.enabled ? "left-[18px]": "left-0.5"}`}
                      />
                    </button>
                    <button
                      onClick={() => setExpanded(open ? null: row.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="font-mono text-sm font-semibold text-ink">{row.time}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        {daysLabel(row.days)} · {selectedCount} chat{selectedCount === 1 ? "": "s"} ·{" "}
                        <span className="font-mono">{row.message}</span>
                      </span>
                      <CaretDown
                        size={14}
                        weight="bold"
                        className={`shrink-0 text-faint transition-transform ${open ? "rotate-180": ""}`}
                      />
                    </button>
                    <button
                      onClick={() => removeRow(row.id)}
                      title="Delete schedule"
                      aria-label="Delete schedule"
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-raised hover:text-danger"
                    >
                      <TrashSimple size={14} weight="bold" />
                    </button>
                  </div>

                  {/* row editor */}
                  {open && (
                    <div className="border-t border-line/60 px-4 pb-4 pt-3">
                      {/* time */}
                      <label className="mb-1.5 block text-xs uppercase tracking-wide text-faint">
                        Fire at <span className="normal-case text-faint/70">· server time (UTC)</span>
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="time"
                          value={row.time}
                          onChange={(e) => patch(row.id, { time: e.target.value })}
                          className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-lg tracking-wide text-ink outline-none focus:border-accent"
                        />
                        <div className="flex flex-wrap gap-1">
                          {TIME_PRESETS.map((t) => (
                            <button
                              key={t}
                              onClick={() => patch(row.id, { time: t })}
                              className={`rounded-md px-2 py-1 font-mono text-xs transition-colors ${
                                row.time === t ? "bg-accent text-bg": "border border-line text-faint hover:text-ink"
                              }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      {toLocalTime(row.time) && (
                        <p className="mt-1.5 text-xs text-muted">
                          = <span className="font-mono text-ink">{toLocalTime(row.time)}</span> in{" "}
                          {localZoneName()}
                        </p>
                      )}

                      {/* days */}
                      <label className="mb-1.5 mt-4 block text-xs uppercase tracking-wide text-faint">Days</label>
                      <div className="flex items-center gap-1">
                        {DAY_LABELS.map((lbl, d) => {
                          const on = row.days.includes(d);
                          return (
                            <button
                              key={d}
                              onClick={() =>
                                patch(row.id, {
                                  days: on ? row.days.filter((x) => x !== d): [...row.days, d].sort(),
                                })
                              }
                              title={DAY_NAMES[d]}
                              className={`grid size-8 place-items-center rounded-md text-xs font-semibold transition-colors ${
                                on ? "bg-accent text-bg": "border border-line text-faint hover:text-ink"
                              }`}
                            >
                              {lbl}
                            </button>
                          );
                        })}
                      </div>

                      {/* message */}
                      <label className="mb-1.5 mt-4 block text-xs uppercase tracking-wide text-faint">
                        Message sent to each selected chat
                      </label>
                      <textarea
                        value={row.message}
                        onChange={(e) => patch(row.id, { message: e.target.value })}
                        rows={2}
                        spellCheck={false}
                        // Describes the slot rather than showing a message to copy: an example
                        // reads as "this is the kind of thing that goes here", and the first one
                        // taught the wrong lesson by naming a skill that exists on one machine.
                        // `/loop` and `/goal` are Claude Code built-ins, so everyone has them.
                        placeholder="Send a message to Claude later, you can also send commands like /loop, /goal, etc."
                        className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
                      />

                      {/* chats: persistent only */}
                      <div className="mb-1.5 mt-3 flex items-center justify-between">
                        <span className="text-xs uppercase tracking-wide text-faint">Persistent chats</span>
                        <span className="text-xs text-faint">{selectedCount} selected</span>
                      </div>
                      <div className="max-h-44 overflow-y-auto rounded-lg border border-line">
                        {persistentList.length === 0 ? (
                          <p className="p-3 text-sm text-faint">
                            No persistent chats. Mark a project <span className="text-ink">persistent</span> in its
                            terminal to schedule it.
                          </p>
                        ): (
                          persistentList.map((p) => {
                            const on = row.chats.includes(p.name);
                            const live = activeSessions.has(p.name);
                            return (
                              <button
                                key={p.name}
                                onClick={() =>
                                  patch(row.id, {
                                    chats: on ? row.chats.filter((c) => c !== p.name): [...row.chats, p.name],
                                  })
                                }
                                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised"
                              >
                                <span
                                  className={`grid size-4 shrink-0 place-items-center rounded border ${
                                    on ? "border-accent bg-accent text-bg": "border-line"
                                  }`}
                                >
                                  {on && <span className="text-[10px] leading-none">✓</span>}
                                </span>
                                <span className="flex-1 truncate font-mono text-sm text-ink">{p.name}</span>
                                <Circle size={8} weight="fill" className={live ? "text-accent": "text-line"} />
                                <span className="text-[10px] uppercase tracking-wide text-faint">
                                  {live ? "live": "idle"}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-faint">
                        Only <span className="text-accent">live</span> persistent chats receive the message at fire
                        time; anything not running that moment is skipped.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onClick={addRow}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line py-2.5 text-sm text-faint transition-colors hover:border-accent hover:text-accent"
          >
            <Plus size={14} weight="bold" /> Add schedule
          </button>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className={`text-sm ${armedCount ? "text-ink": "text-faint"}`}>
            {armedCount ? `${armedCount} armed`: "Nothing armed"}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button onClick={save} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
