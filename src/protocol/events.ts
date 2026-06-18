// Reef's native agentic protocol.
//
// This is the first-class event vocabulary reef emits — designed *for* agentic
// communication, not for a chat-app-shaped consumer. Consumers attach via
// adapters that PROJECT this stream onto their own surface (reef-docs decision:
// conch is the first consumer and a floor to extend, not a ceiling to conform
// to). The dev CLI consumes it directly.
//
// Every event carries the same envelope and is a discriminated union on `type`,
// so an adapter exhaustively handles the kinds it understands and forwards or
// drops the rest deliberately.

import type { ContentBlock, RunSource, StopReason, Usage } from "../core/types.js";

/** Mirrors conch's approval decisions so the projection is lossless. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"];

/**
 * Whitelist an untrusted decision string into the canonical vocabulary, failing
 * CLOSED: anything that isn't an exact, known decision becomes `deny`. The daemon
 * resolves approvals from the socket/HTTP wire where the decision is attacker- or
 * bug-controlled; an allow-by-default mapping (`x !== "deny" ? allow : deny`)
 * turned empty strings, mis-casing, and garbage into grants. Match exactly here.
 */
export function parseApprovalDecision(raw: string): ApprovalDecision {
  return (APPROVAL_DECISIONS as readonly string[]).includes(raw)
    ? (raw as ApprovalDecision)
    : "deny";
}

export interface EventEnvelope {
  /** Monotonic per-session sequence — lets a consumer detect gaps / reconnect. */
  seq: number;
  /** Epoch milliseconds the event was emitted. */
  ts: number;
  sessionKey: string;
  runId: string;
}

/**
 * The native event union. Richer than a Slack-shaped surface on purpose:
 * run/step structure, typed terminations, structured tool I/O, approvals, and
 * usage are all first-class. A conch adapter maps these down (and conch's
 * contract is extended where the mapping would otherwise lose fidelity —
 * step.committed, usage, the full StopReason set).
 */
export type ReefEvent = EventEnvelope &
  (
    // ── run & step lifecycle ───────────────────────────────────────────────
    | { type: "run.started"; agentId: string; model?: string; source?: RunSource }
    | { type: "step.started"; index: number }
    | { type: "step.committed"; index: number; usage?: Usage }
    | { type: "run.suspended"; stopReason: StopReason; detail?: unknown }
    | { type: "run.resumed" }
    | { type: "run.completed"; stopReason: StopReason }
    | { type: "run.failed"; error: string }
    // ── input & model output ─────────────────────────────────────────────────
    // The turn that started a run — a user message, or a trigger's seeded
    // instruction. Persisted so a session's transcript can be rebuilt on open
    // (the canonical user turn lives in `messages`, but the event log is what
    // consumers replay). conch drops it: it renders the user's own input.
    | { type: "message.received"; text: string; source?: RunSource }
    | { type: "message.delta"; text: string }
    | { type: "thinking.delta"; text: string }
    | { type: "message.completed"; content: ContentBlock[] }
    // ── tools ──────────────────────────────────────────────────────────────
    | {
        type: "tool.requested";
        toolUseId: string;
        name: string;
        input: unknown;
        needsApproval: boolean;
      }
    | { type: "tool.started"; toolUseId: string }
    | { type: "tool.completed"; toolUseId: string; output: unknown }
    | { type: "tool.failed"; toolUseId: string; error: string }
    // ── approvals (the suspend-for-approval surface, reef-docs/03 ⇄ conch) ───
    | {
        type: "approval.requested";
        approvalId: string;
        action: string;
        detail?: unknown;
      }
    | {
        type: "approval.resolved";
        approvalId: string;
        decision: ApprovalDecision;
      }
    // ── session control (out-of-run state changes) ──────────────────────────
    // A session's model was switched (e.g. the TUI `/model`). This is a
    // session-level setting, not part of any run, so it carries an empty runId.
    // Consumers fold it to update their view; the session's NEXT run reads the
    // new model (an in-flight run already chose its model at start).
    | { type: "session.model.changed"; model: string }
    // ── coding-agent control (external interactive sessions over a PTY) ───────
    // A session reef drives (Claude Code, etc.). Carried on a synthetic sessionKey
    // `coding:<id>` with an empty runId (the session is not a reef run), so it
    // surfaces in the sessions view and event log like any other session.
    | { type: "coding.session.started"; codingSessionId: string; agentKind: string; directory: string }
    | { type: "coding.output"; codingSessionId: string; text: string }
    | {
        type: "coding.prompt.detected";
        codingSessionId: string;
        promptText: string;
        options: { index: number; label: string }[];
      }
    | { type: "coding.session.completed"; codingSessionId: string; result?: string }
    // Handback: the agent finished this increment and is awaiting further input. The
    // session is parked `paused` (PTY torn down) but stays revivable via --resume —
    // increment-done, not permanently-done. Resumes the spawning manager run.
    | { type: "coding.session.paused"; codingSessionId: string; result?: string }
    | { type: "coding.session.failed"; codingSessionId: string; error: string }
    // ── context management (Phase 3c) ────────────────────────────────────────
    // Emitted when the loop folds older messages into a durable summary to stay
    // under the context window. First-class in the native stream; the conch
    // down-projection currently drops it (conch has no slot yet — see adapter).
    | {
        type: "context.compacted";
        /** Highest message seq now represented by the summary. */
        throughSeq: number;
        /** How many messages were folded into the summary this round. */
        foldedMessages: number;
      }
    // ── reserved for later phases ────────────────────────────────────────────
    // Declared now so the protocol advertises its full intent; emitters land
    // with the memory seam (reef-docs/07) and budget threading (reef-docs/03).
    | { type: "memory.recalled"; query?: string; resultCount: number; detail?: unknown }
    | { type: "memory.recorded"; ref?: string; summary?: string; detail?: unknown }
    | {
        type: "budget.warning";
        spent: Usage;
        remainingTokens?: number;
        remainingUsd?: number;
      }
  );

export type ReefEventType = ReefEvent["type"];

/** Narrowing helper for adapters. */
export function isEventType<T extends ReefEventType>(
  event: ReefEvent,
  type: T,
): event is Extract<ReefEvent, { type: T }> {
  return event.type === type;
}

// Distribute Omit across the union so each member keeps its own discriminated
// payload (a plain Omit would collapse the union).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** An event the emitter will stamp with seq + ts. */
export type ReefEventInit = DistributiveOmit<ReefEvent, "seq" | "ts">;

/** What the loop emits — the daemon's sink assigns seq/ts, persists, broadcasts. */
export type EmitFn = (event: ReefEventInit) => void;

/** The same, minus the envelope ids — a producer that already knows its run. */
export type ReefEventBody = DistributiveOmit<
  ReefEvent,
  "seq" | "ts" | "sessionKey" | "runId"
>;
