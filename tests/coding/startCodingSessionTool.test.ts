import { describe, expect, it } from "vitest";
import { startCodingSession, sendFeedback, codingTools } from "../../src/tools/coding.js";

describe("start_coding_session tool", () => {
  it("is registered with the subwork + approval flags and a directory/task schema", () => {
    expect(startCodingSession.name).toBe("start_coding_session");
    expect(startCodingSession.suspendsForSubwork).toBe(true);
    expect(startCodingSession.needsApproval).toBe(true);
    expect(startCodingSession.inputSchema.safeParse({ directory: "/tmp/x", task: "go" }).success).toBe(true);
    expect(startCodingSession.inputSchema.safeParse({ task: "go" }).success).toBe(false);
    expect(codingTools).toContain(startCodingSession);
  });

  it("run() throws — the loop handles subwork, the tool body is never reached", async () => {
    await expect(startCodingSession.run({ directory: "/tmp/x", task: "go" }, {} as never)).rejects.toThrow();
  });
});

describe("send_feedback tool", () => {
  it("is registered, suspendsForSubwork, NOT gated, with a sessionId/text schema", () => {
    expect(sendFeedback.name).toBe("send_feedback");
    expect(sendFeedback.suspendsForSubwork).toBe(true);
    expect(sendFeedback.needsApproval).toBe(false);
    expect(sendFeedback.inputSchema.safeParse({ sessionId: "cs_1", text: "next" }).success).toBe(true);
    expect(sendFeedback.inputSchema.safeParse({ text: "next" }).success).toBe(false);
    expect(codingTools).toContain(sendFeedback);
  });

  it("run() throws — loop-handled", async () => {
    await expect(sendFeedback.run({ sessionId: "cs_1", text: "x" }, {} as never)).rejects.toThrow();
  });
});
