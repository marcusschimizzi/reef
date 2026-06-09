import { describe, expect, it } from "vitest";
import { ConchProjector } from "../../src/interface/adapters/conch.js";
import type { ReefEvent, ReefEventInit } from "../../src/protocol/events.js";

let seq = 0;
function ev(init: ReefEventInit): ReefEvent {
  return { ...init, seq: ++seq, ts: 1_700_000_000_000 } as ReefEvent;
}
const base = { sessionKey: "reef:a:1", runId: "run_1" };

describe("ConchProjector", () => {
  it("projects a streamed tool turn onto conch frames", () => {
    const p = new ConchProjector();
    const frames = [
      ...p.project(ev({ ...base, type: "run.started", agentId: "a" })),
      ...p.project(ev({ ...base, type: "message.delta", text: "Hel" })),
      ...p.project(ev({ ...base, type: "message.delta", text: "lo" })),
      ...p.project(ev({ ...base, type: "tool.requested", toolUseId: "t1", name: "echo", input: { m: 1 }, needsApproval: false })),
      ...p.project(ev({ ...base, type: "tool.completed", toolUseId: "t1", output: { echoed: 1 } })),
      ...p.project(ev({ ...base, type: "run.completed", stopReason: "completed" })),
    ];

    const types = frames.map((f) => f.eventType);
    expect(types).toEqual([
      "typing:start",
      "agent", // assistant delta 1
      "agent", // assistant delta 2
      "agent", // tool
      "agent", // tool_result
      "agent", // lifecycle
      "typing:stop",
    ]);

    // assistant deltas accumulate cumulative text
    const assistant = frames
      .map((f) => f.data as { stream?: string; data?: Record<string, unknown> })
      .filter((d) => d.stream === "assistant");
    expect(assistant[0]?.data).toEqual({ delta: "Hel", text: "Hel" });
    expect(assistant[1]?.data).toEqual({ delta: "lo", text: "Hello" });

    // tool + tool_result carry structured i/o
    const tool = (frames[3]!.data as { stream: string; data: Record<string, unknown> });
    expect(tool.stream).toBe("tool");
    expect(tool.data).toMatchObject({ name: "echo", toolUseId: "t1" });
    const toolResult = (frames[4]!.data as { stream: string; data: Record<string, unknown> });
    expect(toolResult.stream).toBe("tool_result");
    expect(toolResult.data).toMatchObject({ toolUseId: "t1", output: { echoed: 1 } });

    // lifecycle carries reef's stopReason (richer than conch's bare 'completed')
    const lifecycle = (frames[5]!.data as { stream: string; data: Record<string, unknown> });
    expect(lifecycle.stream).toBe("lifecycle");
    expect(lifecycle.data).toMatchObject({ status: "completed", stopReason: "completed" });
  });

  it("maps approval.requested to conch's exec.approval.requested", () => {
    const p = new ConchProjector();
    const [frame] = p.project(
      ev({ ...base, type: "approval.requested", approvalId: "apr_1", action: "run shell: rm -rf /" }),
    );
    expect(frame?.eventType).toBe("exec.approval.requested");
    expect(frame?.data).toMatchObject({ id: "apr_1", sessionKey: "reef:a:1", command: "run shell: rm -rf /" });
  });

  it("maps a run failure to the error stream", () => {
    const p = new ConchProjector();
    p.project(ev({ ...base, type: "run.started", agentId: "a" }));
    const frames = p.project(ev({ ...base, type: "run.failed", error: "boom" }));
    expect(frames.map((f) => f.eventType)).toEqual(["agent", "typing:stop"]);
    expect((frames[0]!.data as { stream: string }).stream).toBe("error");
  });

  it("drops events conch has no slot for yet (no silent leakage)", () => {
    const p = new ConchProjector();
    expect(p.project(ev({ ...base, type: "step.committed", index: 0 }))).toEqual([]);
    expect(p.project(ev({ ...base, type: "budget.warning", spent: { inputTokens: 1, outputTokens: 1 } }))).toEqual([]);
  });
});
