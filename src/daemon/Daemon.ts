import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newRunId, newTriggerId } from "../core/ids.js";
import { CodingSessionManager } from "../coding/manager.js";
import { PtyClaudeDriver } from "../coding/ptyClaude.js";
import type { CodingAgentDriver } from "../coding/driver.js";
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
  WatchEvent,
  WatchEventKind,
} from "../core/types.js";
import { Spine } from "../db/spine.js";
import { BoundFs } from "../fs/capability.js";
import { runAgentLoop, type LoopOptions } from "../loop/AgentLoop.js";
import { assertValidSpec, nextFireTime } from "../triggers/schedule.js";
import { DaemonScheduler, triggerSessionKey } from "../triggers/capability.js";
import { FileWatcher, type WatchFactory } from "../triggers/watcher.js";
import { DefaultGate, type ProactiveGate } from "../triggers/gate.js";
import { DefaultPolicy, type ApprovalPolicy } from "../policy/policy.js";
import { DaemonIntrospection } from "../introspect/capability.js";
import { Scheduler, DEFAULT_TICK_MS } from "./Scheduler.js";
import { VercelRouter, type ModelRouter } from "../model/router.js";
import type { MemoryStore } from "../memory/seam.js";
import type { ReefEvent } from "../protocol/events.js";
import { parseApprovalDecision } from "../protocol/events.js";
import type { ApprovalNotification, Surface } from "../surfaces/index.js";
import { SqliteMemory } from "../memory/sqlite.js";
import { builtinTools } from "../tools/builtins.js";
import { fileTools } from "../tools/files.js";
import { shellTools } from "../tools/shell.js";
import { memoryTools } from "../tools/memory.js";
import { scheduleTools } from "../tools/schedule.js";
import { introspectTools } from "../tools/introspect.js";
import { codingTools, startCodingSession, sendFeedback } from "../tools/coding.js";
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
  /** Injectable fs-watch factory for file-watch triggers (Phase 4d); defaults to node:fs watch. */
  watchFactory?: WatchFactory;
  /** Coding-agent transport; defaults to the node-pty Claude driver. Injectable for tests. */
  codingDriver?: CodingAgentDriver;
  /** Directory for coding-session flight-recorder traces; defaults to <workspaceDir>/../coding-sessions. */
  codingTraceDir?: string;
  /** Injectable handback-file watcher for the coding manager (tests trigger handback deterministically). */
  codingWatchHandbackFile?: (file: string, onSignal: () => void) => () => void;
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

// Coding-session statuses that are terminal from the spawning run's point of view:
// the run can collect a result and continue. `paused` = handed back (resumable);
// `process_lost` = the PTY died (crash) — a resumable failure. The non-terminal ones
// (running, awaiting_decision) mean the increment is still in flight.
const TERMINAL_CODING_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "paused",
  "process_lost",
]);

