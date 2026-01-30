import type { ChildProcess } from "node:child_process";
import { DEFAULT_STATE_PATH, MAX_COMPLETED } from "../config.js";
import { makeEvent } from "../events.js";
import type { AgentType, Job } from "../types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { FileStore } from "../persistence/fileStore.js";
import { EventStore } from "./EventStore.js";
import { nextId } from "./ids.js";

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
    if (proc.stdout) {
      void this.consumeEvents(job.id, adapter.parseOutput(proc.stdout));
    }
    proc.on("exit", (code) => {
      const status = code === 0 ? "completed" : "error";
      this.completeJob(job.id, status, { exitCode: code });
    });
    return job;
  }

  send(agentId: string, message: string): void {
    const job = this.jobs.get(agentId);
    if (!job) return;
    const adapter = this.adapters.get(job.agent);
    const proc = this.processes.get(agentId);
    if (!adapter || !proc) return;
    adapter.sendInput(proc, message);
    this.clearAwaitingInput(agentId, message);
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
