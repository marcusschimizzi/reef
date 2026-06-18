import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { nowIso } from "../core/time.js";
import type {
  Action,
  AgentRecord,
  Approval,
  ApprovalStatus,
  CatchUpPolicy,
  Compaction,
  ContentBlock,
  Message,
  Role,
  Run,
  RunSource,
  RunStatus,
  SessionStatus,
  SessionSummary,
  Step,
  StepState,
  StopReason,
  Trigger,
  TriggerOrigin,
  TriggerSpec,
  TriggerType,
  Usage,
} from "../core/types.js";
import type { ReefEvent } from "../protocol/events.js";

type DB = Database.Database;

/** A message with its per-session sequence — the anchor compaction cuts on. */
export interface MessageEntry extends Message {
  seq: number;
}

export interface CodingSessionRecord {
  id: string;
  spawningRunId: string | null;
  spawningToolUseId: string | null;
  agentKind: string;
  externalSessionId: string;
  directory: string;
  status: string;
  task: string;
  result?: string;
  /** Model the session runs on (e.g. "haiku"); reused verbatim on --resume revive. */
  model?: string;
  tracePath: string;
  createdAt: string;
  endedAt?: string;
}

export interface CodingApprovalRecord {
  id: string;
  codingSessionId: string;
  promptText: string;
  options: { index: number; label: string }[];
  toolName: string;
  input: unknown;
  status: "pending" | "allowed" | "denied";
  decision?: string;
  createdAt: string;
  decidedAt?: string;
  /** Auto-deny deadline for a routed proactive coding approval (no inline human). */
  expiresAt?: string;
}

// ── row shapes (as stored) ──────────────────────────────────────────────────
interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
  tool_allowlist: string;
  created_at: string;
}
interface MessageRow {
  role: string;
  content: string;
}
interface MessageEntryRow {
  seq: number;
  role: string;
  content: string;
}
interface CompactionRow {
  session_key: string;
  through_seq: number;
  summary: string;
  created_at: string;
}
interface TriggerRow {
  id: string;
  agent_id: string;
  type: string;
  spec: string;
  input: string;
  session_key: string;
  created_by: string;
  enabled: number;
  catch_up_policy: string;
  next_fire_at: string | null;
  last_fired_at: string | null;
  created_at: string;
}
interface RunRow {
  id: string;
  agent_id: string;
  session_key: string;
  status: string;
  stop_reason: string | null;
  parent_run_id: string | null;
  started_at: string;
  ended_at: string | null;
  source: string | null;
}
interface StepRow {
  run_id: string;
  idx: number;
  state: string;
  response: string | null;
  tool_results: string | null;
  usage: string | null;
  started_at: string;
  committed_at: string | null;
}
interface ApprovalRow {
  id: string;
  run_id: string;
  session_key: string;
  tool_use_id: string;
  tool_name: string;
  input: string;
  status: string;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

interface ActionRow {
  id: string;
  run_id: string;
  session_key: string;
  agent_id: string;
  tool_name: string;
  input: string;
  decision: string;
  reason: string | null;
  outcome: string;
  created_at: string;
}

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: string | null): T | undefined =>
  s == null ? undefined : (JSON.parse(s) as T);

/**
 * The operational spine (reef-docs/04). The database *is* the state; the loop
 * advances it; recovery is a query over it. Wraps better-sqlite3 — synchronous,
 * so "commit this step before starting the next" is just an ordered statement,
 * with no await-interleaving on the hottest path in the system.
 */
export class Spine {
  private readonly db: DB;

  constructor(dbOrPath: string | DB) {
    this.db = typeof dbOrPath === "string" ? new Database(dbOrPath) : dbOrPath;
    applySchema(this.db);
  }

