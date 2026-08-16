/**
 * De-risk probe: confirm the Claude Agent SDK streams structured events (and auth
 * works headlessly) in this environment. Prints the message types Burrow will render.
 *
 * Usage: node scripts/claude-probe.mjs [cwd]
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = process.argv[2] || process.cwd();
console.log("probing Claude Agent SDK in:", cwd);

try {
  let text = "";
  for await (const m of query({
    prompt: "Reply with exactly this token and nothing else: BURROW_SDK_OK",
    options: { cwd, includePartialMessages: true, permissionMode: "bypassPermissions", maxTurns: 1 },
  })) {
    if (m.type === "system" && m.subtype === "init") {
      console.log(`init  · model=${m.model} · session=${m.session_id} · tools=${(m.tools || []).length}`);
    } else if (m.type === "stream_event" && m.event?.delta?.type === "text_delta") {
      text += m.event.delta.text;
    } else if (m.type === "assistant") {
      console.log("assistant message complete");
    } else if (m.type === "result") {
      console.log(`result · ${m.subtype} · cost=$${m.total_cost_usd} · session=${m.session_id}`);
    }
  }
  console.log("streamed text:", JSON.stringify(text.trim()));
  console.log(text.includes("BURROW_SDK_OK") ? "\nPROBE: PASSED": "\nPROBE: got a response (auth OK), token not matched");
  process.exit(0);
} catch (err) {
  console.error("\nPROBE: FAILED: ", err?.message || err);
  process.exit(1);
}
