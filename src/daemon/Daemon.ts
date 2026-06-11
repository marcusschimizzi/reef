import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newRunId, newTriggerId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type {
  Action,
  AgentRecord,
  Approval,
  ApprovalStatus,
  CatchUpPolicy,
  Run,
  RunSource,
  RunStatus,
  SessionSummary,
  Trigger,
  TriggerOrigin,
  TriggerSpec,
  TriggerType,
} from "../core/types.js";
import { Spine } from "../db/spine.js";
import { BoundFs } from "../fs/capability.js";
import { runAgentLoop, type LoopOptions } from "../loop/AgentLoop.js";
import { assertValidSpec, nextFireTime } from "../triggers/schedule.js";
import { DaemonScheduler, triggerSessionKey } from "../triggers/capability.js";
import { DefaultGate, type ProactiveGate } from "../triggers/gate.js";
import { DefaultPolicy, type ApprovalPolicy } from "../policy/policy.js";
import { DaemonIntrospection } from "../introspect/capability.js";
import { Scheduler, DEFAULT_TICK_MS } from "./Scheduler.js";
import { VercelRouter, type ModelRouter } from "../model/router.js";
import type { MemoryStore } from "../memory/seam.js";
import type { ReefEvent } from "../protocol/events.js";
import type { ApprovalNotification, Surface } from "../surfaces/index.js";
import { SqliteMemory } from "../memory/sqlite.js";
import { builtinTools } from "../tools/builtins.js";
import { fileTools } from "../tools/files.js";
import { shellTools } from "../tools/shell.js";
import { memoryTools } from "../tools/memory.js";
import { scheduleTools } from "../tools/schedule.js";
import { introspectTools } from "../tools/introspect.js";
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
  /** Proactive gate governing heartbeat fires; defaults to idle-only (DefaultGate). */
  gate?: ProactiveGate;
  /** Approval policy for tool calls; defaults to the behavior-preserving DefaultPolicy. */
  policy?: ApprovalPolicy;
  /** Outbound surfaces for routing proactive approval requests (Phase: approval-routing). */
  surfaces?: Surface[];
  /** Seconds before a routed proactive approval auto-denies (default 3600). */
  proactiveApprovalTimeoutSeconds?: number;
}

