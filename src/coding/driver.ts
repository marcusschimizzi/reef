// src/coding/driver.ts
//
// The transport seam. A driver owns the subprocess; it does NOT interpret output
// (that's CodingStreamProcessor). PTY transport now; a structured transport can
// implement the same interface later without touching the manager.

export interface StartOpts {
  directory: string;
  /** reef-minted UUID passed to the agent (e.g. claude --session-id). */
  sessionId: string;
  task: string;
  /** Off-transcript orchestration framing (e.g. claude --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Override the agent binary path; defaults to the agent's name on PATH. */
  bin?: string;
}

export interface CodingDriverHandle {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface CodingAgentDriver {
  start(opts: StartOpts): CodingDriverHandle;
}
