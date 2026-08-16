/**
 * The shell command a project's terminal session launches Claude with.
 *
 * `claude -c || claude …` = resume the project's conversation, falling back to a fresh one;
 * `exec bash` leaves a usable shell behind when Claude exits.
 */
export function claudeLaunchCommand(): string {
  const base = "claude --dangerously-skip-permissions";
  return `${base} -c || ${base}; exec bash`;
}
