import { describe, expect, it } from "vitest";
import {
  initialState,
  pendingApprovals,
  pushNotice,
  pushUser,
  reduceEvent,
  type TranscriptItem,
  type TranscriptState,
} from "../../src/client/tui/transcript.js";
import type { ReefEvent } from "../../src/protocol/events.js";

/** Build a ReefEvent from a body, filling the envelope the reducer ignores. */
function ev(body: Record<string, unknown>): ReefEvent {
  return { seq: 1, ts: 0, sessionKey: "s", runId: "r", ...body } as ReefEvent;
}

/** Fold a sequence of events from the initial state. */
function run(...events: ReefEvent[]): TranscriptState {
  return events.reduce(reduceEvent, initialState);
}

const kinds = (s: TranscriptState): string[] => s.items.map((i) => i.kind);
const lastOf = <K extends TranscriptItem["kind"]>(s: TranscriptState, kind: K) =>
  [...s.items].reverse().find((i) => i.kind === kind) as Extract<TranscriptItem, { kind: K }>;

describe("transcript reducer", () => {
  it("coalesces message deltas into one streaming assistant item, then finalizes", () => {
    const s = run(
      ev({ type: "run.started", agentId: "reef" }),
      ev({ type: "message.delta", text: "Hel" }),
      ev({ type: "message.delta", text: "lo" }),
    );
    expect(s.status).toBe("working");
    const a = lastOf(s, "assistant");
    expect(a).toMatchObject({ text: "Hello", streaming: true });

    const done = reduceEvent(s, ev({ type: "run.completed", stopReason: "completed" }));
    expect(done.status).toBe("idle");
    expect(lastOf(done, "assistant").streaming).toBe(false);
  });

  it("tracks a tool through requested → running → completed", () => {
    const s = run(
      ev({ type: "tool.requested", toolUseId: "t1", name: "echo", input: { m: "hi" }, needsApproval: false }),
      ev({ type: "tool.started", toolUseId: "t1" }),
      ev({ type: "tool.completed", toolUseId: "t1", output: { echoed: "hi" } }),
    );
    expect(lastOf(s, "tool")).toMatchObject({ status: "ok", output: { echoed: "hi" } });
  });

  it("marks a failed tool with its error", () => {
    const s = run(
      ev({ type: "tool.requested", toolUseId: "t1", name: "boom", input: {}, needsApproval: false }),
      ev({ type: "tool.failed", toolUseId: "t1", error: "nope" }),
    );
    expect(lastOf(s, "tool")).toMatchObject({ status: "error", error: "nope" });
  });

  it("surfaces a pending approval and resolves it", () => {
    let s = run(ev({ type: "approval.requested", approvalId: "a1", action: "shell(...)", detail: {} }));
    expect(pendingApprovals(s)).toHaveLength(1);

    s = reduceEvent(s, ev({ type: "run.suspended", stopReason: "awaiting_approval" }));
    expect(s.status).toBe("awaiting_approval");

    s = reduceEvent(s, ev({ type: "approval.resolved", approvalId: "a1", decision: "deny" }));
    expect(pendingApprovals(s)).toHaveLength(0);
    expect(lastOf(s, "approval").status).toBe("denied");
  });

  it("accumulates usage across committed steps", () => {
    const s = run(
      ev({ type: "step.committed", index: 0, usage: { inputTokens: 10, outputTokens: 4 } }),
      ev({ type: "step.committed", index: 1, usage: { inputTokens: 5, outputTokens: 2 } }),
    );
    expect(s.usage).toEqual({ inputTokens: 15, outputTokens: 6 });
  });

  it("renders a notice on compaction and a proactive run, and an error on failure", () => {
    const compacted = reduceEvent(initialState, ev({ type: "context.compacted", throughSeq: 3, foldedMessages: 4 }));
    expect(lastOf(compacted, "notice").text).toMatch(/compacted 4/);

    const triggered = reduceEvent(
      initialState,
      ev({ type: "run.started", agentId: "reef", source: { kind: "trigger", triggerId: "x", triggerType: "schedule" } }),
    );
    expect(kinds(triggered)).toContain("notice");

    const failed = reduceEvent(initialState, ev({ type: "run.failed", error: "kaboom" }));
    expect(lastOf(failed, "error").text).toBe("kaboom");
    expect(failed.status).toBe("idle");
  });

  it("supports local user + notice items", () => {
    const s = pushNotice(pushUser(initialState, "hi reef"), "a note");
    expect(kinds(s)).toEqual(["user", "notice"]);
    expect(s.items.map((i) => i.id)).toEqual([1, 2]); // monotonic ids
  });
});
