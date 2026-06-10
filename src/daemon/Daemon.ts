import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newRunId, newTriggerId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type {
  AgentRecord,
  ApprovalStatus,
  CatchUpPolicy,
  Run,
  RunSource,
  Trigger,
  TriggerSpec,
  TriggerType,
} from "../core/types.js";
import { Spine } from "../db/spine.js";
import { BoundFs } from "../fs/capability.js";
import { runAgentLoop, type LoopOptions } from "../loop/AgentLoop.js";
import { assertValidSpec, nextFireTime } from "../triggers/schedule.js";
import { Scheduler, DEFAULT_TICK_MS } from "./Scheduler.js";
import { VercelRouter, type ModelRouter } from "../model/router.js";
import type { MemoryStore } from "../memory/seam.js";
import { SqliteMemory } from "../memory/sqlite.js";
import { builtinTools } from "../tools/builtins.js";
import { fileTools } from "../tools/files.js";
import { shellTools } from "../tools/shell.js";
import { memoryTools } from "../tools/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { EventSink } from "./sink.js";
import { Inbox } from "./inbox.js";

/** How the daemon obtains an agent's memory store — swap this to plug in a
 *  different backend (e.g. a hybrid semantic store) behind the same seam. */
export type MemoryFactory = (agentId: string) => MemoryStore;

export interface DaemonOptions {
  dbPath: string;
  workspaceDir: string;
  /** Injectable for tests; defaults to the real provider-routing layer. */
  router?: ModelRouter;
  maxSteps?: number;
  /** Memory backend factory; defaults to the SQLite/FTS5 store on the spine db. */
  memory?: MemoryFactory;
  /** Scheduler tick cadence in ms (how often due triggers are reconciled). */
  tickMs?: number;
}

interface Wake {
  sessionKey: string;
  agentId: string;
  message: string;
}

// A due fire older than this was almost certainly missed during downtime (the
// scheduler would otherwise catch it within a tick). The `skip` catch-up policy
// drops such fires; `fire_once` runs them anyway.
const MISSED_GRACE_MS = 90_000;

// Everything the agent might wake for funnels into one serial inbox: a user
// message, a resume after an approval resolved, or a trigger firing (reef-docs/05
// — one queue, the "dispatch as shape" seam Phase 4 cashes in).
type Job =
  | { kind: "message"; wake: Wake }
  | { kind: "resume"; runId: string }
  | { kind: "trigger"; triggerId: string };

/**
 * The always-on agent runtime. Owns the spine (state), the router (model), the
 * tool registry, and the event sink. Wakes enter the inbox and are worked one
 * at a time through the one agent loop. The database is the source of truth;
 * the daemon advances it and rebuilds from it on restart.
 */
export class Daemon {
  readonly spine: Spine;
  readonly sink: EventSink;
  private readonly router: ModelRouter;
  private readonly tools: ToolRegistry;
  private readonly inbox: Inbox<Job>;
  private readonly workspaceDir: string;
  private readonly maxSteps: number;
  private readonly memoryFactory: MemoryFactory;
  /** One memory store per agent, built lazily and reused across that agent's runs. */
  private readonly memories = new Map<string, MemoryStore>();
  private readonly scheduler: Scheduler;
  /** Abort handles for in-flight runs, keyed by session — powers cancellation. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(opts: DaemonOptions) {
    this.spine = new Spine(opts.dbPath);
    this.sink = new EventSink(this.spine);
    this.router = opts.router ?? new VercelRouter();
    this.workspaceDir = opts.workspaceDir;
    this.maxSteps = opts.maxSteps ?? 20;
    this.scheduler = new Scheduler(() => this.tickTriggers(), opts.tickMs ?? DEFAULT_TICK_MS);
    // Default memory: the SQLite/FTS5 store sharing the spine's connection,
    // scoped per agent so agents never see each other's memory.
    this.memoryFactory =
      opts.memory ?? ((agentId) => new SqliteMemory(this.spine.connection, agentId));
    this.tools = new ToolRegistry();
    for (const tool of [...builtinTools, ...fileTools, ...shellTools, ...memoryTools]) {
      this.tools.register(tool);
    }
    this.inbox = new Inbox<Job>((job) => this.processJob(job));
  }

  /** The agent's memory store, built on first use and cached for reuse. */
  private memoryFor(agentId: string): MemoryStore {
    let store = this.memories.get(agentId);
    if (!store) {
      store = this.memoryFactory(agentId);
      this.memories.set(agentId, store);
    }
    return store;
  }

