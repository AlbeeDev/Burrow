/**
 * Slash-command markup in Claude Code session messages.
 *
 * The CLI stores a slash command as a *user* message containing tag soup rather than the
 * typed line: e.g. `<command-message>loop</command-message>\n<command-name>/loop</command-name>
 * \n<command-args>5m /night-build</command-args>`, optionally wrapped by a
 * `<local-command-caveat>` block and followed by `<local-command-stdout>`. For a skill, the
 * CLI then writes a SECOND user message holding the whole expanded instruction text.
 *
 * The terminal TUI hides all of that; the bubble mirror must too. This parses one user text
 * into what should be shown: a command chip, a quiet output note, or nothing.
 */

export type CommandParse =
  | { kind: "command"; name: string; args: string; output?: string }
  | { kind: "output"; text: string }
  | { kind: "bash"; command: string }
  | { kind: "bashOutput"; stdout: string; stderr: string }
  | { kind: "drop" }
  | null; // not command markup: render as a normal message

function tag(name: string, s: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? (m[1] ?? ""): null;
}

/** The CLI escapes shell output before storing it, so `<module>` arrives as `&lt;module&gt;`. */
function decodeEntities(s: string): string {
  return s
.replace(/&lt;/g, "<")
.replace(/&gt;/g, ">")
.replace(/&quot;/g, '"')
.replace(/&#39;/g, "'")
.replace(/&amp;/g, "&"); // last, so a literal "&amp;lt;" survives as "&lt;"
}

/**
 * `!`-prefixed bash mode. The CLI stores it as two consecutive user messages:
 * `<bash-input>ls</bash-input>`, then `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`
 * (either stream may be empty). Same deal as slash commands, the TUI shows a compact pair, so
 * the bubble must not show the tags.
 */
function parseBashText(text: string): CommandParse {
  if (!text.includes("<bash-")) return null;

  const input = tag("bash-input", text);
  if (input !== null) {
    const command = decodeEntities(input.trim());
    return command ? { kind: "bash", command }: { kind: "drop" };
  }

  const rawOut = tag("bash-stdout", text);
  const rawErr = tag("bash-stderr", text);
  if (rawOut === null && rawErr === null) return null;
  const stdout = decodeEntities((rawOut ?? "").trim());
  const stderr = decodeEntities((rawErr ?? "").trim());
  if (!stdout && !stderr) return { kind: "drop" }; // a command that printed nothing
  return { kind: "bashOutput", stdout, stderr };
}

export function parseCommandText(text: string): CommandParse {
  const bash = parseBashText(text);
  if (bash) return bash;
  if (!text.includes("<command-") && !text.includes("<local-command")) return null;

  const name = tag("command-name", text);
  if (name !== null) {
    const args = (tag("command-args", text) ?? "").trim();
    const output = (tag("local-command-stdout", text) ?? "").trim();
    return {
      kind: "command",
      name: name.trim().replace(/^\/*/, "/"),
      args,
...(output ? { output }: {}),
    };
  }

  const out = tag("local-command-stdout", text);
  if (out !== null) {
    const trimmed = out.trim();
    return trimmed ? { kind: "output", text: trimmed }: { kind: "drop" };
  }

  // Caveat-only / message-only wrappers are pure plumbing, the TUI never shows them.
  if (text.includes("<local-command-caveat>") || text.includes("<command-message>")) {
    return { kind: "drop" };
  }
  return null;
}

/**
 * Is this user message the CLI's expansion of the command that came just before it, the
 * full skill/command instruction text replayed as a fake user turn? It always arrives as a
 * text-only content array immediately after the command message, so those two facts (plus a
 * length floor) identify it without guessing at its content.
 */
export function looksLikeExpansion(blocks: unknown[], joined: string): boolean {
  if (blocks.length === 0) return false;
  const allText = blocks.every(
    (b) => b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text",
  );
  return allText && joined.trim().length > 200;
}
