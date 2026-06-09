import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { runAgentLoop } from "../../src/loop/AgentLoop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { builtinTools } from "../../src/tools/builtins.js";
import { BoundFs } from "../../src/fs/capability.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ReefEventInit } from "../../src/protocol/events.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-loop-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scripted ModelRouter — returns canned turns and records what it was sent. */
class FakeRouter implements ModelRouter {
  calls: ModelTurnInput[] = [];
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    this.calls.push(input);
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeRouter: no scripted turn left");
    for (const b of turn.content) {
      if (b.type === "text") input.onTextDelta?.(b.text);
    }
    return turn;
  }
}

const agent: AgentRecord = {
  id: "agent_test",
  name: "Test",
  systemPrompt: "be helpful",
  model: "fake-model",
  toolAllowlist: ["echo", "get_time"],
};

function setup(turns: ModelTurn[]) {
  const dir = tempDir();
  const spine = new Spine(join(dir, "reef.db"));
  spine.upsertAgent(agent);
  spine.ensureSession("s1", agent.id);
  const tools = new ToolRegistry();
  for (const t of builtinTools) tools.register(t);
  const events: ReefEventInit[] = [];
  const router = new FakeRouter(turns);
  const deps = {
    spine,
    router,
    tools,
    toolContext: { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") },
    emit: (e: ReefEventInit) => events.push(e),
  };
  return { spine, router, events, deps };
}

describe("runAgentLoop", () => {
  it("runs a tool then completes, feeding the result back to the model", async () => {
    const { spine, router, events, deps } = setup([
      {
        stop: "tool_use",
        content: [
          { type: "text", text: "Echoing." },
          { type: "tool_use", id: "t1", name: "echo", input: { message: "hi" } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      {
        stop: "completed",
        content: [{ type: "text", text: "Done: hi" }],
        usage: { inputTokens: 20, outputTokens: 3 },
      },
    ]);

    spine.appendMessage("s1", "user", [{ type: "text", text: "echo hi" }]);
    const run = spine.createRun({
      id: "run_1",
      agentId: agent.id,
      sessionKey: "s1",
    });

    const stop = await runAgentLoop(run, agent, deps);
    expect(stop).toBe("completed");

    // conversation: user, assistant(turn1), tool(result), assistant(turn2)
    const convo = spine.getMessages("s1");
    expect(convo.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(convo[2]?.content).toEqual([
      { type: "tool_result", toolUseId: "t1", output: { echoed: "hi" } },
    ]);

    // the tool result was actually sent back to the model on the 2nd turn
    const secondCallMessages = router.calls[1]?.messages ?? [];
    const sawToolResult = secondCallMessages.some((m) =>
      m.content.some((b) => b.type === "tool_result"),
    );
    expect(sawToolResult).toBe(true);

    // durable trail: two committed steps, run completed
    const steps = spine.getSteps("run_1");
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.state === "committed")).toBe(true);
    expect(spine.getRun("run_1")?.status).toBe("completed");
    expect(spine.getInterruptedRuns()).toEqual([]);

    // event stream carried the tool round-trip and the terminations
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("tool.completed");
    expect(types.filter((t) => t === "step.committed")).toHaveLength(2);
    expect(types.at(-1)).toBe("run.completed");

    const toolCompleted = events.find((e) => e.type === "tool.completed");
    expect(toolCompleted).toMatchObject({ output: { echoed: "hi" } });
    spine.close();
  });

  it("treats a tool error as an input, not a run failure", async () => {
    const { spine, events, deps } = setup([
      {
        stop: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "nonexistent", input: {} },
        ],
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      {
        stop: "completed",
        content: [{ type: "text", text: "recovered" }],
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    ]);

    spine.appendMessage("s1", "user", [{ type: "text", text: "use a bad tool" }]);
    const run = spine.createRun({ id: "run_e", agentId: agent.id, sessionKey: "s1" });

    const stop = await runAgentLoop(run, agent, deps);
    expect(stop).toBe("completed"); // the run did not fail
    expect(events.map((e) => e.type)).toContain("tool.failed");

    const toolMsg = spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    spine.close();
  });

  it("stops at the max_steps ceiling", async () => {
    // every turn asks for a tool → never converges; ceiling must catch it
    const loopingTurn: ModelTurn = {
      stop: "tool_use",
      content: [{ type: "tool_use", id: "t", name: "get_time", input: {} }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const { spine, deps } = setup(Array.from({ length: 10 }, () => ({ ...loopingTurn })));
    spine.appendMessage("s1", "user", [{ type: "text", text: "loop forever" }]);
    const run = spine.createRun({ id: "run_m", agentId: agent.id, sessionKey: "s1" });

    const stop = await runAgentLoop(run, agent, { ...deps, maxSteps: 3 });
    expect(stop).toBe("max_steps");
    expect(spine.getSteps("run_m")).toHaveLength(3);
    spine.close();
  });
});