  registerAgent(agent: AgentRecord): void {
    this.spine.upsertAgent(agent);
  }

  subscribe(fn: Parameters<EventSink["subscribe"]>[0]): () => void {
    return this.sink.subscribe(fn);
  }

  /** Enqueue a user-message wake; resolves when its run terminates or suspends. */
  submit(wake: Wake): Promise<void> {
    return this.inbox.enqueue({ kind: "message", wake });
  }

  /**
   * Resolve a pending tool approval. Records the decision durably; once every
   * approval for the run's suspended turn is decided, re-drives the run (through
   * the same serial inbox) to execute the decided tools and continue.
   */
  resolveApproval(approvalId: string, decision: string): boolean {
    const approval = this.spine.getApproval(approvalId);
    if (!approval || approval.status !== "pending") return false;
    const status: ApprovalStatus = decision === "deny" ? "denied" : "allowed";
    this.spine.resolveApproval(approvalId, status, decision);
    this.sink.emit({
      type: "approval.resolved",
      sessionKey: approval.sessionKey,
      runId: approval.runId,
      approvalId,
      decision:
        decision === "allow-always" ? "allow-always" : decision === "deny" ? "deny" : "allow-once",
    });
    if (this.spine.pendingApprovalCount(approval.runId) === 0) {
      void this.inbox.enqueue({ kind: "resume", runId: approval.runId });
    }
    return true;
  }

  /**
   * Startup recovery (reef-docs/04): re-drive every run left mid-flight by a
   * crash. Suspended runs (awaiting approval) are intentionally parked and not
   * returned here — they resume only when their approvals resolve.
   */
  async recover(): Promise<void> {
    for (const run of this.spine.getInterruptedRuns()) {
      await this.runLoop(run);
    }
  }

  /** Cancel the in-flight run for a session (reef-docs/03 cancellation). */
  cancel(sessionKey: string): boolean {
    const aborter = this.aborters.get(sessionKey);
    if (!aborter) return false;
    aborter.abort();
    return true;
  }

  /** Begin firing triggers on the scheduler's cadence. Call after recover(). */
  start(): void {
    this.scheduler.start();
  }

  close(): void {
    this.scheduler.stop();
    this.spine.close();
  }

  // ── triggers (Phase 4a) ─────────────────────────────────────────────────────
  /** Create a durable trigger and schedule its first fire. */
  createTrigger(input: {
    agentId: string;
    type?: TriggerType;
    spec: TriggerSpec;
    input: string;
    catchUpPolicy?: CatchUpPolicy;
    enabled?: boolean;
  }): Trigger {
    assertValidSpec(input.spec);
    const id = newTriggerId();
    const enabled = input.enabled ?? true;
    const trigger: Trigger = {
      id,
      agentId: input.agentId,
      type: input.type ?? "schedule",
      spec: input.spec,
      input: input.input,
      // Stable per-trigger session: a recurring routine is one ongoing thread.
      sessionKey: `reef:${input.agentId}:trigger-${id}`,
      enabled,
      catchUpPolicy: input.catchUpPolicy ?? "fire_once",
      nextFireAt: enabled ? nextFireTime(input.spec, new Date())?.toISOString() : undefined,
      createdAt: nowIso(),
    };
    this.spine.createTrigger(trigger);
    return trigger;
  }

  listTriggers(agentId?: string): Trigger[] {
    return this.spine.listTriggers(agentId);
  }

