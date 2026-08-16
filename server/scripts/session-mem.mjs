#!/usr/bin/env node
/**
 * The post-mortem query: "which session grew, and starting when?"
 *
 * Reads the rolling per-minute log the gateway writes (`~/.burrow/session-stats.jsonl`, or
 * $BURROW_DATA_DIR) and, for every session it saw, reports peak resident size, when that peak
 * happened, and: the part that matters after an incident, the FIRST sample where the session
 * crossed the growth threshold. That timestamp is the thing nobody could answer on 2026-07-31.
 *
 * Usage:
 *   node scripts/session-mem.mjs                 # everything in the log
 *   node scripts/session-mem.mjs --since 2h      # last 2 hours (also: 30m, 3d, or an ISO time)
 *   node scripts/session-mem.mjs --threshold 2G  # what counts as "grew" (default 1G)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]: fallback;
};

function parseSince(v) {
  if (!v) return 0;
  const rel = /^(\d+)([mhd])$/.exec(v);
  if (rel) {
    const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]];
    return Date.now() - Number(rel[1]) * mult;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t: 0;
}

function parseBytes(v) {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg])?b?$/i.exec(String(v).trim());
  if (!m) return 1e9;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] || "").toLowerCase()] ?? 1;
  return Number(m[1]) * mult;
}

const fmt = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB`: n >= 1e6 ? `${Math.round(n / 1e6)} MB`: `${n} B`;
const clock = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const file =
  arg("--file", null) ??
  join(process.env.BURROW_DATA_DIR?.trim() || join(homedir(), ".burrow"), "session-stats.jsonl");
const since = parseSince(arg("--since", null));
const threshold = parseBytes(arg("--threshold", "1G"));

let text;
try {
  text = await readFile(file, "utf8");
} catch {
  console.error(`no session log at ${file}, the gateway writes it once a minute while running`);
  process.exit(1);
}

const byName = new Map();
let samples = 0;
let first = Infinity;
let last = 0;

for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let sample;
  try {
    sample = JSON.parse(line);
  } catch {
    continue; // a torn last line from a crash mid-append is not a reason to lose the rest
  }
  if (!sample?.at || sample.at < since) continue;
  samples++;
  first = Math.min(first, sample.at);
  last = Math.max(last, sample.at);
  for (const s of sample.sessions ?? []) {
    const row =
      byName.get(s.name) ??
      { name: s.name, peak: 0, peakAt: 0, crossedAt: null, lastRss: 0, lastAt: 0, procs: 0 };
    if (s.rssBytes > row.peak) {
      row.peak = s.rssBytes;
      row.peakAt = sample.at;
    }
    if (row.crossedAt === null && s.rssBytes >= threshold) row.crossedAt = sample.at;
    if (sample.at >= row.lastAt) {
      row.lastAt = sample.at;
      row.lastRss = s.rssBytes;
      row.procs = s.procs;
    }
    byName.set(s.name, row);
  }
}

if (!samples) {
  console.error(`no samples in range (${file})`);
  process.exit(1);
}

const rows = [...byName.values()].sort((a, b) => b.peak - a.peak);
const pad = (s, n) => String(s).padEnd(n);

console.log(`${file}`);
console.log(`${samples} samples · ${clock(first)} → ${clock(last)} · threshold ${fmt(threshold)}\n`);
console.log(`${pad("SESSION", 24)}${pad("PEAK", 11)}${pad("AT", 21)}${pad("CROSSED", 21)}${pad("LAST", 11)}PROCS`);
for (const r of rows) {
  console.log(
    pad(r.name, 24) +
      pad(fmt(r.peak), 11) +
      pad(clock(r.peakAt), 21) +
      pad(r.crossedAt ? clock(r.crossedAt): ", ", 21) +
      pad(fmt(r.lastRss), 11) +
      r.procs,
  );
}

const grew = rows.filter((r) => r.crossedAt !== null);
console.log(
  grew.length
    ? `\n${grew.length} session(s) crossed ${fmt(threshold)}; earliest onset: ${clock(
        Math.min(...grew.map((r) => r.crossedAt)),
      )} (${grew.sort((a, b) => a.crossedAt - b.crossedAt)[0].name})`: `\nno session crossed ${fmt(threshold)} in this range`,
);
