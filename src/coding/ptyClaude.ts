// src/coding/ptyClaude.ts
//
// The Claude Code PTY transport — the ONLY file that imports node-pty. Spawns the
// real interactive `claude` so usage bills against the Max plan (not the headless
// Agent-SDK credit pool). It just pumps bytes; CodingStreamProcessor interprets them.

import * as pty from "node-pty";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "./driver.js";

export class PtyClaudeDriver implements CodingAgentDriver {
  start(opts: StartOpts): CodingDriverHandle {
    const args = [
      "--session-id", opts.sessionId,
      ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
      opts.task,
    ];
    const proc = pty.spawn(opts.bin ?? "claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.directory,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    return {
      onData: (cb) => { proc.onData(cb); },
      onExit: (cb) => { proc.onExit(({ exitCode }) => cb(exitCode)); },
      write: (data) => proc.write(data),
      kill: () => { try { proc.kill(); } catch { /* already dead */ } },
    };
  }
}
