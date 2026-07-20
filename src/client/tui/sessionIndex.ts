import type { ReefEvent } from "../../protocol/events.js";
import type { SessionStatus, SessionSummary } from "../../core/types.js";
import { textOf } from "./transcript.js";

// The sessions view's data model — a pure fold of the daemon's session snapshot
// plus the live native event stream into a keyed index of SessionSummary. Kept
// framework-free and pure (like transcript.ts) so the status/preview/approval
// logic is directly unit-testable; the Ink layer just renders the ordered view.
//
// Two inputs combine: `seedSessions` merges an authoritative snapshot (titles,
// previews, historical sessions the live stream never replayed), and
// `indexEvent` keeps status/approvals/preview fresh as events arrive — so the
// list updates live with no polling.

export type SessionIndex = Record<string, SessionSummary>;

export const emptyIndex: SessionIndex = {};

/** Merge a daemon snapshot in. The snapshot is authoritative for title/preview
 *  (the live stream carries no user-message events to derive a title from). */
export function seedSessions(index: SessionIndex, sessions: SessionSummary[]): SessionIndex {
  const next: SessionIndex = { ...index };
  for (const s of sessions) next[s.sessionKey] = { ...next[s.sessionKey], ...s };
  return next;
}

/** Fold one live event into the index (status, approvals, preview, activity). */
export function indexEvent(index: SessionIndex, event: ReefEvent): SessionIndex {
  const prev = index[event.sessionKey] ?? stub(event.sessionKey);
  const at = new Date(event.ts).toISOString();
  switch (event.type) {
    case "message.received":
      // Gives a brand-new session a real title before any snapshot arrives;
      // a snapshot's authoritative title still wins (we only fill a stub).
      return put(index, {
        ...prev,
        title: prev.title && prev.title !== prev.sessionKey ? prev.title : event.text,
        lastActivityAt: at,
      });
    case "run.started":
      return put(index, {
        ...prev,
        agentId: event.agentId,
        model: event.model ?? prev.model,
        status: "working",
        lastActivityAt: at,
      });
    case "message.queued":
      // A send parked behind a suspended run — surface it in the list so the
      // message doesn't look dropped while it waits.
      return put(index, { ...prev, preview: `queued: ${event.text}`, lastActivityAt: at });
    case "session.model.changed":
      // a `/model` switch — reflect the new model in the list/header immediately
      return put(index, { ...prev, model: event.model });
    case "run.resumed":
      return put(index, { ...prev, status: "working", lastActivityAt: at });
    case "run.suspended":
      return put(index, { ...prev, status: "awaiting_approval", lastActivityAt: at });
    case "run.completed":
      return put(index, { ...prev, status: "idle", lastActivityAt: at });
    case "run.failed":
      return put(index, { ...prev, status: "failed", preview: event.error || prev.preview, lastActivityAt: at });
    case "approval.requested":
      return put(index, {
        ...prev,
        status: "awaiting_approval",
        pendingApprovals: prev.pendingApprovals + 1,
        // first pending id drives approve-from-list; keep the oldest.
        pendingApprovalId: prev.pendingApprovalId ?? event.approvalId,
        lastActivityAt: at,
      });
    case "approval.resolved": {
      const pendingApprovals = Math.max(0, prev.pendingApprovals - 1);
      return put(index, {
        ...prev,
        pendingApprovals,
        // best-effort: the snapshot re-seeds the exact next id on list refresh.
        pendingApprovalId: pendingApprovals === 0 ? undefined : prev.pendingApprovalId,
        lastActivityAt: at,
      });
    }
    case "message.completed": {
      const text = textOf(event.content);
      return put(index, { ...prev, preview: text || prev.preview, lastActivityAt: at });
    }
    default:
      return index; // an event we don't surface in the list → no change
  }
}

// Awaiting-approval first (it needs a human), then working, then settled.
const ORDER: SessionStatus[] = ["awaiting_approval", "working", "idle", "failed"];

export const STATUS_LABEL: Record<SessionStatus, string> = {
  awaiting_approval: "AWAITING APPROVAL",
  working: "WORKING",
  idle: "IDLE",
  failed: "FAILED",
};

/** Flat list ordered by status group, then most-recent-activity within a group. */
export function orderedSessions(index: SessionIndex): SessionSummary[] {
  return Object.values(index).sort((a, b) => {
    const g = ORDER.indexOf(a.status) - ORDER.indexOf(b.status);
    if (g !== 0) return g;
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  });
}

/** Counts per status — for the header summary line. */
export function statusCounts(index: SessionIndex): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    awaiting_approval: 0,
    working: 0,
    idle: 0,
    failed: 0,
  };
  for (const s of Object.values(index)) counts[s.status] += 1;
  return counts;
}

function put(index: SessionIndex, s: SessionSummary): SessionIndex {
  return { ...index, [s.sessionKey]: s };
}

function stub(sessionKey: string): SessionSummary {
  return {
    sessionKey,
    agentId: "?",
    status: "idle",
    title: sessionKey,
    preview: "",
    pendingApprovals: 0,
    lastActivityAt: "",
    createdAt: "",
  };
}
