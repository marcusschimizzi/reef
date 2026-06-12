import type { Database } from "better-sqlite3";

// The operational spine's schema (reef-docs/04). The database holds the state
// the *system* reasons over and recovers from; the filesystem holds artifacts.
// Everything here is queried, mutated atomically, and reconcilable after a crash.

const DDL = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  model         TEXT NOT NULL,
  tool_allowlist TEXT NOT NULL,   -- JSON string[]
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  model       TEXT,              -- snapshot at creation; sticks across global changes
  created_at  TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- The canonical conversation. Spans runs within a session (reef-docs/03: a run
-- is the unit of work, the session is the unit of conversation).
CREATE TABLE IF NOT EXISTS messages (
  session_key TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,      -- JSON ContentBlock[]
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_key, seq)
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  session_key   TEXT NOT NULL,
  status        TEXT NOT NULL,    -- running | suspended | completed | failed
  stop_reason   TEXT,
  parent_run_id TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

-- The durable unit of progress (reef-docs/03). One row per loop iteration:
-- inserted 'pending' before the model call, updated to 'committed' after the
-- call and its tools resolve. Recovery = "which steps were pending when we died".
CREATE TABLE IF NOT EXISTS steps (
  run_id       TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  state        TEXT NOT NULL,     -- pending | committed
  response     TEXT,              -- JSON ContentBlock[]
  tool_results TEXT,              -- JSON ContentBlock[]
  usage        TEXT,              -- JSON Usage
  started_at   TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (run_id, idx),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_steps_state ON steps(state);

-- Durable tool-approval records. A run with pending approvals is 'suspended'
-- (awaiting_approval) and survives a daemon restart; resolving them re-drives it.
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  session_key TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  input       TEXT NOT NULL,     -- JSON
  status      TEXT NOT NULL,     -- pending | allowed | denied
  decision    TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT,
  expires_at  TEXT,              -- routed proactive approvals auto-deny past this
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id);

-- Durable compaction checkpoints (Phase 3c). A summary that stands in for every
-- message up to through_seq, folding long sessions back under the context window.
-- This is a VIEW over the messages log, never a rewrite of it: getContext returns
-- the latest summary plus the verbatim tail (messages with seq > through_seq), so
-- the canonical conversation stays intact and re-compactable.
CREATE TABLE IF NOT EXISTS compactions (
  session_key TEXT NOT NULL,
  through_seq INTEGER NOT NULL,   -- highest message seq folded into this summary
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_key, through_seq)
);

-- Durable trigger records (Phase 4a): wake sources beyond the inbound message.
-- The scheduler ticks, finds rows due (enabled AND next_fire_at <= now), enqueues
-- a wake, and recomputes next_fire_at — so triggers survive restart and missed
-- fires are reconciled by policy, not lost.
CREATE TABLE IF NOT EXISTS triggers (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  type            TEXT NOT NULL,    -- schedule | (heartbeat | file_watch later)
  spec            TEXT NOT NULL,    -- JSON TriggerSpec (cron | interval)
  input           TEXT NOT NULL,    -- instruction rendered into the wake message
  session_key     TEXT NOT NULL,    -- stable session for this trigger's runs
  created_by      TEXT NOT NULL DEFAULT 'operator', -- operator | agent (Phase 4c)
  enabled         INTEGER NOT NULL, -- 0 | 1
  catch_up_policy TEXT NOT NULL,    -- fire_once | skip
  next_fire_at    TEXT,             -- ISO-8601; null once exhausted
  last_fired_at   TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
CREATE INDEX IF NOT EXISTS idx_triggers_due ON triggers(enabled, next_fire_at);

-- The action audit log (recorded-authority substrate). One row per tool-execution
-- attempt: the policy decision that governed it and how it resolved. Makes "what
-- did this agent do, what was allowed, and why" a query. The broker's fs leases
-- and richer tracing extend this same log later.
CREATE TABLE IF NOT EXISTS actions (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  session_key TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  tool_name   TEXT NOT NULL,
  input       TEXT NOT NULL,      -- JSON
  decision    TEXT NOT NULL,      -- allow | gate | deny
  reason      TEXT,
  outcome     TEXT NOT NULL,      -- ok | error | denied
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_agent ON actions(agent_id, created_at);

-- The native protocol event log (reef-docs/04 per-run event log; shape left open
-- in reef-docs/10). Persisted so a consumer can fetch history and reconnect
-- without replay gaps (conch's reconnect pattern). Emitter lands in Phase 2.
CREATE TABLE IF NOT EXISTS events (
  session_key TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  run_id      TEXT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,      -- JSON ReefEvent (full event)
  ts          INTEGER NOT NULL,
  PRIMARY KEY (session_key, seq)
);

-- Interactive external coding sessions (Phase: coding-agent control). A session
-- reef drives over a PTY (Claude Code, etc.); external_session_id is the
-- reef-minted UUID passed to --session-id, enabling --resume after a lost PTY.
CREATE TABLE IF NOT EXISTS coding_sessions (
  id           TEXT PRIMARY KEY,
  spawning_run_id     TEXT,
  spawning_tool_use_id TEXT,
  agent_kind   TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  directory    TEXT NOT NULL,
  status       TEXT NOT NULL,
  task         TEXT NOT NULL,
  result       TEXT,
  trace_path   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  ended_at     TEXT
);
`;

export function applySchema(db: Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  migrate(db);
}

/**
 * Additive migrations for databases created by an older schema. `CREATE TABLE IF
 * NOT EXISTS` never alters an existing table, so a column added to the DDL above
 * is invisible to a pre-existing db without an explicit ALTER. Each step is
 * guarded by a column-presence check, so applying the schema is idempotent.
 */
function migrate(db: Database): void {
  addColumnIfMissing(db, "triggers", "created_by", "TEXT NOT NULL DEFAULT 'operator'");
  addColumnIfMissing(db, "approvals", "expires_at", "TEXT");
  addColumnIfMissing(db, "sessions", "model", "TEXT");
  addColumnIfMissing(db, "coding_sessions", "spawning_tool_use_id", "TEXT");
}

function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
