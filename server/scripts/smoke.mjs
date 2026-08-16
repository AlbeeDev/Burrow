/**
 * End-to-end smoke test for the Burrow gateway.
 *
 * Verifies the full pipe: connect+auth → terminal.open (tmux) → terminal.input →
 * streamed terminal.data. Then proves tmux persistence: sets a shell variable,
 * drops the connection, reconnects, reattaches, and confirms the variable survived.
 *
 * Usage: BURROW_TOKEN=... node scripts/smoke.mjs
 */

import { WebSocket } from "ws";

const TOKEN = process.env.BURROW_TOKEN?.trim(); // optional, omitted if the server has none
const HOST = process.env.BURROW_BIND?.trim() || "127.0.0.1";
const PORT = process.env.BURROW_PORT?.trim() || "8317";
const URL = `ws://${HOST}:${PORT}`;

/** Minimal client: req/res matched by id, plus a terminal.data accumulator. */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const pending = new Map();
    let output = "";
    let nextId = 1;

    const client = {
      output: () => output,
      clearOutput: () => { output = ""; },
      req: (method, params = {}) =>
        new Promise((res, rej) => {
          const id = String(nextId++);
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ type: "req", id, method, params }));
          setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`${method} timed out`))), 5000);
        }),
      close: () => ws.close(),
    };

    ws.on("open", () => resolve(client));
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "res") {
        const p = pending.get(frame.id);
        if (p) { pending.delete(frame.id); frame.ok ? p.res(frame.payload): p.rej(new Error(frame.error?.message)); }
      } else if (frame.type === "event" && frame.event === "terminal.data") {
        output += frame.payload.data;
      }
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (label, cond) => {
  console.log(`  ${cond ? "PASS": "FAIL"}  ${label}`);
  if (!cond) failed = true;
};

try {
  const marker = `BURROW_SMOKE_${Math.floor(Math.random() * 1e9)}`;
  const persistVal = `persist_${Math.floor(Math.random() * 1e9)}`;

  // --- Session 1: connect, open master terminal, run a command, set a var ---
  console.log("session 1: connect + terminal.open + echo");
  const c1 = await connect();
  const connected = await c1.req("connect", { token: TOKEN });
  check("connect returns protocol version", connected?.protocol === 1);

  const opened = await c1.req("terminal.open", { project: null, cols: 100, rows: 30 });
  check("terminal.open returns sessionId", typeof opened?.sessionId === "string");
  check("terminal.open reports tmux session", opened?.tmux === "burrow_master");

  await wait(600); // let tmux + shell start
  c1.clearOutput();
  await c1.req("terminal.input", { sessionId: opened.sessionId, data: `echo ${marker}\n` });
  await c1.req("terminal.input", { sessionId: opened.sessionId, data: `export SMOKE_VAR=${persistVal}\n` });
  await wait(600);
  check("streamed output contains the echo marker", c1.output().includes(marker));

  c1.close();
  await wait(300); // let the socket close (detaches tmux, session lives on)

  // --- Session 2: reconnect, reattach, confirm the shell variable survived ---
  console.log("session 2: reconnect + reattach + confirm persistence");
  const c2 = await connect();
  await c2.req("connect", { token: TOKEN });
  const reopened = await c2.req("terminal.open", { project: null, cols: 100, rows: 30 });
  check("reattach reports same tmux session", reopened?.tmux === "burrow_master");

  await wait(600);
  c2.clearOutput();
  await c2.req("terminal.input", { sessionId: reopened.sessionId, data: `echo VAR=$SMOKE_VAR\n` });
  await wait(600);
  check("shell variable survived the reconnect (tmux persistence)", c2.output().includes(`VAR=${persistVal}`));

  // cleanup: kill the tmux session so repeated runs start clean
  await c2.req("terminal.input", { sessionId: reopened.sessionId, data: `tmux kill-session -t burrow_master\n` });
  await wait(300);
  c2.close();

  console.log(failed ? "\nSMOKE: FAILED": "\nSMOKE: PASSED");
  process.exit(failed ? 1: 0);
} catch (err) {
  console.error("\nSMOKE: ERROR: ", err.message);
  process.exit(1);
}
