// src/coding/driver.ts
//
// The transport seam. A driver owns the subprocess; it does NOT interpret output
// (that's CodingStreamProcessor). PTY transport now; a structured transport can
// implement the same interface later without touching the manager.

export interface StartOpts {
  directory: string;
  /** reef-minted UUID. New session → `--session-id`; revive (resume) → `--resume`. */
  sessionId: string;
  /** Revive an existing session (`claude --resume <sessionId>`) instead of creating
   *  a new one (`--session-id`). The `task` is the new prompt for the resumed turn. */
  resume?: boolean;
  task: string;
  /** Off-transcript orchestration framing (e.g. claude --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Model for the coding agent (e.g. claude --model haiku). Omitted → the agent's
   *  own default. Lets testing run on a cheap model without burning plan usage. */
  model?: string;
  /** Path to a settings file passed via `claude --settings` — reef-owned (a temp
   *  file), never the user's repo. Carries the handback Stop hook (+ future
   *  pre-auth). Omitted → no `--settings`. */
  settingsPath?: string;
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