  setTriggerEnabled(id: string, enabled: boolean): boolean {
    const t = this.spine.getTrigger(id);
    if (!t) return false;
    // Re-enabling computes a fresh next fire; disabling clears it.
    this.spine.setTriggerEnabled(id, enabled);
    this.spine.updateTriggerSchedule(id, {
      nextFireAt: enabled ? nextFireTime(t.spec, new Date())?.toISOString() : undefined,
      lastFiredAt: t.lastFiredAt,
    });
    return true;
  }

  /**
   * Reconcile due triggers (driven by the Scheduler, or directly in tests). For
   * each due trigger: advance its next fire first (so a slow run can't double-
   * fire it), then either enqueue a wake or, under `skip`, drop a fire that was
   * missed while the daemon was down. `fire_once` (default) always runs the
   * single overdue occurrence.
   */
  async tickTriggers(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    for (const t of this.spine.getDueTriggers(now.toISOString())) {
      const next = nextFireTime(t.spec, now);
      this.spine.updateTriggerSchedule(t.id, {
        nextFireAt: next?.toISOString(),
        lastFiredAt: now.toISOString(),
      });

      const dueMs = t.nextFireAt ? Date.parse(t.nextFireAt) : nowMs;
      const missed = nowMs - dueMs > MISSED_GRACE_MS;
      if (missed && t.catchUpPolicy === "skip") continue; // drop the missed fire

      await this.inbox.enqueue({ kind: "trigger", triggerId: t.id });
    }
  }

  private async processJob(job: Job): Promise<void> {
    if (job.kind === "message") return this.processWake(job.wake);
    if (job.kind === "trigger") return this.processTrigger(job.triggerId);
    return this.resumeRun(job.runId);
  }

  private async processWake(wake: Wake): Promise<void> {
    this.spine.ensureSession(wake.sessionKey, wake.agentId);
    this.spine.appendMessage(wake.sessionKey, "user", [
      { type: "text", text: wake.message },
    ]);
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: wake.agentId,
      sessionKey: wake.sessionKey,
    });
    await this.runLoop(run);
  }

  /** A trigger fired: seed its configured instruction as the wake and run, on
   *  the trigger's stable session, tagged as a proactive run. */
  private async processTrigger(triggerId: string): Promise<void> {
    const trigger = this.spine.getTrigger(triggerId);
    if (!trigger || !trigger.enabled) return;
    this.spine.ensureSession(trigger.sessionKey, trigger.agentId);
    this.spine.appendMessage(trigger.sessionKey, "user", [
      { type: "text", text: trigger.input },
    ]);
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: trigger.agentId,
      sessionKey: trigger.sessionKey,
    });
    await this.runLoop(run, {
      source: { kind: "trigger", triggerId: trigger.id, triggerType: trigger.type },
    });
  }

  private async resumeRun(runId: string): Promise<void> {
    const run = this.spine.getRun(runId);
    if (!run) return;
    this.spine.setRunStatus(runId, "running");
    await this.runLoop({ ...run, status: "running" }, { resumeApproval: true });
  }

  private async runLoop(run: Run, options: LoopOptions = {}): Promise<void> {
    const agent = this.spine.getAgent(run.agentId);
    if (!agent) {
      this.spine.setRunStatus(run.id, "failed", {
        stopReason: "error",
        endedAt: nowIso(),
      });
      return;
    }
    const root = join(this.workspaceDir, agent.id);
    await mkdir(root, { recursive: true });
    const aborter = new AbortController();
    this.aborters.set(run.sessionKey, aborter);
    try {
      await runAgentLoop(
        run,
        agent,
        {
          spine: this.spine,
          router: this.router,
          tools: this.tools,
          toolContext: {
            fs: new BoundFs(root),
            workspaceRoot: root,
            memory: this.memoryFor(agent.id),
            signal: aborter.signal,
          },
          emit: this.sink.emit,
          maxSteps: this.maxSteps,
        },
        options,
      );
    } finally {
      this.aborters.delete(run.sessionKey);
    }
  }
}
