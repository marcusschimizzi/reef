import { spawn } from "node:child_process";
import { makeEvent } from "../events.js";
import type { AgentEvent } from "../types.js";
import type { AdapterSpawnOptions, AgentAdapter } from "./types.js";
import { parseJsonLines } from "./jsonl.js";

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  spawn(options: AdapterSpawnOptions) {
    const args = ["-p", options.task, "-y", "--output-format", "stream-json"];
    return spawn("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  }

  async *parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent> {
    yield* parseJsonLines(stream, (payload) => {
      const type = (payload.type ?? "progress") as any;
      return makeEvent(type, "", payload);
    });
  }

  sendInput(proc: any, message: string): void {
    proc.stdin?.write(message + "\n");
  }
}
