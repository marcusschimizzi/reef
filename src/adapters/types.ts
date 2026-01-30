import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../types.js";

export interface AdapterSpawnOptions {
  task: string;
  cwd: string;
  mode: "headless" | "headful";
}

export interface AgentAdapter {
  name: string;
  spawn(options: AdapterSpawnOptions): ChildProcess;
  parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent>;
  sendInput(proc: ChildProcess, message: string): void;
}