  /** The underlying connection — so the default memory store can share it
   *  (one file, one handle) rather than opening a second connection. */
  get connection(): DB {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  // ── agents ────────────────────────────────────────────────────────────────
  upsertAgent(a: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, system_prompt, model, tool_allowlist, created_at)
         VALUES (@id, @name, @system_prompt, @model, @tool_allowlist, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, system_prompt=excluded.system_prompt,
           model=excluded.model, tool_allowlist=excluded.tool_allowlist`,
      )
      .run({
        id: a.id,
        name: a.name,
        system_prompt: a.systemPrompt,
        model: a.model,
        tool_allowlist: json(a.toolAllowlist),
        created_at: nowIso(),
      });
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agents WHERE id = ?`)
      .get(id) as AgentRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      systemPrompt: row.system_prompt,
      model: row.model,
      toolAllowlist: JSON.parse(row.tool_allowlist) as string[],
    };
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  /** Create the session if new, snapshotting `model` so it sticks for this
   *  session's lifetime even if the global default changes later. */
  ensureSession(sessionKey: string, agentId: string, model?: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (session_key, agent_id, model, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionKey, agentId, model ?? null, nowIso());
  }

  /** Change a session's model (the TUI `/model`); the session's next run reads
   *  it. Creates the session row if it doesn't exist yet, so a brand-new chat
   *  can be retargeted before its first turn. */
  setSessionModel(sessionKey: string, agentId: string, model: string): void {
    this.ensureSession(sessionKey, agentId, model); // create-if-missing (no-op if present)
    this.db.prepare(`UPDATE sessions SET model = ? WHERE session_key = ?`).run(model, sessionKey);
  }

  /** The model snapshotted for this session, if any (else the agent default applies). */
  getSessionModel(sessionKey: string): string | undefined {
    const row = this.db
      .prepare(`SELECT model FROM sessions WHERE session_key = ?`)
      .get(sessionKey) as { model: string | null } | undefined;
    return row?.model ?? undefined;
  }

