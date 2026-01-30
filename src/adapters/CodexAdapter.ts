import { spawn } from "node:child_process";
import { makeEvent } from "../events.js";
import type { AgentEvent } from "../types.js";
import type { AdapterSpawnOptions, AgentAdapter } from "./types.js";
import { parseJsonLines } from "./jsonl.js";

export class CodexAdapter implements AgentAdapter {
  name = "codex";

  spawn(options: AdapterSpawnOptions) {
    const args = ["exec", "--json", "--full-auto", options.task];
    return spawn("codex", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
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
