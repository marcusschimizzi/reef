import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { nowIso } from "../core/time.js";
import type {
  AgentRecord,
  ContentBlock,
  Message,
  Role,
  Run,
  RunStatus,
  Step,
  StepState,
  StopReason,
  Usage,
} from "../core/types.js";
import type { ReefEvent } from "../protocol/events.js";

type DB = Database.Database;

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
interface RunRow {
  id: string;
  agent_id: string;
  session_key: string;
  status: string;
  stop_reason: string | null;
  parent_run_id: string | null;
  started_at: string;
  ended_at: string | null;
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

  constructor(path: string) {
    this.db = new Database(path);
    applySchema(this.db);
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
  ensureSession(sessionKey: string, agentId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions (session_key, agent_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionKey, agentId, nowIso());
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

  // ── runs ──────────────────────────────────────────────────────────────────
  createRun(input: {
    id: string;
    agentId: string;
    sessionKey: string;
    parentRunId?: string;
  }): Run {
    const startedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, session_key, status, parent_run_id, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        input.id,
        input.agentId,
        input.sessionKey,
        input.parentRunId ?? null,
        startedAt,
      );
    return {
      id: input.id,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      status: "running",
      parentRunId: input.parentRunId,
      startedAt,
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

  getEventsSince(sessionKey: string, sinceSeq: number): ReefEvent[] {
    const rows = this.db
      .prepare(
        `SELECT payload FROM events WHERE session_key = ? AND seq > ? ORDER BY seq ASC`,
      )
      .all(sessionKey, sinceSeq) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as ReefEvent);
  }
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
