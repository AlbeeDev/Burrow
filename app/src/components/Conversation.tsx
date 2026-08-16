import type { Mode } from "../App";
import { TerminalView } from "./TerminalView";
import { ClaudeView } from "./ClaudeView";

export function Conversation({ project, mode }: { project: string | null; mode: Mode }) {
  // Terminal remounts per project (fresh xterm); Claude persists its conversation
  // across project/mode switches, so it is always mounted and toggled with CSS.
  const projectKey = project ?? "master";
  return (
    <div className="min-h-0 flex-1 p-3 md:p-4">
      {/* Terminal mounts only while shown (xterm needs a real size to fit). */}
      {mode === "terminal" && (
        <div className="h-full">
          <TerminalView key={projectKey} project={project} />
        </div>
      )}
      {/* Claude stays mounted and hidden so its conversation survives a mode toggle;
          keying by project gives each project its own conversation. */}
      <div className={mode === "claude" ? "h-full": "hidden"}>
        <ClaudeView key={projectKey} project={project} />
      </div>
    </div>
  );
}