// Everything the agent might wake for funnels into one serial inbox: a user
// message, a resume after an approval resolved, or a trigger firing (reef-docs/05
// — one queue, the "dispatch as shape" seam Phase 4 cashes in).
type Job =
  | { kind: "message"; wake: Wake }
  | { kind: "resume"; runId: string }
  // `event` is set when a file-watch trigger fired (Phase 4d) — the change to
  // thread into the wake; absent for time-driven (schedule/heartbeat) fires.
  | { kind: "trigger"; triggerId: string; event?: WatchEvent };

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
  /** Event-driven driver for file-watch triggers (Phase 4d) — the fs counterpart
   *  to the time scheduler; both feed the same trigger inbox job. */
  private readonly watcher: FileWatcher;
  private readonly gate: ProactiveGate;
  private readonly policy: ApprovalPolicy;
  private readonly surfaces: Surface[];
  private readonly approvalTimeoutMs: number;
  /** Per-run metadata captured from run.started, for routing decisions. */
  private readonly runMeta = new Map<string, { proactive: boolean; agentId: string }>();
  /** Abort handles for in-flight runs, keyed by session — powers cancellation. */
  private readonly aborters = new Map<string, AbortController>();
  private readonly coding: CodingSessionManager;

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
      ...codingTools,
    ]) {
      this.tools.register(tool);
    }
    this.inbox = new Inbox<Job>((job) => this.processJob(job));
    // File-watch triggers (Phase 4d): on a change, enqueue the same trigger job
    // the time scheduler would — so a reaction runs through processTrigger.
    this.watcher = new FileWatcher(
      (triggerId, event) => void this.inbox.enqueue({ kind: "trigger", triggerId, event }),
      opts.watchFactory,
    );
    this.coding = new CodingSessionManager({
      spine: this.spine,
      emit: this.sink.emit,
      driver: opts.codingDriver ?? new PtyClaudeDriver(),
      traceDir: opts.codingTraceDir ?? join(opts.workspaceDir, "..", "coding-sessions"),
      policy: this.policy,
      proactiveApprovalTimeoutMs: this.approvalTimeoutMs,
      watchHandbackFile: opts.codingWatchHandbackFile,
    });
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
    } else if (
      event.type === "coding.session.completed" ||
      event.type === "coding.session.paused" ||
      event.type === "coding.session.failed"
    ) {
      // A session that finished, handed back (paused), or failed resumes its
      // spawning manager run with the increment result.
      const cs = this.spine.getCodingSession(event.codingSessionId);
      if (cs?.spawningRunId) void this.inbox.enqueue({ kind: "resume", runId: cs.spawningRunId });
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
    // Coding-session approvals from a proactive run have no human attached either;
    // sweep them through the same resolve path (which forks to inject "No").
    for (const coding of this.spine.getExpiredCodingApprovals(now.toISOString())) {
      this.resolveApproval(coding.id, "deny");
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
  resolveApproval(approvalId: string, rawDecision: string): boolean {
    // The decision arrives over the socket/HTTP wire — whitelist it into the
    // canonical vocabulary, failing closed (anything unknown → deny) so a garbage
    // or empty string can never be mistaken for a grant.
    const decision = parseApprovalDecision(rawDecision);
    const status: ApprovalStatus = decision === "deny" ? "denied" : "allowed";

    // Coding-session approvals resolve into a keystroke injection, not a run resume.
    const coding = this.spine.getCodingApproval(approvalId);
    if (coding) {
      if (coding.status !== "pending") return false;
      this.sink.emit({
        type: "approval.resolved",
        sessionKey: `coding:${coding.codingSessionId}`,
        runId: "",
        approvalId,
        decision,
      });
      // The manager owns coding-approval resolution: it flips the durable row AND
      // injects the answer keystroke. (Do NOT flip the row here first — that would
      // make the manager's pending-guard early-return and skip the injection, leaving
      // the PTY stuck at its prompt.)
      this.coding.resolveCodingApproval(approvalId, decision);
      return true;
    }

    const approval = this.spine.getApproval(approvalId);
    if (!approval || approval.status !== "pending") return false;
    this.spine.resolveApproval(approvalId, status, decision);
    this.sink.emit({
      type: "approval.resolved",
      sessionKey: approval.sessionKey,
      runId: approval.runId,
      approvalId,
      decision,
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
    // Rebuild the in-memory run→source routing map from the durable record. A run
    // suspended (awaiting approval/subwork) before the crash is NOT re-driven here — it
    // resumes later when its approval resolves — and that resume path won't re-emit
    // run.started, so without this seed routeApproval wouldn't know it's proactive.
    for (const run of this.spine.listSuspendedRuns()) {
      this.runMeta.set(run.id, { proactive: run.source?.kind === "trigger", agentId: run.agentId });
    }
    // A coding session left non-terminal by a crash has a dead PTY (its child process
    // died with the daemon) but its row still says running, and its spawning run is
    // parked `awaiting_subwork` — which getInterruptedRuns does NOT return, so it would
    // hang forever. Reconcile those first: mark the session process_lost and resume the
    // stranded run so it collects an (error) result and continues.
    for (const runId of this.recoverCodingSessions()) {
      await this.resumeRun(runId);
    }
    for (const run of this.spine.getInterruptedRuns()) {
      // Close any tool_use the crash left unanswered before re-driving — otherwise the
      // re-driven context ends with a tool_use lacking its tool_result and the provider
      // 400s on every recovery attempt (RF-08).
      this.spine.repairDanglingToolUses(run.sessionKey, run.id);
      await this.runLoop(run);
    }
  }

  /** Mark coding sessions orphaned by a crash as `process_lost` (the daemon just
   *  started, so nothing is live — any still-running row is dead). Returns the
   *  spawning run ids parked `awaiting_subwork` that need resuming. */
  private recoverCodingSessions(): string[] {
    const toResume: string[] = [];
    for (const cs of this.spine.listCodingSessions()) {
      if (cs.status !== "running" && cs.status !== "awaiting_decision") continue;
      const diag =
        `The coding session (${cs.id}) was interrupted by a daemon restart — its process did not ` +
        `survive (status before the restart: ${cs.status}). It can be revived from where it left off ` +
        `with send_feedback("${cs.id}", "<how to continue>").`;
      this.spine.setCodingSessionStatus(cs.id, "process_lost", diag);
      if (cs.spawningRunId) {
        const run = this.spine.getRun(cs.spawningRunId);
        if (run?.status === "suspended") toResume.push(cs.spawningRunId);
      }
    }
    return toResume;
  }

  /** Cancel the in-flight run for a session (reef-docs/03 cancellation). Also
   *  kills any non-terminal coding session spawned by a run on this session — a
   *  run suspended `awaiting_subwork` has no live aborter, yet its coding session
   *  keeps running, so aborting the run alone would orphan the PTY. */
  cancel(sessionKey: string): boolean {
    let killedCoding = false;
    for (const cs of this.spine.listCodingSessions()) {
      const spawningRun = cs.spawningRunId ? this.spine.getRun(cs.spawningRunId) : undefined;
      if (
        cs.spawningRunId &&
        spawningRun?.sessionKey === sessionKey &&
        cs.status !== "completed" &&
        cs.status !== "failed" &&
        cs.status !== "cancelled"
      ) {
        this.coding.cancel(cs.id);
        killedCoding = true;
        // A run suspended awaiting_subwork has no live aborter, so the abort path
        // below never finalizes it. Mark it terminal here using the same
        // convention runAgentLoop uses for an aborted run (status "completed",
        // stopReason "cancelled"), so the post-kill coding.session.completed
        // resume hits resumeRun's no-suspended guard instead of re-parking it.
        if (spawningRun.status === "suspended") {
          this.spine.setRunStatus(cs.spawningRunId, "completed", {
            stopReason: "cancelled",
            endedAt: nowIso(),
          });
          this.sink.emit({
            type: "run.completed",
            stopReason: "cancelled",
            sessionKey,
            runId: cs.spawningRunId,
          });
        }
      }
    }
    const aborter = this.aborters.get(sessionKey);
    if (aborter) {
      aborter.abort();
      return true;
    }
    return killedCoding;
  }

  /** Begin firing triggers on the scheduler's cadence and arm file-watch
   *  triggers restored from the durable table. Call after recover(). */
  start(): void {
    this.scheduler.start();
    this.watcher.start(this.spine.listTriggers());
  }

  close(): void {
    this.scheduler.stop();
    this.watcher.stop();
    this.coding.close(); // kill live coding sessions + close their traces before the spine
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
    // A live-created watch starts watching now (start() handles ones restored
    // from the table); the register is idempotent so both paths are safe.
    if (trigger.type === "watch" && trigger.enabled) this.watcher.register(trigger);
    return trigger;
  }

  /**
   * Find-or-create a file-watch trigger for `path` (Phase 4d) — idempotent per
   * (agent, path) so the config-declared watches can be ensured on every startup
   * without piling up duplicates, exactly like the heartbeat. Operator-created
   * (the agent doesn't self-watch yet); `skip` catch-up since a watch has no
   * missed-fire notion.
   */
  ensureWatch(input: {
    agentId: string;
    path: string;
    input: string;
    events?: WatchEventKind[];
    recursive?: boolean;
    debounceMs?: number;
    cooldownMs?: number;
  }): Trigger {
    const existing = this.spine
      .listTriggers(input.agentId)
      .find((t) => t.spec.kind === "watch" && t.spec.path === input.path);
    if (existing) return existing;
    return this.createTrigger({
      agentId: input.agentId,
      type: "watch",
      spec: {
        kind: "watch",
        path: input.path,
        events: input.events,
        recursive: input.recursive,
        debounceMs: input.debounceMs,
        cooldownMs: input.cooldownMs,
      },
      input: input.input,
      catchUpPolicy: "skip",
    });
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

  // ── coding-agent control (operator-initiated in Step 1) ─────────────────────
  startCodingSession(opts: { agentKind: string; directory: string; task: string; model?: string }): string {
    return this.coding.start(opts);
  }
  sendToCodingSession(id: string, data: string): void {
    this.coding.send(id, data);
  }
  cancelCodingSession(id: string): void {
    this.coding.cancel(id);
  }
  /** Operator-initiated revive: feed a follow-up increment to a paused session
   *  (the operator counterpart to the agent's send_feedback tool). No spawning run
   *  to route back to — the result surfaces via the coding.* events. Throws if the
   *  session isn't resumable (`paused`); the socket handler turns that into an error. */
  feedbackToCodingSession(id: string, text: string): void {
    this.coding.resume(id, text);
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
      .listSuspendedRuns()
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
    // A watch trigger has no nextFireAt; its enablement is the OS watch itself.
    if (t.spec.kind === "watch") {
      if (enabled) this.watcher.register({ ...t, enabled: true });
      else this.watcher.unregister(id);
    }
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
    if (job.kind === "trigger") return this.processTrigger(job.triggerId, job.event);
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
      source: { kind: "message" },
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
   *  the trigger's stable session, tagged as a proactive run. For a file-watch
   *  fire (Phase 4d) the change is appended to the instruction and carried on the
   *  source, so the run knows what changed. */
  private async processTrigger(triggerId: string, event?: WatchEvent): Promise<void> {
    const trigger = this.spine.getTrigger(triggerId);
    if (!trigger || !trigger.enabled) return;
    this.spine.ensureSession(
      trigger.sessionKey,
      trigger.agentId,
      this.spine.getAgent(trigger.agentId)?.model,
    );
    const text = event
      ? `${trigger.input}\n\n(file event: ${event.type} at ${event.path})`
      : trigger.input;
    this.spine.appendMessage(trigger.sessionKey, "user", [{ type: "text", text }]);
    const source: RunSource = {
      kind: "trigger",
      triggerId: trigger.id,
      triggerType: trigger.type,
      ...(event ? { event } : {}),
    };
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: trigger.agentId,
      sessionKey: trigger.sessionKey,
      source,
    });
    this.sink.emit({
      type: "message.received",
      text,
      source,
      sessionKey: trigger.sessionKey,
      runId: run.id,
    });
    await this.runLoop(run, { source });
  }

  private async resumeRun(runId: string): Promise<void> {
    const run = this.spine.getRun(runId);
    // Only a still-suspended run resumes. A resume job for a run that already
    // reached a terminal state (e.g. cancel marked it completed before the
    // post-kill coding.session.completed enqueued this resume) is a no-op,
    // rather than re-driving the subwork preamble and re-parking it forever.
    if (!run || run.status !== "suspended") return;
    this.spine.setRunStatus(runId, "running");
    await this.runLoop({ ...run, status: "running" }, { resumeApproval: true });
  }

  private async runLoop(run: Run, options: LoopOptions = {}): Promise<void> {
    // Resolve the wake source: an explicit option wins, else the run's DURABLE source
    // (so a recovered/resumed run keeps its proactive policy), else a plain message.
    const resolvedOptions: LoopOptions = {
      ...options,
      source: options.source ?? run.source ?? { kind: "message" },
    };
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
          startSubwork: async (r, call, src) => {
            if (call.name === "send_feedback") {
              // A revive intentionally re-links the SAME session to this run+tool, so
              // (unlike start) it must NOT short-circuit on a prior subwork link.
              const input = sendFeedback.inputSchema.parse(call.input);
              // Scope: an agent may only revive a coding session one of ITS OWN runs
              // started — not an operator's or another agent's. Otherwise the model
              // could push attacker/model-controlled task+dir into a repo it never
              // initiated. The throw becomes a graceful isError tool_result (the loop's
              // startSubwork catch), so the model can recover rather than the run failing.
              // Scope on the STABLE owner (stamped at creation), not the spawning run —
              // operator/agent revives rewrite spawning_run_id, which would otherwise
              // lock the owning agent out of its own session.
              const cs = this.spine.getCodingSession(input.sessionId);
              if (!cs || cs.ownerAgentId !== r.agentId) {
                throw new Error(
                  `send_feedback denied: coding session ${input.sessionId} was not started by this agent`,
                );
              }
              this.coding.resume(input.sessionId, input.text, { spawningRunId: r.id, spawningToolUseId: call.id, source: src });
              return input.sessionId;
            }
            // Idempotent: if this (run, toolUse) already spawned a session, reuse it
            // (defends against a duplicate resume re-starting an in-flight session).
            const existing = this.spine.findCodingSessionBySubwork(r.id, call.id);
            if (existing) return existing.id;
            const input = startCodingSession.inputSchema.parse(call.input);
            return this.coding.start({
              agentKind: input.agentKind ?? "claude-code",
              directory: input.directory,
              task: input.task,
              model: input.model,
              spawningRunId: r.id,
              spawningToolUseId: call.id,
              source: src,
            });
          },
          collectSubwork: (runId, toolUseId) => {
            const cs = this.spine.findCodingSessionBySubwork(runId, toolUseId);
            // `paused` = handed back (increment done, resumable); `process_lost` = the
            // PTY died (crash recovery) — both are completable results for the manager
            // run, like completed/failed. process_lost is failed-shaped (isError).
            if (!cs || !TERMINAL_CODING_STATUSES.has(cs.status)) return undefined;
            return {
              result: cs.result ?? `coding session ${cs.id} ${cs.status}`,
              failed: cs.status === "failed" || cs.status === "process_lost",
              sessionId: cs.id,
              status: cs.status,
            };
          },
        },
        resolvedOptions,
      );
    } finally {
      this.aborters.delete(run.sessionKey);
    }
  }
}
