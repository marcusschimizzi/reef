import { spawn } from "node:child_process";
import { makeEvent } from "../events.js";
import type { AgentEvent } from "../types.js";
import type { AdapterResumeOptions, AdapterSpawnOptions, AgentAdapter } from "./types.js";
import { parseJsonLines } from "./jsonl.js";

/**
 * OpenCode adapter.
 *
 * Notes:
 * - OpenCode supports JSON output with `opencode run --format json <prompt>` (JSONL events).
 * - Exact event shapes may evolve; we treat each JSON line as a payload and
 *   map `payload.type` (if present) to event.type.
 */
export class OpenCodeAdapter implements AgentAdapter {
  name = "opencode";
  canResume = true;

  spawn(options: AdapterSpawnOptions) {
    // Typical invocation:
    //   opencode run --format json "task"
    // If you want auto-approve, OpenCode supports non-interactive `-p` mode;
    // we keep flags minimal here.
    const args = ["run", "--format", "json", options.task];
    return spawn("opencode", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  }

  resume(options: AdapterResumeOptions) {
    const args = [
      "run",
      "--format",
      "json",
      "--session",
      options.sessionId,
      options.task
    ];
    return spawn("opencode", args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
  }


  async *parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent> {
    yield* parseJsonLines(stream, (payload) => {
      const type = (payload.type ?? "progress") as any;
      return makeEvent(type, "", payload);
    });
  }

  sendInput(_proc: any, _message: string): void {
    // OpenCode CLI is one-shot; follow-ups use resume() rather than stdin.
  }
}
