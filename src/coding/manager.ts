// src/coding/manager.ts
//
// Wires a coding-agent driver to reef's substrate: mints ids, records the trace,
// emits coding.* events, and tracks status in coding_sessions. Step 1 routes a
// detected prompt to status `awaiting_decision` and leaves answering to the
// operator via send() (policy-driven auto-answer is a later step). Driver is
// injected so the whole thing is unit-testable without a real PTY.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Spine } from "../db/spine.js";
import type { EmitFn } from "../protocol/events.js";
import { CodingStreamProcessor, type DriverEvent } from "./processor.js";
import type { CodingAgentDriver, CodingDriverHandle } from "./driver.js";
import { TraceWriter } from "./trace.js";

export interface CodingSessionManagerDeps {
  spine: Spine;
  emit: EmitFn;
  driver: CodingAgentDriver;
  traceDir: string;
  appendSystemPrompt?: string;
}

export interface StartCodingSession {
  agentKind: string;
  directory: string;
  task: string;
  spawningRunId?: string | null;
}

interface Live {
  handle: CodingDriverHandle;
  processor: CodingStreamProcessor;
  trace: TraceWriter;
}

export class CodingSessionManager {
  private readonly live = new Map<string, Live>();
  /** Sessions whose exit was requested — so the exit handler records `cancelled`
   *  rather than `failed` (a kill exits the PTY with a non-zero code). */
  private readonly cancelling = new Set<string>();
  constructor(private readonly deps: CodingSessionManagerDeps) {}

  start(opts: StartCodingSession): string {
    const externalSessionId = randomUUID();
    const id = `cs_${externalSessionId}`;
    const tracePath = join(this.deps.traceDir, `${id}.jsonl`);

    this.deps.spine.createCodingSession({
      id,
      spawningRunId: opts.spawningRunId ?? null,
      agentKind: opts.agentKind,
      externalSessionId,
      directory: opts.directory,
      status: "running",
      task: opts.task,
      tracePath,
    });

    const trace = new TraceWriter(tracePath);
    trace.write({ type: "lifecycle", event: "spawn" });
    const processor = new CodingStreamProcessor();
    const handle = this.deps.driver.start({
      directory: opts.directory,
      sessionId: externalSessionId,
      task: opts.task,
      appendSystemPrompt: this.deps.appendSystemPrompt,
    });
    this.live.set(id, { handle, processor, trace });

    this.emitCoding(id, { type: "coding.session.started", codingSessionId: id, agentKind: opts.agentKind, directory: opts.directory });

    handle.onData((chunk) => {
      trace.write({ type: "pty.raw", bytes: Buffer.from(chunk, "utf8").toString("base64") });
      for (const ev of processor.push(chunk)) this.onDriverEvent(id, ev);
    });
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
      // A requested cancel exits non-zero (the kill) — record it as cancelled,
      // not failed. `delete` both checks membership and consumes the flag.
      const cancelled = this.cancelling.delete(id);
      const status = cancelled ? "cancelled" : code === 0 || code === null ? "completed" : "failed";
      this.deps.spine.setCodingSessionStatus(id, status);
      if (status === "failed") {
        this.emitCoding(id, { type: "coding.session.failed", codingSessionId: id, error: `exited with code ${code}` });
      } else {
        this.emitCoding(id, { type: "coding.session.completed", codingSessionId: id });
      }
      trace.close();
      this.live.delete(id);
    });

    return id;
  }

  /** Inject raw keystrokes (operator answering a prompt by hand in Step 1). */
  send(id: string, data: string): void {
    const l = this.live.get(id);
    if (!l) return;
    l.trace.write({ type: "inject", data, reason: "operator" });
    l.handle.write(data);
  }

  cancel(id: string): void {
    if (!this.live.has(id)) return;
    this.cancelling.add(id);
    this.live.get(id)!.handle.kill();
  }

  /** Shut down: kill every live session, mark it cancelled, and close its trace.
   *  Called on daemon shutdown so no PTY or trace fd is leaked. Idempotent trace
   *  close means the async exit handler firing afterward is harmless. */
  close(): void {
    for (const [id, l] of this.live) {
      this.cancelling.add(id);
      this.deps.spine.setCodingSessionStatus(id, "cancelled");
      l.handle.kill();
      l.trace.close();
    }
    this.live.clear();
  }

  private onDriverEvent(id: string, ev: DriverEvent): void {
    const l = this.live.get(id);
    l?.trace.write({ type: "event", event: ev });
    if (ev.type === "output") {
      this.emitCoding(id, { type: "coding.output", codingSessionId: id, text: ev.text });
    } else if (ev.type === "prompt-pending") {
      this.deps.spine.setCodingSessionStatus(id, "awaiting_decision");
      this.emitCoding(id, { type: "coding.prompt.detected", codingSessionId: id, promptText: ev.promptText, options: ev.options });
    }
  }

  private emitCoding(id: string, body: { type: string } & Record<string, unknown>): void {
    this.deps.emit({ ...body, sessionKey: `coding:${id}`, runId: "" } as Parameters<EmitFn>[0]);
  }
}
