import { describe, expect, it } from "vitest";
import {
  emptyIndex,
  indexEvent,
  orderedSessions,
  seedSessions,
  statusCounts,
} from "../../src/client/tui/sessionIndex.js";
import type { SessionSummary } from "../../src/core/types.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const ev = (body: Partial<ReefEvent> & { type: ReefEvent["type"]; sessionKey: string }): ReefEvent =>
  ({ seq: 1, ts: Date.parse("2026-06-11T12:00:00Z"), runId: "r", ...body }) as ReefEvent;

const summary = (over: Partial<SessionSummary> & { sessionKey: string }): SessionSummary => ({
  agentId: "reef",
  status: "idle",
  title: "t",
  preview: "p",
  pendingApprovals: 0,
  lastActivityAt: "2026-06-10T00:00:00Z",
  createdAt: "2026-06-10T00:00:00Z",
  ...over,
});

describe("sessionIndex", () => {
  it("message.queued bumps activity and shows a queued preview so the send is visible in the list", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1", lastActivityAt: "2026-06-10T00:00:00Z" })]);
    idx = indexEvent(idx, ev({ type: "message.queued", sessionKey: "s1", text: "also, use bun please" }));
    expect(idx.s1?.lastActivityAt).toBe(new Date(Date.parse("2026-06-11T12:00:00Z")).toISOString());
    expect(idx.s1?.preview).toContain("also, use bun please");
  });

  it("seeds from a snapshot and lets later snapshots win for title/preview", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1", title: "first" })]);
    expect(idx.s1?.title).toBe("first");
    idx = seedSessions(idx, [summary({ sessionKey: "s1", title: "renamed", preview: "newer" })]);
    expect(idx.s1).toMatchObject({ title: "renamed", preview: "newer" });
  });

  it("folds run lifecycle into a live status", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1" })]);
    idx = indexEvent(idx, ev({ type: "run.started", sessionKey: "s1", agentId: "reef" }));
    expect(idx.s1?.status).toBe("working");
    idx = indexEvent(idx, ev({ type: "run.completed", sessionKey: "s1", stopReason: "completed" }));
    expect(idx.s1?.status).toBe("idle");
    idx = indexEvent(idx, ev({ type: "run.failed", sessionKey: "s1", error: "boom" }));
    expect(idx.s1).toMatchObject({ status: "failed", preview: "boom" });
  });

  it("folds a /model switch into the session's model immediately", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1", model: "anthropic/claude-opus-4-8" })]);
    idx = indexEvent(idx, ev({ type: "session.model.changed", sessionKey: "s1", model: "openai/gpt-4o" }));
    expect(idx.s1?.model).toBe("openai/gpt-4o");
  });

  it("tracks pending approvals and the oldest pending id", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1" })]);
    idx = indexEvent(idx, ev({ type: "approval.requested", sessionKey: "s1", approvalId: "a1", action: "shell(...)" }));
    idx = indexEvent(idx, ev({ type: "approval.requested", sessionKey: "s1", approvalId: "a2", action: "shell(...)" }));
    expect(idx.s1).toMatchObject({ status: "awaiting_approval", pendingApprovals: 2, pendingApprovalId: "a1" });

    idx = indexEvent(idx, ev({ type: "approval.resolved", sessionKey: "s1", approvalId: "a1", decision: "allow-once" }));
    expect(idx.s1?.pendingApprovals).toBe(1);
    idx = indexEvent(idx, ev({ type: "approval.resolved", sessionKey: "s1", approvalId: "a2", decision: "deny" }));
    expect(idx.s1).toMatchObject({ pendingApprovals: 0, pendingApprovalId: undefined });
  });

  it("captures the model from run.started", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1" })]);
    idx = indexEvent(idx, ev({ type: "run.started", sessionKey: "s1", agentId: "reef", model: "ollama/llama3.1" }));
    expect(idx.s1?.model).toBe("ollama/llama3.1");
  });

  it("updates the preview from a completed assistant message", () => {
    let idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1", preview: "old" })]);
    idx = indexEvent(idx, ev({ type: "message.completed", sessionKey: "s1", content: [{ type: "text", text: "the latest reply" }] }));
    expect(idx.s1?.preview).toBe("the latest reply");
  });

  it("creates a stub for an event on a session not yet seeded", () => {
    const idx = indexEvent(emptyIndex, ev({ type: "run.started", sessionKey: "ghost", agentId: "reef" }));
    expect(idx.ghost).toMatchObject({ sessionKey: "ghost", agentId: "reef", status: "working" });
  });

  it("ignores events it doesn't surface (no needless churn)", () => {
    const idx = seedSessions(emptyIndex, [summary({ sessionKey: "s1" })]);
    expect(indexEvent(idx, ev({ type: "message.delta", sessionKey: "s1", text: "x" }))).toBe(idx);
  });

  it("orders awaiting-approval first, then working, then settled by recency", () => {
    const idx = seedSessions(emptyIndex, [
      summary({ sessionKey: "idle-old", status: "idle", lastActivityAt: "2026-06-10T01:00:00Z" }),
      summary({ sessionKey: "idle-new", status: "idle", lastActivityAt: "2026-06-10T09:00:00Z" }),
      summary({ sessionKey: "working", status: "working" }),
      summary({ sessionKey: "awaiting", status: "awaiting_approval" }),
    ]);
    expect(orderedSessions(idx).map((s) => s.sessionKey)).toEqual([
      "awaiting",
      "working",
      "idle-new",
      "idle-old",
    ]);
  });

  it("counts sessions by status", () => {
    const idx = seedSessions(emptyIndex, [
      summary({ sessionKey: "a", status: "awaiting_approval" }),
      summary({ sessionKey: "w", status: "working" }),
      summary({ sessionKey: "i", status: "idle" }),
    ]);
    expect(statusCounts(idx)).toMatchObject({ awaiting_approval: 1, working: 1, idle: 1, failed: 0 });
  });
});