/** Default self-maintenance instruction for a heartbeat trigger (Phase 4b). */
const DEFAULT_HEARTBEAT_PROMPT =
  "This is an automatic self-maintenance check, not a message from the user. " +
  "Quietly review anything notable from recent activity: record durable facts " +
  "worth keeping with record_memory, and correct or tidy existing memories if " +
  "needed. Only surface something to the user if it is genuinely important or " +
  "time-sensitive. If nothing needs attention, finish without taking action.";

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
  private readonly gate: ProactiveGate;
  private readonly policy: ApprovalPolicy;
  private readonly surfaces: Surface[];
  private readonly approvalTimeoutMs: number;
  /** Per-run metadata captured from run.started, for routing decisions. */
  private readonly runMeta = new Map<string, { proactive: boolean; agentId: string }>();
  /** Abort handles for in-flight runs, keyed by session — powers cancellation. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(opts: DaemonOptions) {
    this.spine = new Spine(opts.dbPath);
    this.sink = new EventSink(this.spine);
    this.router = opts.router ?? new VercelRouter();
    this.workspaceDir = opts.workspaceDir;
    this.maxSteps = opts.maxSteps ?? 20;
    this.scheduler = new Scheduler(() => this.tick(), opts.tickMs ?? DEFAULT_TICK_MS);
    this.gate = opts.gate ?? new DefaultGate();
    this.policy = opts.policy ?? new DefaultPolicy();
    this.surfaces = opts.surfaces ?? [];
    this.approvalTimeoutMs = (opts.proactiveApprovalTimeoutSeconds ?? 3600) * 1000;
    // Default memory: the SQLite/FTS5 store sharing the spine's connection,
    // scoped per agent so agents never see each other's memory.
    this.memoryFactory =
      opts.memory ?? ((agentId) => new SqliteMemory(this.spine.connection, agentId));
    this.tools = new ToolRegistry();
    for (const tool of [
      ...builtinTools,
      ...fileTools,
      ...shellTools,
      ...memoryTools,
      ...scheduleTools,
      ...introspectTools,
    ]) {
      this.tools.register(tool);
    }
    this.inbox = new Inbox<Job>((job) => this.processJob(job));
    // Watch our own event stream to route proactive approval requests out to
    // surfaces (and arm their auto-deny deadline). Inert unless a proactive run
    // actually suspends for approval — which only happens when routing is on.
    this.sink.subscribe((event) => this.onSinkEvent(event));
  }

  // ── proactive approval routing ──────────────────────────────────────────────
  private onSinkEvent(event: ReefEvent): void {
    if (event.type === "run.started") {
      this.runMeta.set(event.runId, {
        proactive: event.source?.kind === "trigger",
        agentId: event.agentId,
      });
    } else if (event.type === "run.completed" || event.type === "run.failed") {
      this.runMeta.delete(event.runId);
    } else if (event.type === "approval.requested") {
      const meta = this.runMeta.get(event.runId);
      if (meta?.proactive) this.routeApproval(event, meta.agentId);
    }
  }

  /** Arm the auto-deny deadline and fan the request out to surfaces (best-effort). */
  private routeApproval(
    event: Extract<ReefEvent, { type: "approval.requested" }>,
    agentId: string,
  ): void {
    this.spine.setApprovalExpiry(
      event.approvalId,
      new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
    );
    const note: ApprovalNotification = {
      kind: "approval",
      approvalId: event.approvalId,
      runId: event.runId,
      sessionKey: event.sessionKey,
      agentId,
      action: event.action,
      detail: event.detail,
    };
    for (const surface of this.surfaces) void surface.notify(note);
  }

  /** Auto-deny routed proactive approvals whose deadline has passed (no one
   *  answered) — the run then resumes and completes rather than hanging. */
  sweepExpiredApprovals(now: Date = new Date()): void {
    for (const approval of this.spine.getExpiredApprovals(now.toISOString())) {
      this.resolveApproval(approval.id, "deny");
    }
  }

  /** The scheduler's periodic work: fire due triggers, then expire stale approvals. */
  private async tick(): Promise<void> {
    await this.tickTriggers();
    this.sweepExpiredApprovals();
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
    /** Provenance (Phase 4c). Operator-created by default; the self-scheduling
     *  capability is the only path that writes "agent". */
    createdBy?: TriggerOrigin;
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
      sessionKey: triggerSessionKey(input.agentId, id),
      createdBy: input.createdBy ?? "operator",
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

  // ── sessions & runs (observability / the sessions view) ─────────────────────
  /** Every session as a list-view summary, most recently active first. */
  listSessions(): SessionSummary[] {
    return this.spine.listSessions();
  }

  /** A session's full native event log — replayed to rebuild its transcript. */
  getHistory(sessionKey: string): ReefEvent[] {
    return this.spine.getEventsSince(sessionKey, 0);
  }

  /**
   * Retarget a session to a different model (the TUI `/model`). Validates the id
   * resolves through the router first — so an unknown/unconfigured provider
   * fails loudly here, not with a 401 mid-run — then persists it and emits
   * `session.model.changed` so consumers update live. Applies to the session's
   * NEXT run; an in-flight run already chose its model at start. Returns an error
   * message, or null on success.
   */
  setSessionModel(sessionKey: string, agentId: string, model: string): string | null {
    try {
      this.router.assertResolvable?.(model); // offline check — surfaces unknown/misconfigured providers
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    this.spine.setSessionModel(sessionKey, agentId, model);
    this.sink.emit({ type: "session.model.changed", sessionKey, runId: "", model });
    return null;
  }

  /** Recent runs, optionally filtered by status (most recent first). */
  listRuns(opts: { status?: RunStatus; limit?: number } = {}): Run[] {
    return this.spine.listRuns(opts);
  }

  /** The recorded-authority audit log — recent tool actions, newest first. */
  listActions(opts: { runId?: string; agentId?: string; limit?: number } = {}): Action[] {
    return this.spine.listActions(opts);
  }

  /**
   * Runs parked awaiting approval, each with its still-pending approvals — the
   * data behind a "needs approval" view in conch / the TUI. Proactive runs no
   * longer land here (they auto-deny), so in practice these are interactive runs
   * whose approver hasn't answered yet.
   */
  runsAwaitingApproval(): Array<{ run: Run; approvals: Approval[] }> {
    return this.spine
      .listRuns({ status: "suspended" })
      .filter((r) => r.stopReason === "awaiting_approval")
      .map((run) => ({
        run,
        approvals: this.spine.getApprovalsForRun(run.id).filter((a) => a.status === "pending"),
      }));
  }

  /**
   * Find-or-create the agent's self-maintenance heartbeat (Phase 4b) — one per
   * agent, idempotent across restarts. Heartbeats use `skip` catch-up (a missed
   * one shouldn't fire a burst on restart) and yield to the proactive gate.
   */
  ensureHeartbeat(input: {
    agentId: string;
    intervalSeconds: number;
    input?: string;
  }): Trigger {
    const existing = this.spine
      .listTriggers(input.agentId)
      .find((t) => t.type === "heartbeat");
    if (existing) return existing;
    return this.createTrigger({
      agentId: input.agentId,
      type: "heartbeat",
      spec: { kind: "interval", seconds: input.intervalSeconds },
      input: input.input ?? DEFAULT_HEARTBEAT_PROMPT,
      catchUpPolicy: "skip",
    });
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
      let fire = true;

      // A due fire much older than now was missed during downtime; `skip` drops it.
      const dueMs = t.nextFireAt ? Date.parse(t.nextFireAt) : nowMs;
      if (nowMs - dueMs > MISSED_GRACE_MS && t.catchUpPolicy === "skip") fire = false;

      // Opportunistic self-maintenance yields to the proactive gate (e.g. when busy).
      if (fire && t.type === "heartbeat") {
        const decision = await this.gate.check({
          now,
          busy: this.aborters.size > 0,
          trigger: t,
        });
        if (!decision.allow) fire = false;
      }

      // Always advance the schedule; only stamp lastFiredAt on an actual fire.
      this.spine.updateTriggerSchedule(t.id, {
        nextFireAt: nextFireTime(t.spec, now)?.toISOString(),
        lastFiredAt: fire ? now.toISOString() : t.lastFiredAt,
      });

      if (fire) await this.inbox.enqueue({ kind: "trigger", triggerId: t.id });
    }
  }

  private async processJob(job: Job): Promise<void> {
    if (job.kind === "message") return this.processWake(job.wake);
    if (job.kind === "trigger") return this.processTrigger(job.triggerId);
    return this.resumeRun(job.runId);
  }

  private async processWake(wake: Wake): Promise<void> {
    // Snapshot the current default model onto a new session so it sticks.
    this.spine.ensureSession(wake.sessionKey, wake.agentId, this.spine.getAgent(wake.agentId)?.model);
    this.spine.appendMessage(wake.sessionKey, "user", [
      { type: "text", text: wake.message },
    ]);
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: wake.agentId,
      sessionKey: wake.sessionKey,
    });
    this.sink.emit({
      type: "message.received",
      text: wake.message,
      sessionKey: wake.sessionKey,
      runId: run.id,
    });
    await this.runLoop(run);
  }

  /** A trigger fired: seed its configured instruction as the wake and run, on
   *  the trigger's stable session, tagged as a proactive run. */
  private async processTrigger(triggerId: string): Promise<void> {
    const trigger = this.spine.getTrigger(triggerId);
    if (!trigger || !trigger.enabled) return;
    this.spine.ensureSession(
      trigger.sessionKey,
      trigger.agentId,
      this.spine.getAgent(trigger.agentId)?.model,
    );
    this.spine.appendMessage(trigger.sessionKey, "user", [
      { type: "text", text: trigger.input },
    ]);
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: trigger.agentId,
      sessionKey: trigger.sessionKey,
    });
    const source: RunSource = {
      kind: "trigger",
      triggerId: trigger.id,
      triggerType: trigger.type,
    };
    this.sink.emit({
      type: "message.received",
      text: trigger.input,
      source,
      sessionKey: trigger.sessionKey,
      runId: run.id,
    });
    await this.runLoop(run, { source });
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
    // The session's pinned model (snapshot at creation) overrides the agent
    // default, so a session keeps its model across global config changes.
    const model = this.spine.getSessionModel(run.sessionKey) ?? agent.model;
    const agentForRun = model === agent.model ? agent : { ...agent, model };
    const root = join(this.workspaceDir, agent.id);
    await mkdir(root, { recursive: true });
    const aborter = new AbortController();
    this.aborters.set(run.sessionKey, aborter);
    try {
      await runAgentLoop(
        run,
        agentForRun,
        {
          spine: this.spine,
          router: this.router,
          tools: this.tools,
          policy: this.policy,
          toolContext: {
            fs: new BoundFs(root),
            workspaceRoot: root,
            model,
            memory: this.memoryFor(agent.id),
            scheduler: new DaemonScheduler(this.spine, agent.id),
            introspection: new DaemonIntrospection(this.spine, agent.id),
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
