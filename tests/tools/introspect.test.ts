import { describe, expect, it } from "vitest";
import {
  currentModelTool,
  listRunsTool,
  listSessionsTool,
  listTriggersTool,
} from "../../src/tools/introspect.js";
import type { IntrospectionCapability } from "../../src/introspect/capability.js";
import type { Run, SessionSummary, Trigger } from "../../src/core/types.js";
import type { ToolContext } from "../../src/tools/types.js";

class FakeIntrospection implements IntrospectionCapability {
  lastRunStatus?: string;
  runs(opts: { status?: string } = {}): Run[] {
    this.lastRunStatus = opts.status;
    return [
      { id: "run_1", agentId: "reef", sessionKey: "s1", status: "completed", stopReason: "completed", startedAt: "t" },
    ];
  }
  sessions(): SessionSummary[] {
    return [
      { sessionKey: "s1", agentId: "reef", status: "idle", title: "hi", preview: "ok", pendingApprovals: 0, lastActivityAt: "t", createdAt: "t" },
    ];
  }
  triggers(): Trigger[] {
    return [
      { id: "trg_1", agentId: "reef", type: "schedule", spec: { kind: "interval", seconds: 60 }, input: "x", sessionKey: "k", createdBy: "agent", enabled: true, catchUpPolicy: "fire_once", createdAt: "t" },
    ];
  }
}

const ctx = (introspection?: IntrospectionCapability): ToolContext =>
  ({ fs: null as never, workspaceRoot: "/tmp", introspection }) as ToolContext;

describe("introspection tools", () => {
  it("list_runs returns concise runs and forwards the status filter", async () => {
    const fake = new FakeIntrospection();
    const out = (await listRunsTool.run({ status: "suspended" }, ctx(fake))) as { runs: unknown[] };
    expect(fake.lastRunStatus).toBe("suspended");
    expect(out.runs[0]).toMatchObject({ id: "run_1", status: "completed" });
  });

  it("list_sessions and list_triggers return their summaries", async () => {
    const fake = new FakeIntrospection();
    const s = (await listSessionsTool.run({}, ctx(fake))) as { sessions: unknown[] };
    expect(s.sessions[0]).toMatchObject({ sessionKey: "s1", title: "hi" });
    const t = (await listTriggersTool.run({}, ctx(fake))) as { triggers: unknown[] };
    expect(t.triggers[0]).toMatchObject({ id: "trg_1", type: "schedule", createdBy: "agent" });
  });

  it("throws without an introspection capability (loop reports it back)", async () => {
    await expect(listRunsTool.run({}, ctx())).rejects.toThrow(/without an introspection/);
  });

  it("current_model reports the run's effective model from context", async () => {
    const withModel = { fs: null as never, workspaceRoot: "/tmp", model: "ollama/llama3.1" } as ToolContext;
    expect(await currentModelTool.run({}, withModel)).toEqual({ model: "ollama/llama3.1" });
    expect(await currentModelTool.run({}, ctx())).toEqual({ model: "(unknown)" });
  });
});
