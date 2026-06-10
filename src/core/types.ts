// Core domain vocabulary for reef.
//
// These are the normalized types the loop, the SQLite spine, and the native
// protocol all share. Provider-specific shapes are mapped to/from these at the
// model-router boundary — nothing above the router ever sees a vendor type
// (reef-docs/09: own the loop, vendor the routing).

/** A model-agnostic content block within a message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; output: unknown; isError?: boolean };

export type Role = "user" | "assistant" | "system" | "tool";

export interface Message {
  role: Role;
  content: ContentBlock[];
}

/** Token / cost accounting for a model call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/**
 * An agent is a durable record, not a process or a script (reef-docs/05).
 * v1 runs exactly one agent; "add an agent" later is writing another record,
 * not new code.
 */
export interface AgentRecord {
  id: string;
  name: string;
  systemPrompt: string;
  /** Provider-routing model id (resolved by the vendored router). */
  model: string;
  /** Tool names this agent may call. Enforced as configuration, not by prompt. */
  toolAllowlist: string[];
  // memoryBinding, workspacePolicy — added when those seams land.
}

/**
 * Typed termination set (reef-docs/03: "errors are inputs, stop-reasons are
 * outputs"). Closed and named — never an open-coded scatter of `break`s.
 * reef-docs/10 explicitly leaves the exact membership open; this is the
 * proposed v1 set.
 */
export type StopReason =
  | "completed" // model finished and asked for nothing more (end_turn)
  | "max_steps" // per-run iteration ceiling hit — the non-convergence backstop
  | "budget_exhausted" // token/cost budget for the run (later: its graph) hit
  | "cancelled" // stopped from outside (user, daemon shutdown)
  | "awaiting_approval" // suspended pending an approval decision (resumable)
  | "awaiting_input" // suspended pending more input from a consumer (resumable)
  | "awaiting_subwork" // suspended pending spawned sub-work — reserved for the
  //                      future delegation graph (reef-docs/05); unused in v1
  | "error"; // an error the loop could not treat as an input terminated the run

/** Stop reasons that suspend a resumable run rather than end it (reef-docs/03). */
export const SUSPENDED_STOP_REASONS = [
  "awaiting_approval",
  "awaiting_input",
  "awaiting_subwork",
] as const satisfies readonly StopReason[];

export function isSuspended(reason: StopReason): boolean {
  return (SUSPENDED_STOP_REASONS as readonly StopReason[]).includes(reason);
}

export type RunStatus = "running" | "suspended" | "completed" | "failed";

/**
 * One execution episode of an agent — a single wake worked to a typed
 * termination. Conversation history spans runs within a session; a Run is the
 * unit of *work*, the session is the unit of *conversation*.
 */
export interface Run {
  id: string;
  agentId: string;
  sessionKey: string;
  status: RunStatus;
  stopReason?: StopReason;
  /** Reserved for the future delegation graph (reef-docs/05); unused in v1. */
  parentRunId?: string;
  startedAt: string; // ISO-8601
  endedAt?: string;
}

export type ApprovalStatus = "pending" | "allowed" | "denied";

/**
 * A durable record of a tool call awaiting (or having received) human approval.
 * Persisting these is what makes suspend-for-approval survive a daemon restart
 * (reef-docs/03 suspension; reef-docs/00 reliability-first).
 */
export interface Approval {
  id: string;
  runId: string;
  sessionKey: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: ApprovalStatus;
  /** The consumer's raw decision string (e.g. allow-once / allow-always / deny). */
  decision?: string;
  createdAt: string;
  decidedAt?: string;
}

/**
 * A durable compaction checkpoint (Phase 3c). When a session's assembled context
 * crosses a token threshold, the loop folds the oldest messages into a summary
 * and records it here. Compaction is a *view* over the immutable message log, not
 * a mutation of it: the canonical `messages` are never rewritten, so the full
 * history stays available for audit/replay and can be re-compacted differently.
 * The assembled context becomes `[summary] + messages where seq > throughSeq`.
 */
export interface Compaction {
  sessionKey: string;
  /** The highest message seq folded into this summary. */
  throughSeq: number;
  /** Prose standing in for every message up to and including throughSeq. */
  summary: string;
  createdAt: string;
}

/**
 * Why a run started (reef-docs/05). Interactive runs come from a user message;
 * Phase 4 adds proactive runs whose wake is a trigger. Carried on `run.started`
 * so consumers can tell agent-initiated work from a reply.
 */
export type RunSource =
  | { kind: "message" }
  | { kind: "trigger"; triggerId: string; triggerType: TriggerType };

/** A wake source beyond the inbound message (Phase 4). v1 ships `schedule`. */
export type TriggerType = "schedule";

/** When a trigger fires (Phase 4a). v1 ships cron and fixed interval. */
export type TriggerSpec =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "interval"; seconds: number };

/**
 * What to do with fires that were due while the daemon was down. `fire_once`
 * (the default) runs the single now-overdue occurrence on restart and advances;
 * `skip` drops missed fires silently. Bounded replay is a later opt-in.
 */
export type CatchUpPolicy = "fire_once" | "skip";

/**
 * A durable trigger record (Phase 4a) — like an agent or an approval, it
 * survives restart; the scheduler recomputes `nextFireAt` from it. A trigger
 * binds to one agent and one stable session, so a recurring routine is one
 * ongoing thread rather than a scatter of orphan runs.
 */
export interface Trigger {
  id: string;
  agentId: string;
  type: TriggerType;
  spec: TriggerSpec;
  /** Rendered into the synthetic wake message that starts the run. */
  input: string;
  /** Stable session for this trigger's runs (continuity across firings). */
  sessionKey: string;
  enabled: boolean;
  catchUpPolicy: CatchUpPolicy;
  /** ISO-8601 of the next due fire; absent once the schedule is exhausted. */
  nextFireAt?: string;
  lastFiredAt?: string;
  createdAt: string;
}

export type StepState = "pending" | "committed";

/**
 * The durable unit of progress (reef-docs/03). One row per loop iteration:
 * created `pending` before the model call, updated to `committed` once the call
 * and its tools have resolved. The next iteration begins only after the prior
 * step is durable. Recovery is the query "which steps were pending when we
 * died" — an exact answer, not a guess.
 *
 * The conversation is reconstructable from a run's committed steps: each step
 * contributes the assistant `response`, then the `toolResults` it produced.
 */
export interface Step {
  runId: string;
  index: number;
  state: StepState;
  /** Assistant output blocks produced this step (text/thinking/tool_use). */
  response?: ContentBlock[];
  /** tool_result blocks produced by running this step's tool calls. */
  toolResults?: ContentBlock[];
  usage?: Usage;
  startedAt: string;
  committedAt?: string;
}
