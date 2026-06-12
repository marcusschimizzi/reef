// src/coding/ptyClaude.ts
//
// The Claude Code PTY transport — the ONLY file that imports node-pty. Spawns the
// real interactive `claude` so usage bills against the Max plan (not the headless
// Agent-SDK credit pool). It just pumps bytes; CodingStreamProcessor interprets them.

import * as pty from "node-pty";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "./driver.js";

/** The `claude` argv for a session. Extracted so it's unit-testable without
 *  spawning a real PTY. `--model` is omitted when unset (Claude Code's default). */
export function claudeArgs(opts: StartOpts): string[] {
  return [
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.settingsPath ? ["--settings", opts.settingsPath] : []),
    ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
    opts.task,
  ];
}

/** The environment for the spawned Claude Code. CRITICAL: strip API-key credentials
 *  so the interactive session authenticates via the **Max plan** (OAuth in ~/.claude),
 *  not an API key — the whole reason for the PTY path is on-plan billing. reef's own
 *  model router commonly sets ANTHROPIC_API_KEY in the daemon env; left in place,
 *  Claude Code detects it, prompts ("use this API key?"), and would bill API credits. */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export class PtyClaudeDriver implements CodingAgentDriver {
  start(opts: StartOpts): CodingDriverHandle {
    const proc = pty.spawn(opts.bin ?? "claude", claudeArgs(opts), {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.directory,
      env: claudeEnv(),
    });
    return {
      onData: (cb) => { proc.onData(cb); },
      onExit: (cb) => { proc.onExit(({ exitCode }) => cb(exitCode)); },
      write: (data) => proc.write(data),
      kill: () => { try { proc.kill(); } catch { /* already dead */ } },
    };
  }
}