  /**
   * A denormalized view of every session for the sessions list (Phase 4c TUI).
   * Computed on demand — most-recently-active first — by combining each
   * session's latest run, pending approvals, and first/last messages. Cheap at
   * v1 scale (a handful of small queries per session); not a hot path.
   */
  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(`SELECT session_key, agent_id, model, created_at FROM sessions`)
      .all() as Array<{ session_key: string; agent_id: string; model: string | null; created_at: string }>;
    return rows
      .map((r) => this.summarizeSession(r.session_key, r.agent_id, r.model ?? undefined, r.created_at))
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  }

  private summarizeSession(
    sessionKey: string,
    agentId: string,
    model: string | undefined,
    createdAt: string,
  ): SessionSummary {
    const latestRun = this.db
      .prepare(`SELECT status, stop_reason FROM runs WHERE session_key = ? ORDER BY started_at DESC LIMIT 1`)
      .get(sessionKey) as { status: string; stop_reason: string | null } | undefined;
    const status = deriveSessionStatus(latestRun);
    const { p } = this.db
      .prepare(`SELECT COUNT(*) AS p FROM approvals WHERE session_key = ? AND status = 'pending'`)
      .get(sessionKey) as { p: number };
    const oldestPending = this.db
      .prepare(`SELECT id FROM approvals WHERE session_key = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1`)
      .get(sessionKey) as { id: string } | undefined;
    const firstUser = this.db
      .prepare(`SELECT content FROM messages WHERE session_key = ? AND role = 'user' ORDER BY seq ASC LIMIT 1`)
      .get(sessionKey) as { content: string } | undefined;
    const lastAsst = this.db
      .prepare(`SELECT content FROM messages WHERE session_key = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1`)
      .get(sessionKey) as { content: string } | undefined;
    const { m } = this.db
      .prepare(`SELECT MAX(created_at) AS m FROM messages WHERE session_key = ?`)
      .get(sessionKey) as { m: string | null };

    const previewText = lastAsst ? textOfBlocks(lastAsst.content) : "";
    return {
      sessionKey,
      agentId,
      status,
      title: firstUser ? textOfBlocks(firstUser.content) : "(no messages yet)",
      preview: previewText || sessionStatusNote(status),
      pendingApprovals: p,
      pendingApprovalId: oldestPending?.id,
      model,
      lastActivityAt: m ?? createdAt,
      createdAt,
    };
  }

  // ── messages (the canonical conversation) ──────────────────────────────────
  appendMessage(
    sessionKey: string,
    role: Role,
    content: ContentBlock[],
    runId?: string,
  ): number {
    const tx = this.db.transaction((): number => {
      const { m } = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_key = ?`,
        )
        .get(sessionKey) as { m: number };
      const seq = m + 1;
      this.db
        .prepare(
          `INSERT INTO messages (session_key, seq, role, content, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionKey, seq, role, json(content), runId ?? null, nowIso());
      return seq;
    });
    return tx();
  }

  getMessages(sessionKey: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT role, content FROM messages WHERE session_key = ? ORDER BY seq ASC`,
      )
      .all(sessionKey) as MessageRow[];
    return rows.map((r) => ({
      role: r.role as Role,
      content: JSON.parse(r.content) as ContentBlock[],
    }));
  }

  /** Messages with seq > afterSeq, seq attached — what compaction cuts on. */
  getMessageEntries(sessionKey: string, afterSeq = 0): MessageEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, role, content FROM messages
         WHERE session_key = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionKey, afterSeq) as MessageEntryRow[];
    return rows.map((r) => ({
      seq: r.seq,
      role: r.role as Role,
      content: JSON.parse(r.content) as ContentBlock[],
    }));
  }

  /**
   * The compacted *view* the loop feeds to the model (Phase 3c). With no
   * checkpoint this is exactly getMessages; with one it is the latest summary
   * (as a leading user turn) followed by the verbatim tail (seq > throughSeq).
   * The raw log is never touched — compaction is a projection, so recovery and
   * audit still see the whole conversation.
   */
  getContext(sessionKey: string): Message[] {
    const comp = this.getLatestCompaction(sessionKey);
    const tail = this.getMessageEntries(sessionKey, comp?.throughSeq ?? 0).map(
      ({ seq: _seq, ...m }) => m,
    );
    if (!comp) return tail;
    return [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[Summary of earlier conversation, condensed to stay within the context window]\n\n${comp.summary}`,
          },
        ],
      },
      ...tail,
    ];
  }

  // ── compactions (the durable context-window checkpoints, Phase 3c) ──────────
  appendCompaction(c: {
    sessionKey: string;
    throughSeq: number;
    summary: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO compactions (session_key, through_seq, summary, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(c.sessionKey, c.throughSeq, c.summary, nowIso());
  }

  getLatestCompaction(sessionKey: string): Compaction | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM compactions WHERE session_key = ?
         ORDER BY through_seq DESC LIMIT 1`,
      )
      .get(sessionKey) as CompactionRow | undefined;
    if (!row) return undefined;
    return {
      sessionKey: row.session_key,
      throughSeq: row.through_seq,
      summary: row.summary,
      createdAt: row.created_at,
    };
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  createRun(input: {
    id: string;
    agentId: string;
    sessionKey: string;
    parentRunId?: string;
    source?: RunSource;
  }): Run {
    const startedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, session_key, status, parent_run_id, started_at, source)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.agentId,
        input.sessionKey,
        input.parentRunId ?? null,
        startedAt,
        input.source ? JSON.stringify(input.source) : null,
      );
    return {
      id: input.id,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      status: "running",
      parentRunId: input.parentRunId,
      startedAt,
      source: input.source,
    };
  }

  setRunStatus(
    id: string,
    status: RunStatus,
    opts: { stopReason?: StopReason; endedAt?: string } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, stop_reason = ?, ended_at = ? WHERE id = ?`,
      )
      .run(status, opts.stopReason ?? null, opts.endedAt ?? null, id);
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /**
   * Runs for observability surfaces (most recent first). With `status`, only
   * runs in that state — e.g. `suspended` to find what's awaiting approval.
   */
  listRuns(opts: { status?: RunStatus; limit?: number } = {}): Run[] {
    const limit = opts.limit ?? 50;
    const rows = (
      opts.status
        ? this.db
            .prepare(`SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?`)
            .all(opts.status, limit)
        : this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(limit)
    ) as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Recovery query (reef-docs/04): runs that were mid-flight when the daemon
   * died — status 'running', never reaching a terminal or suspended state.
   * The daemon's recovery pass reconciles these on startup.
   */
  getInterruptedRuns(): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE status = 'running'`)
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  // ── steps (the durable unit of progress) ───────────────────────────────────
  beginStep(runId: string, index: number): void {
    // INSERT OR REPLACE so re-driving a step left pending by a crash is
    // idempotent (recovery re-runs the model call that never durably finished).
    this.db
      .prepare(
        `INSERT OR REPLACE INTO steps (run_id, idx, state, started_at)
         VALUES (?, ?, 'pending', ?)`,
      )
      .run(runId, index, nowIso());
  }

  commitStep(
    runId: string,
    index: number,
    result: {
      response?: ContentBlock[];
      toolResults?: ContentBlock[];
      usage?: Usage;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE steps SET state = 'committed', response = ?, tool_results = ?,
           usage = ?, committed_at = ?
         WHERE run_id = ? AND idx = ?`,
      )
      .run(
        result.response ? json(result.response) : null,
        result.toolResults ? json(result.toolResults) : null,
        result.usage ? json(result.usage) : null,
        nowIso(),
        runId,
        index,
      );
  }

  /** Persist a model turn onto a still-pending step (used when suspending for
   *  approval, so resume can reconstruct the turn with its usage intact). */
  updateStepOutput(
    runId: string,
    index: number,
    output: { response?: ContentBlock[]; usage?: Usage },
  ): void {
    this.db
      .prepare(`UPDATE steps SET response = ?, usage = ? WHERE run_id = ? AND idx = ?`)
      .run(
        output.response ? json(output.response) : null,
        output.usage ? json(output.usage) : null,
        runId,
        index,
      );
  }

  getSteps(runId: string): Step[] {
    const rows = this.db
      .prepare(`SELECT * FROM steps WHERE run_id = ? ORDER BY idx ASC`)
      .all(runId) as StepRow[];
    return rows.map(rowToStep);
  }

  /** Steps left pending when the daemon died — the in-flight model calls. */
  getPendingSteps(): Array<{ runId: string; index: number }> {
    const rows = this.db
      .prepare(`SELECT run_id, idx FROM steps WHERE state = 'pending'`)
      .all() as Array<{ run_id: string; idx: number }>;
    return rows.map((r) => ({ runId: r.run_id, index: r.idx }));
  }

  // ── approvals (durable suspend-for-approval) ────────────────────────────────
  createApproval(a: {
    id: string;
    runId: string;
    sessionKey: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, session_key, tool_use_id, tool_name, input, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(a.id, a.runId, a.sessionKey, a.toolUseId, a.toolName, json(a.input), nowIso());
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approvals WHERE id = ?`)
      .get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  resolveApproval(id: string, status: ApprovalStatus, decision: string): void {
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?`,
      )
      .run(status, decision, nowIso(), id);
  }

  getApprovalsForRun(runId: string): Approval[] {
    const rows = this.db
      .prepare(`SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  pendingApprovalCount(runId: string): number {
    const { c } = this.db
      .prepare(`SELECT COUNT(*) AS c FROM approvals WHERE run_id = ? AND status = 'pending'`)
      .get(runId) as { c: number };
    return c;
  }

  /** Arm an auto-deny deadline on a (routed proactive) approval. */
  setApprovalExpiry(id: string, expiresAt: string): void {
    this.db.prepare(`UPDATE approvals SET expires_at = ? WHERE id = ?`).run(expiresAt, id);
  }

  /** Pending approvals whose auto-deny deadline has passed — swept to denied. */
  getExpiredApprovals(nowIso: string): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(nowIso) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  // ── triggers (durable wake sources — Phase 4a) ──────────────────────────────
  createTrigger(t: Trigger): void {
    this.db
      .prepare(
        `INSERT INTO triggers
           (id, agent_id, type, spec, input, session_key, created_by, enabled,
            catch_up_policy, next_fire_at, last_fired_at, created_at)
         VALUES (@id, @agent_id, @type, @spec, @input, @session_key, @created_by, @enabled,
            @catch_up_policy, @next_fire_at, @last_fired_at, @created_at)`,
      )
      .run({
        id: t.id,
        agent_id: t.agentId,
        type: t.type,
        spec: json(t.spec),
        input: t.input,
        session_key: t.sessionKey,
        created_by: t.createdBy,
        enabled: t.enabled ? 1 : 0,
        catch_up_policy: t.catchUpPolicy,
        next_fire_at: t.nextFireAt ?? null,
        last_fired_at: t.lastFiredAt ?? null,
        created_at: t.createdAt,
      });
  }

  getTrigger(id: string): Trigger | undefined {
    const row = this.db
      .prepare(`SELECT * FROM triggers WHERE id = ?`)
      .get(id) as TriggerRow | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  listTriggers(agentId?: string): Trigger[] {
    const rows = (
      agentId
        ? this.db.prepare(`SELECT * FROM triggers WHERE agent_id = ? ORDER BY created_at ASC`).all(agentId)
        : this.db.prepare(`SELECT * FROM triggers ORDER BY created_at ASC`).all()
    ) as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  /** Enabled triggers whose next fire is due at or before `nowIso`. */
  getDueTriggers(nowIso: string): Trigger[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM triggers
         WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         ORDER BY next_fire_at ASC`,
      )
      .all(nowIso) as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  /** Advance a trigger after a tick: its new next fire and last-fired stamp. */
  updateTriggerSchedule(
    id: string,
    next: { nextFireAt?: string; lastFiredAt?: string },
  ): void {
    this.db
      .prepare(`UPDATE triggers SET next_fire_at = ?, last_fired_at = ? WHERE id = ?`)
      .run(next.nextFireAt ?? null, next.lastFiredAt ?? null, id);
  }

  setTriggerEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE triggers SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }

  /** Remove a trigger entirely (the agent cancelling one of its own — Phase 4c). */
  deleteTrigger(id: string): void {
    this.db.prepare(`DELETE FROM triggers WHERE id = ?`).run(id);
  }

  /**
   * Pending agent-authored triggers for one agent — enabled and still having a
   * future fire. The count the self-scheduling cap is enforced against (a spent
   * one-shot has a null next_fire_at, so it stops counting once it has fired).
   */
  countPendingAgentTriggers(agentId: string): number {
    const { c } = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM triggers
         WHERE agent_id = ? AND created_by = 'agent'
           AND enabled = 1 AND next_fire_at IS NOT NULL`,
      )
      .get(agentId) as { c: number };
    return c;
  }

  // ── actions (the recorded-authority audit log) ──────────────────────────────
  recordAction(a: Action): void {
    this.db
      .prepare(
        `INSERT INTO actions (id, run_id, session_key, agent_id, tool_name, input,
            decision, reason, outcome, created_at)
         VALUES (@id, @run_id, @session_key, @agent_id, @tool_name, @input,
            @decision, @reason, @outcome, @created_at)`,
      )
      .run({
        id: a.id,
        run_id: a.runId,
        session_key: a.sessionKey,
        agent_id: a.agentId,
        tool_name: a.toolName,
        input: json(a.input),
        decision: a.decision,
        reason: a.reason ?? null,
        outcome: a.outcome,
        created_at: a.createdAt,
      });
  }

  /** Recent audit actions, newest first; optionally scoped to a run or agent. */
  listActions(opts: { runId?: string; agentId?: string; limit?: number } = {}): Action[] {
    const limit = opts.limit ?? 100;
    const where: string[] = [];
    const params: Record<string, string | number> = { limit };
    if (opts.runId) {
      where.push("run_id = @runId");
      params.runId = opts.runId;
    }
    if (opts.agentId) {
      where.push("agent_id = @agentId");
      params.agentId = opts.agentId;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM actions ${clause} ORDER BY created_at DESC LIMIT @limit`)
      .all(params) as ActionRow[];
    return rows.map(rowToAction);
  }

  // ── events (native protocol log; consumer reconnect — Phase 2) ──────────────
  appendEvent(event: ReefEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (session_key, seq, run_id, type, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionKey,
        event.seq,
        event.runId,
        event.type,
        json(event),
        event.ts,
      );
  }

  maxEventSeq(sessionKey: string): number {
    const { m } = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_key = ?`)
      .get(sessionKey) as { m: number };
    return m;
  }

  getEventsSince(sessionKey: string, sinceSeq: number): ReefEvent[] {
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE session_key = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionKey, sinceSeq) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as ReefEvent);
  }

  // ── coding sessions ───────────────────────────────────────────────────────
  createCodingSession(rec: Omit<CodingSessionRecord, "createdAt" | "result" | "endedAt">): void {
    this.db
      .prepare(
        `INSERT INTO coding_sessions
           (id, spawning_run_id, spawning_tool_use_id, agent_kind, external_session_id, directory, status, task, model, trace_path, created_at)
         VALUES (@id, @spawningRunId, @spawningToolUseId, @agentKind, @externalSessionId, @directory, @status, @task, @model, @tracePath, @createdAt)`,
      )
      .run({ ...rec, model: rec.model ?? null, createdAt: nowIso() });
  }

  /** Re-point a (paused) coding session at the run + tool_use that is reviving it,
   *  so the subwork resume routes the new increment result back to that caller. */
  relinkCodingSessionSubwork(id: string, spawningRunId: string | null, spawningToolUseId: string | null): void {
    this.db
      .prepare(`UPDATE coding_sessions SET spawning_run_id = ?, spawning_tool_use_id = ? WHERE id = ?`)
      .run(spawningRunId, spawningToolUseId, id);
  }

  getCodingSession(id: string): CodingSessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM coding_sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCodingSession(row) : undefined;
  }

  findCodingSessionBySubwork(runId: string, toolUseId: string): CodingSessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM coding_sessions WHERE spawning_run_id = ? AND spawning_tool_use_id = ?`)
      .get(runId, toolUseId) as Record<string, unknown> | undefined;
    return row ? rowToCodingSession(row) : undefined;
  }

  setCodingSessionStatus(id: string, status: string, result?: string): void {
    // `process_lost` is lifecycle-ended (the PTY died) → stamp ended_at like the other
    // terminal states. (`paused` is deliberately excluded — it's resumable, not ended.)
    const terminal =
      status === "completed" || status === "failed" || status === "cancelled" || status === "process_lost";
    this.db
      .prepare(
        `UPDATE coding_sessions
            SET status = ?, result = COALESCE(?, result), ended_at = COALESCE(ended_at, ?)
          WHERE id = ?`,
      )
      .run(status, result ?? null, terminal ? nowIso() : null, id);
  }

  listCodingSessions(): CodingSessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM coding_sessions ORDER BY created_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToCodingSession);
  }

  // ── coding approvals ──────────────────────────────────────────────────────
  createCodingApproval(rec: {
    id: string;
    codingSessionId: string;
    promptText: string;
    options: { index: number; label: string }[];
    toolName: string;
    input: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO coding_approvals
           (id, coding_session_id, prompt_text, options, tool_name, input, status, created_at)
         VALUES (@id, @codingSessionId, @promptText, @options, @toolName, @input, 'pending', @createdAt)`,
      )
      .run({
        id: rec.id,
        codingSessionId: rec.codingSessionId,
        promptText: rec.promptText,
        options: JSON.stringify(rec.options),
        toolName: rec.toolName,
        input: JSON.stringify(rec.input ?? null),
        createdAt: nowIso(),
      });
  }

  getCodingApproval(id: string): CodingApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM coding_approvals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCodingApproval(row) : undefined;
  }

  resolveCodingApproval(id: string, status: "allowed" | "denied", decision: string): void {
    this.db
      .prepare(
        `UPDATE coding_approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?`,
      )
      .run(status, decision, nowIso(), id);
  }

  /** Arm the auto-deny deadline on a routed proactive coding approval (no human to
   *  answer it inline — the scheduler sweep denies it past this instant). */
  setCodingApprovalExpiry(id: string, expiresAt: string): void {
    this.db.prepare(`UPDATE coding_approvals SET expires_at = ? WHERE id = ?`).run(expiresAt, id);
  }

  /** Pending coding approvals whose auto-deny deadline has passed. */
  getExpiredCodingApprovals(nowIso: string): CodingApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM coding_approvals
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(nowIso) as Record<string, unknown>[];
    return rows.map(rowToCodingApproval);
  }
}

/** Map a session's latest run to its list-view status. */
function deriveSessionStatus(
  latestRun: { status: string; stop_reason: string | null } | undefined,
): SessionStatus {
  if (!latestRun) return "idle";
  if (latestRun.status === "running") return "working";
  if (latestRun.status === "suspended") {
    // A subwork suspension means an external coding session is actively running —
    // it is not waiting on a human approval, so don't show the "awaiting" badge.
    return latestRun.stop_reason === "awaiting_subwork" ? "working" : "awaiting_approval";
  }
  if (latestRun.status === "failed") return "failed";
  return "idle";
}

function sessionStatusNote(status: SessionStatus): string {
  switch (status) {
    case "working":
      return "working…";
    case "awaiting_approval":
      return "awaiting approval";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
  }
}

/** Flatten a stored ContentBlock[] JSON to its text, whitespace-collapsed. */
function textOfBlocks(contentJson: string): string {
  const blocks = JSON.parse(contentJson) as ContentBlock[];
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    status: row.status as RunStatus,
    stopReason: (row.stop_reason ?? undefined) as StopReason | undefined,
    parentRunId: row.parent_run_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    source: row.source ? (JSON.parse(row.source) as RunSource) : undefined,
  };
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    sessionKey: row.session_key,
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input),
    status: row.status as ApprovalStatus,
    decision: row.decision ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function rowToTrigger(row: TriggerRow): Trigger {
  return {
    id: row.id,
    agentId: row.agent_id,
    type: row.type as TriggerType,
    spec: JSON.parse(row.spec) as TriggerSpec,
    input: row.input,
    sessionKey: row.session_key,
    createdBy: row.created_by as TriggerOrigin,
    enabled: row.enabled === 1,
    catchUpPolicy: row.catch_up_policy as CatchUpPolicy,
    nextFireAt: row.next_fire_at ?? undefined,
    lastFiredAt: row.last_fired_at ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    runId: row.run_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input),
    decision: row.decision as Action["decision"],
    reason: row.reason ?? undefined,
    outcome: row.outcome as Action["outcome"],
    createdAt: row.created_at,
  };
}

function rowToStep(row: StepRow): Step {
  return {
    runId: row.run_id,
    index: row.idx,
    state: row.state as StepState,
    response: parse<ContentBlock[]>(row.response),
    toolResults: parse<ContentBlock[]>(row.tool_results),
    usage: parse<Usage>(row.usage),
    startedAt: row.started_at,
    committedAt: row.committed_at ?? undefined,
  };
}

function rowToCodingSession(row: Record<string, unknown>): CodingSessionRecord {
  return {
    id: row.id as string,
    spawningRunId: (row.spawning_run_id as string | null) ?? null,
    spawningToolUseId: (row.spawning_tool_use_id as string | null) ?? null,
    agentKind: row.agent_kind as string,
    externalSessionId: row.external_session_id as string,
    directory: row.directory as string,
    status: row.status as string,
    task: row.task as string,
    result: (row.result as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    tracePath: row.trace_path as string,
    createdAt: row.created_at as string,
    endedAt: (row.ended_at as string | null) ?? undefined,
  };
}

function rowToCodingApproval(row: Record<string, unknown>): CodingApprovalRecord {
  return {
    id: row.id as string,
    codingSessionId: row.coding_session_id as string,
    promptText: row.prompt_text as string,
    options: JSON.parse(row.options as string) as { index: number; label: string }[],
    toolName: row.tool_name as string,
    input: JSON.parse(row.input as string),
    status: row.status as "pending" | "allowed" | "denied",
    decision: (row.decision as string | null) ?? undefined,
    createdAt: row.created_at as string,
    decidedAt: (row.decided_at as string | null) ?? undefined,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  };
}
