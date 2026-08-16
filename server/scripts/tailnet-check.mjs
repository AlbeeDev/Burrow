// Confirms the full production path works: wss through Tailscale Serve → gateway.
//
//   node scripts/tailnet-check.mjs wss://<your-node>.<your-tailnet>.ts.net
//
// The URL is required rather than defaulted, because the only sensible default is somebody's own
// machine, which is what this script used to carry.
import { WebSocket } from "ws";
const URL = process.argv[2];
if (!URL) {
  console.error("Usage: node scripts/tailnet-check.mjs wss://<your-node>.<your-tailnet>.ts.net");
  process.exit(1);
}
const ws = new WebSocket(URL);
let id = 1;
const req = (m, p = {}) =>
  new Promise((res) => {
    const i = String(id++);
    ws._r ??= {};
    ws._r[i] = res;
    ws.send(JSON.stringify({ type: "req", id: i, method: m, params: p }));
  });
ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.type === "res") ws._r?.[f.id]?.(f);
});
ws.on("open", async () => {
  const c = await req("connect");
  const pl = await req("projects.list");
  console.log("connect ok:", c.ok, "protocol:", c.payload?.protocol);
  console.log("projects.list ok:", pl.ok, "count:", pl.payload?.projects?.length);
  console.log(c.ok && pl.ok ? "\nTAILNET WSS: PASSED": "\nTAILNET WSS: FAILED");
  process.exit(c.ok && pl.ok ? 0: 1);
});
ws.on("error", (e) => {
  console.error("TAILNET WSS: ERROR: ", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("TAILNET WSS: TIMEOUT");
  process.exit(1);
}, 15000);
