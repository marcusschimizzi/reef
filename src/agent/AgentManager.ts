import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { DEFAULT_STATE_PATH, MAX_COMPLETED } from "../config.js";
import { makeEvent } from "../events.js";
import type { AgentType, Job } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { FileStore } from "../persistence/fileStore.js";
import { EventStore } from "./EventStore.js";
import { nextId } from "./ids.js";
import { mergeStreams } from "./mergeStreams.js";

export class AgentManager {
  private readonly jobs = new Map<string, Job>();
  private readonly completed: Job[] = [];
  private readonly events = new EventStore();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly store: FileStore;

  constructor(private readonly adapters: AdapterRegistry, store?: FileStore) {
    this.store = store ?? new FileStore(DEFAULT_STATE_PATH);
  }

  createJob(agent: AgentType, mode: "headless" | "headful", task: string, cwd: string): Job {
    const id = nextId();
    const job: Job = {
      id,
      agent,
      mode,
      task,
      cwd,
      status: "running",
      startedAt: new Date().toISOString()
    };
    this.jobs.set(id, job);
    this.events.append(id, makeEvent("started", id, { task, agent }));
    this.saveSnapshot();
    return job;
  }

  listJobs(): Job[] {
    return [...this.jobs.values(), ...this.completed];
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id) ?? this.completed.find((job) => job.id === id);
  }

  getEvents(id: string, since?: string) {
    return this.events.getSince(id, since);
  }

  markAwaitingInput(id: string, question: string, options?: string[]): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "awaiting_input";
    this.events.append(id, makeEvent("needs_input", id, { question, options }));
    this.saveSnapshot();
  }

  clearAwaitingInput(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "running";
    this.events.append(id, makeEvent("input_sent", id, { message }));
    this.saveSnapshot();
  }

  attachProcess(id: string, proc: ChildProcess): void {
    this.processes.set(id, proc);
  }

  async consumeEvents(id: string, iterable: AsyncIterable<any>): Promise<void> {
    for await (const event of iterable) {
      const normalized = {
        ...event,
        agentId: id,
        timestamp: event.timestamp ?? new Date().toISOString()
      };
      // If the underlying agent reports a persistent session id (e.g. Claude Code),
      // capture it on the Job so follow-ups can resume the same context.
      const job = this.jobs.get(id);
      const payload: any = (normalized as any)?.payload ?? {};
      const sessionId = payload.session_id ?? payload.thread_id ?? payload.sessionID ?? payload.sessionId;
      if (job && typeof sessionId === "string" && sessionId.length > 0 && job.sessionId !== sessionId) {
        job.sessionId = sessionId;
        this.saveSnapshot();
      }

      if (normalized.type === "needs_input") {
        this.markAwaitingInput(
          id,
          normalized.payload.question as string,
          normalized.payload.options as string[] | undefined
        );
      } else {
        this.events.append(id, normalized);
        this.saveSnapshot();
      }
    }
  }

  async spawn(agent: AgentType, mode: "headless" | "headful", task: string, cwd: string): Promise<Job> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new Error(`Unknown agent: ${agent}`);
    const job = this.createJob(agent, mode, task, cwd);
    const proc = adapter.spawn({ task, cwd, mode });
    this.attachProcess(job.id, proc);
    const outputStreams = [proc.stdout, proc.stderr].filter(
      (stream): stream is Readable => stream !== null
    );
    if (outputStreams.length > 0) {
      const merged = mergeStreams(outputStreams);
      void this.consumeEvents(job.id, adapter.parseOutput(merged));
    }
    proc.on("exit", (code) => {
      const status = code === 0 ? "completed" : "error";
      this.completeJob(job.id, status, { exitCode: code });
    });
    return job;
  }

  send(agentId: string, message: string): void {
    // Allow sending to both active and recently completed jobs.
    // For resume-capable adapters, a "completed" job can be continued by spawning
    // a new process bound to the same persisted session id.
    const completedIndex = this.completed.findIndex((job) => job.id === agentId);
    const job = this.jobs.get(agentId) ?? (completedIndex >= 0 ? this.completed[completedIndex] : undefined);
    if (!job) return;

    const adapter = this.adapters.get(job.agent);
    if (!adapter) return;

    // If this job is currently in completed history, move it back to active.
    if (completedIndex >= 0) {
      this.completed.splice(completedIndex, 1);
      job.status = "running";
      delete (job as any).completedAt;
      this.jobs.set(agentId, job);
    }

    const proc = this.processes.get(agentId);

    // 1) If there's a live process, use stdin send.
    if (proc) {
      adapter.sendInput(proc, message);
      this.clearAwaitingInput(agentId, message);
      return;
    }

    // 2) If the adapter supports resuming a persisted session (Claude/Codex style),
    // start a new process that continues the same session.
    if (adapter.canResume && adapter.resume && job.sessionId) {
      const resumed = adapter.resume({
        sessionId: job.sessionId,
        task: message,
        cwd: job.cwd,
        mode: job.mode
      });
      this.attachProcess(agentId, resumed);

      const outputStreams = [resumed.stdout, resumed.stderr].filter((s): s is Readable => s !== null);
      if (outputStreams.length > 0) {
        const merged = mergeStreams(outputStreams);
        void this.consumeEvents(agentId, adapter.parseOutput(merged));
      }
      resumed.on("exit", (code) => {
        const status = code === 0 ? "completed" : "error";
        this.completeJob(agentId, status, { exitCode: code });
      });

      // We're continuing the job; mark input sent in our own event log.
      this.clearAwaitingInput(agentId, message);
      return;
    }

    // 3) Otherwise: no-op for now (soft-session replay not implemented yet).
  }

  kill(agentId: string): void {
    const proc = this.processes.get(agentId);
    if (proc) proc.kill();
    this.completeJob(agentId, "completed", { reason: "killed" });
  }

  async loadSnapshot(): Promise<void> {
    const snapshot = await this.store.load();
    if (!snapshot) return;
    for (const job of snapshot.jobs) {
      this.jobs.set(job.id, { ...job, status: "stale" });
    }
    for (const job of snapshot.completed) {
      this.completed.push(job);
    }
    for (const [id, events] of Object.entries(snapshot.eventTails)) {
      for (const event of events) this.events.append(id, event);
    }
  }

  private saveSnapshot(): void {
    void this.store.save({
      jobs: [...this.jobs.values()],
      completed: this.completed.slice(0, MAX_COMPLETED),
      eventTails: this.events.snapshot()
    });
  }

  completeJob(id: string, status: "completed" | "error", payload: Record<string, unknown>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    job.completedAt = new Date().toISOString();
    this.events.append(id, makeEvent(status, id, payload));
    this.jobs.delete(id);
    this.completed.unshift(job);
    if (this.completed.length > MAX_COMPLETED) this.completed.pop();
    this.processes.delete(id);
    this.saveSnapshot();
  }
}
