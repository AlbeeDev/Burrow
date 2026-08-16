#!/usr/bin/env node
/**
 * The `burrow` MCP server: stdio, zero dependencies, one tool.
 *
 * Claude Code runs headless on this box and has no way to SHOW a human anything. This
 * process is the missing half: `show` hands a file path to the Burrow gateway, which puts it on
 * screen in whatever browser is looking at that project.
 *
 * ONE tool per capability, and this file declares none of them. At
 * `initialize` it asks the gateway for the tool list over the socket, and `tools/call` is a
 * generic forward. Adding a tool is therefore a gateway-side change only, no editing this file,
 * and no redeploying it to every host session, because sessions fetch the list when they start.
 *
 * That matters because this script is copied to ~/.burrow at gateway startup but a RUNNING
 * `claude` keeps whatever it loaded at session start. Owning the tool list here meant a new tool
 * could not reach a live session at all.
 *
 * Why no SDK: `claude` runs on the HOST (via nsenter) while the gateway runs in the
 * container, so this file is COPIED out to ~/.burrow/burrow-mcp.mjs at gateway startup and
 * executed by the host's node. It therefore cannot rely on the gateway's node_modules, 
 * everything here is stdlib. The protocol surface a stdio MCP server needs is small
 * (initialize / tools/list / tools/call, newline-delimited JSON-RPC 2.0), so this is the
 * cheaper trade.
 *
 * Transport to the gateway is a unix socket (~/.burrow/mcp.sock) because compose publishes
 * no host ports: the two sides meet on the /root:/root bind mount, not on TCP.
 */

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** Echoed back to the client when it asks for a version; only used if it asks for none. */
const PROTOCOL_FALLBACK = "2025-06-18";
const SOCKET = process.env.BURROW_MCP_SOCK?.trim() || join(homedir(), ".burrow", "mcp.sock");

/**
 * The one tool we can describe without the gateway. Used ONLY when the socket is unreachable at
 * initialize: a client that gets an empty tool list assumes the server is broken, whereas this
 * lets the model call `show` and receive the honest "gateway not reachable" sentence instead.
 */
const FALLBACK_TOOLS = [
  {
    name: "list_media",
    title: "List what is on the human's screen",
    description:
      "Read the media list for this project. (Burrow's gateway is not reachable right now, so this " +
      "description is a local fallback and the call will report that.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "write_media",
    title: "Set what is on the human's screen",
    description:
      "Replace the media list for this project. (Burrow's gateway is not reachable right now, so " +
      "this description is a local fallback and the call will report that.)",
    inputSchema: {
      type: "object",
      properties: {
        media: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, caption: { type: "string" } },
            required: ["path"],
          },
        },
      },
      required: ["media"],
    },
  },
];

/** Filled at initialize from the gateway. The gateway is the source of truth, not this file. */
let TOOLS = FALLBACK_TOOLS;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
/** A tool result: text the model reads, plus the isError flag so it can self-correct. */
const say = (id, text, isError) => reply(id, { content: [{ type: "text", text }], isError: !!isError });

/**
 * Why the socket did not answer, in the words of the thing that refused.
 *
 * The first version said "no socket at <path>" for every failure, and that cost a real debugging
 * session: the socket was there, permissions were wrong, and the message sent everyone looking for
 * a missing file. ENOENT and EACCES have completely different fixes, so the
 * code is included in the message.
 */
function unreachable(err) {
  const why =
    err?.code === "EACCES"
      ? `the socket at ${SOCKET} exists but this user cannot connect to it (EACCES)`: err?.code === "ENOENT"
        ? `there is no socket at ${SOCKET}`: `the socket at ${SOCKET} failed with ${err?.code ?? "an unknown error"}`;
  return (
    `Burrow gateway not reachable: ${why}. Nothing was shown; ` +
    `say so rather than telling the human to look at their screen.`
  );
}

/** One request/response over the gateway socket. Never rejects, failures come back as text. */
function ask(payload) {
  return new Promise((done) => {
    const socket = createConnection(SOCKET);
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(result);
    };
    socket.setTimeout(15_000, () => finish({ ok: false, message: "Burrow gateway did not answer in time." }));
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, nl)));
      } catch {
        finish({ ok: false, message: "Burrow gateway sent a malformed reply." });
      }
    });
    // `close` fires after `error` too, so it must not overwrite the reason with a blank one, 
    // `finish` settles once, and the error handler gets there first.
    socket.on("error", (err) => finish({ ok: false, message: unreachable(err) }));
    socket.on("close", () => finish({ ok: false, message: unreachable(null) }));
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => void handle(line));

async function handle(line) {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return; // not our problem to diagnose; the client owns framing
  }
  // Notifications (no id) get no response, by spec, `notifications/initialized` lands here.
  if (msg.id === undefined || msg.id === null) return;

  switch (msg.method) {
    case "initialize": {
      // Ask the gateway what we offer. One round trip, once per session.
      const listed = await ask({ op: "tools" });
      if (listed?.ok && Array.isArray(listed.tools) && listed.tools.length) TOOLS = listed.tools;
      const asked = msg.params?.protocolVersion;
      reply(msg.id, {
        protocolVersion: typeof asked === "string" && asked ? asked: PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "burrow", title: "Burrow", version: "1.0.0" },
        /*
         * Read once, at connect: the only chance to say WHEN this server is worth reaching for.
         * A tool nobody thinks to call is the same as a tool that isn't there, and the failure is
         * silent: a model that describes a chart instead of showing it looks like it answered.
         *
         * Deliberately describes the SHAPE of the moment rather than listing trigger phrases
         *: a list of words invites literal matching and misses everything
         * phrased differently.
         *
         * It was also stale: it named `show`, which stopped existing when the API became
         * list_media / write_media.
         */
        instructions:
          "Burrow is the browser UI this session is being watched through. It gives you a screen " +
          "beside the terminal: `list_media` reads what is on it, `write_media` replaces that " +
          "list. Images, markdown, video, audio, PDF and HTML all render.\n\n" +
          "The moment to use it is when the human wants to LOOK at something rather than be told " +
          "about it, or when your answer is really a file rather than a sentence. If following " +
          "what you are saying would mean them going and opening something themselves, put it on " +
          "the screen instead. They are reading a terminal in a browser panel, often a small one.\n\n" +
          "Assume they do not know this screen exists. Most people never ask for a capability " +
          "they have not been told about, so do not wait to be asked: when something you have " +
          "made would land better looked at than described, offer it.",
      });
      return;
    }
    case "ping":
      reply(msg.id, {});
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name: "";
      if (!TOOLS.some((t) => t.name === name)) {
        fail(msg.id, -32602, `unknown tool: ${name}`);
        return;
      }
      // Generic forward. This file knows nothing about what any tool does, which is the point:
      // the gateway validates arguments, resolves identity from cwd, and checks ownership by pid.
      const answer = await ask({
        op: "call",
        name,
        arguments: msg.params?.arguments ?? {},
        // Our pid, so the gateway can check by ancestry that this really is one of its sessions:
        // the MCP server is a child of `claude`, which is a child of a tmux pane Burrow started
        // or a bubble process it spawned. An env-var marker could not answer this, tmux drops
        // `-e` on reattach, and the tool is registered at user scope, so every `claude` on the
        // box has it, including ones Burrow knows nothing about.
        pid: process.pid,
        cwd: process.cwd(),
      });
      say(msg.id, answer.message || (answer.ok ? "Done.": "Failed."), !answer.ok);
      return;
    }
    default:
      fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
