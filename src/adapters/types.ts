import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../types.js";

export interface AdapterSpawnOptions {
  task: string;
  cwd: string;
  mode: "headless" | "headful";
}

export interface AdapterResumeOptions {
  sessionId: string;
  task: string;
  cwd: string;
  mode: "headless" | "headful";
}

export interface AgentAdapter {
  name: string;
  /** Whether this adapter supports resuming a persisted session across invocations. */
  canResume?: boolean;
  spawn(options: AdapterSpawnOptions): ChildProcess;
  /** Spawn a new process that continues an existing session (if supported). */
  resume?(options: AdapterResumeOptions): ChildProcess;
  parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent>;
  sendInput(proc: ChildProcess, message: string): void;
}
