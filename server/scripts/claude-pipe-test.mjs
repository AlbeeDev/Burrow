// Verifies the claude.send wire path: connect → claude.send → streamed claude.event.
// Without a valid CLAUDE_CODE_OAUTH_TOKEN this ends in an auth error event, which still
// proves the full pipe (client → gateway → SDK → event → client).
import { WebSocket } from "ws";

const HOST = process.env.BURROW_BIND?.trim() || "127.0.0.1";
const PORT = process.env.BURROW_PORT?.trim() || "8317";
const ws = new WebSocket(`ws://${HOST}:${PORT}`);
let id = 1;
const req = (m, p = {}) =>
  new Promise((r) => {
    const i = String(id++);
    ws._r ??= {};
    ws._r[i] = r;
    ws.send(JSON.stringify({ type: "req", id: i, method: m, params: p }));
  });

ws.on("message", (d) => {
  const f = JSON.parse(d);
  if (f.type === "res") ws._r?.[f.id]?.(f);
  else if (f.type === "event" && f.event === "claude.event") {
    const m = f.payload.message;
    const detail = m.type === "error" ? " - " + m.error : m.subtype ? " (" + m.subtype + ")" : "";
    console.log("claude.event:", m.type + detail);
  }
});

ws.on("open", async () => {
  await req("connect");
  console.log("connected; sending a Claude turn…");
  await req("claude.send", { project: null, message: "Say hi in one word." });
  setTimeout(() => {
    console.log("(done listening)");
    process.exit(0);
  }, 12000);
});
