import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Spine } from "../../src/db/spine.js";
import { runAgentLoop } from "../../src/loop/AgentLoop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { BoundFs } from "../../src/fs/capability.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { ReefEventInit } from "../../src/protocol/events.js";
import type { Tool } from "../../src/tools/types.js";

class FakeRouter implements ModelRouter {
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const t = this.turns.shift();
    if (!t) throw new Error("out of turns");
    for (const b of t.content) if (b.type === "text") input.onTextDelta?.(b.text);
    return t;
  }
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-appr-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const agent: AgentRecord = {
  id: "a",
  name: "A",
  systemPrompt: "x",
  model: "fake",
  toolAllowlist: ["danger"],
};

function setup(turns: ModelTurn[]) {
  const dir = tempDir();
  const dbPath = join(dir, "reef.db");
  const spine = new Spine(dbPath);
  spine.upsertAgent(agent);
  spine.ensureSession("s1", agent.id);
  let ran = 0;
  const danger: Tool = {
    name: "danger",
    description: "a gated tool",
    needsApproval: true,
    inputSchema: z.object({}),
    async run() {
      ran += 1;
      return { ran: true };
    },
  };
  const tools = new ToolRegistry();
  tools.register(danger);
  const events: ReefEventInit[] = [];
  const deps = {
    spine,
    router: new FakeRouter(turns),
    tools,
    toolContext: { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") },
    emit: (e: ReefEventInit) => events.push(e),
  };
  return { dir, dbPath, spine, events, deps, ranCount: () => ran };
}

const gatedTurn: ModelTurn = {
  stop: "tool_use",
  content: [{ type: "tool_use", id: "g1", name: "danger", input: {} }],
  usage: { inputTokens: 7, outputTokens: 2 },
};
const doneTurn: ModelTurn = {
  stop: "completed",
  content: [{ type: "text", text: "done" }],
  usage: { inputTokens: 4, outputTokens: 1 },
};

describe("suspend-for-approval", () => {
  it("suspends on a gated tool and runs it on resume when allowed", async () => {
    const { spine, events, deps, ranCount } = setup([gatedTurn, doneTurn]);
    spine.appendMessage("s1", "user", [{ type: "text", text: "go" }]);
    const run = spine.createRun({ id: "run_g", agentId: agent.id, sessionKey: "s1" });

    const stop1 = await runAgentLoop(run, agent, deps);
    expect(stop1).toBe("awaiting_approval");
    expect(spine.getRun("run_g")?.status).toBe("suspended");
    expect(ranCount()).toBe(0); // not executed before approval
    const approvals = spine.getApprovalsForRun("run_g");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe("pending");
    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(events.some((e) => e.type === "run.suspended")).toBe(true);
    expect(spine.getMessages("s1").some((m) => m.role === "tool")).toBe(false);

    spine.resolveApproval(approvals[0]!.id, "allowed", "allow-once");
    const stop2 = await runAgentLoop({ ...run, status: "running" }, agent, deps, {
      resumeApproval: true,
    });
    expect(stop2).toBe("completed");
    expect(ranCount()).toBe(1);
    expect(spine.getMessages("s1").find((m) => m.role === "tool")?.content[0]).toMatchObject({
      type: "tool_result",
      output: { ran: true },
    });
    expect(spine.getRun("run_g")?.status).toBe("completed");
    spine.close();
  });

  it("feeds a denial back to the model instead of running the tool", async () => {
    const { spine, deps, ranCount } = setup([gatedTurn, doneTurn]);
    spine.appendMessage("s1", "user", [{ type: "text", text: "go" }]);
    const run = spine.createRun({ id: "run_d", agentId: agent.id, sessionKey: "s1" });

    await runAgentLoop(run, agent, deps);
    const approvals = spine.getApprovalsForRun("run_d");
    spine.resolveApproval(approvals[0]!.id, "denied", "deny");
    const stop2 = await runAgentLoop({ ...run, status: "running" }, agent, deps, {
      resumeApproval: true,
    });

    expect(stop2).toBe("completed");
    expect(ranCount()).toBe(0); // denied → never executed
    expect(spine.getMessages("s1").find((m) => m.role === "tool")?.content[0]).toMatchObject({
      isError: true,
    });
    spine.close();
  });

  it("a proactive run auto-denies a gated tool and completes instead of deadlocking", async () => {
    const { spine, events, deps, ranCount } = setup([gatedTurn, doneTurn]);
    spine.appendMessage("s1", "user", [{ type: "text", text: "scheduled wake" }]);
    const run = spine.createRun({ id: "run_pro", agentId: agent.id, sessionKey: "s1" });

    const stop = await runAgentLoop(run, agent, deps, {
      source: { kind: "trigger", triggerId: "trg_x", triggerType: "schedule" },
    });

    expect(stop).toBe("completed"); // not awaiting_approval — no deadlock
    expect(spine.getRun("run_pro")?.status).toBe("completed");
    expect(ranCount()).toBe(0); // the gated tool still never ran unattended
    expect(spine.getApprovalsForRun("run_pro")).toHaveLength(0); // no orphan approval
    expect(events.some((e) => e.type === "run.suspended")).toBe(false);
    // the model got an isError tool_result telling it to proceed without the tool
    const toolMsg = spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    expect((toolMsg?.content[0] as { output: string }).output).toMatch(/no human available/);
    spine.close();
  });

  it("keeps the suspension durable across a daemon restart", async () => {
    const { dbPath, spine, deps } = setup([gatedTurn, doneTurn]);
    spine.appendMessage("s1", "user", [{ type: "text", text: "go" }]);
    const run = spine.createRun({ id: "run_p", agentId: agent.id, sessionKey: "s1" });
    await runAgentLoop(run, agent, deps);
    spine.close(); // process dies while suspended

    // a fresh spine on the same file sees the suspension intact
    const reopened = new Spine(dbPath);
    expect(reopened.getRun("run_p")?.status).toBe("suspended");
    expect(reopened.getRun("run_p")?.stopReason).toBe("awaiting_approval");
    expect(reopened.getInterruptedRuns()).toEqual([]); // suspended ≠ crashed
    const approvals = reopened.getApprovalsForRun("run_p");
    expect(approvals[0]?.status).toBe("pending");
    // the model turn was persisted on the pending step so resume can replay it
    const pending = reopened.getSteps("run_p").find((s) => s.state === "pending");
    expect(pending?.response?.some((b) => b.type === "tool_use")).toBe(true);
    reopened.close();
  });
});
