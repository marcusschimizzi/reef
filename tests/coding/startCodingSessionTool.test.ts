import { describe, expect, it } from "vitest";
import { startCodingSession, codingTools } from "../../src/tools/coding.js";

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
