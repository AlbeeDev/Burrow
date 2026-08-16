/**
 * Thin wrapper around a pseudo-terminal (PTY).
 *
 * Adapted from OpenClaw's src/process/terminal-pty.ts + src/gateway/terminal/backend.ts
 * (MIT, github.com/openclaw/openclaw). Reduced to the POSIX path Burrow needs, the
 * reference also handles Windows cmd.exe and process-tree teardown, which we don't.
 */

export type PtyHandle = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
};

export async function spawnPty(params: {
  file: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}): Promise<PtyHandle> {
  const { spawn } = await import("@lydell/node-pty");

  const env: Record<string, string> = {
...(process.env as Record<string, string>),
...params.env,
  };
  // An ambient TERM=dumb describes the gateway host, not this real PTY. Passing it
  // through makes interactive CLIs refuse to start. (Same reasoning as the reference.)
  const inheritedTerm = env.TERM?.trim();
  env.TERM =
    !inheritedTerm || inheritedTerm.toLowerCase() === "dumb" ? "xterm-256color": inheritedTerm;

  const pty = spawn(params.file, params.args, {
    name: env.TERM,
    cols: params.cols,
    rows: params.rows,
    cwd: params.cwd,
    env,
  });

  return {
    get pid() {
      return pty.pid;
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    kill: (signal) => {
      try {
        pty.kill(signal);
      } catch {
        // Process may already be gone; teardown is best-effort.
      }
    },
  };
}
