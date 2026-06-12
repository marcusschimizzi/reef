import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Spine } from "../../src/db/spine.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runAgentLoop } from "../../src/loop/AgentLoop.js";
import { BoundFs } from "../../src/fs/capability.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ReefEventInit } from "../../src/protocol/events.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-sw-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scripted ModelRouter — returns canned turns. */
class FakeRouter implements ModelRouter {
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeRouter: no scripted turn left");
    for (const b of turn.content) {
      if (b.type === "text") input.onTextDelta?.(b.text);
    }
    return turn;
  }
}

const agent: AgentRecord = {
  id: "agent_1",
  name: "a",
  systemPrompt: "s",
  model: "m",
  toolAllowlist: ["start_coding_session"],
};

const TOOL_USE = {
  type: "tool_use" as const,
  id: "tool_1",
  name: "start_coding_session",
  input: { directory: "/tmp/x", task: "go" },
};

function harness(opts: { needsApproval?: boolean } = {}) {
  const dir = tempDir();
  const spine = new Spine(join(dir, "reef.db"));
  spine.upsertAgent(agent);
  spine.ensureSession("s1", agent.id);
  spine.appendMessage("s1", "user", [{ type: "text", text: "start work" }]);
  const run = spine.createRun({ id: "run_1", agentId: agent.id, sessionKey: "s1" });
  const tools = new ToolRegistry();
  tools.register({
    name: "start_coding_session",
    description: "d",
    inputSchema: z.object({ directory: z.string(), task: z.string() }),
    suspendsForSubwork: true,
    needsApproval: opts.needsApproval ?? false,
    run: async () => {
      throw new Error("should not run");
    },
  });
  const events: ReefEventInit[] = [];
  const emit = (e: ReefEventInit) => events.push(e);
  return { dir, spine, run, tools, events, emit };
}

function fakeRouter(turns: Array<{ content: ModelTurn["content"]; stop: ModelTurn["stop"] }>): FakeRouter {
  return new FakeRouter(
    turns.map((t) => ({ ...t, usage: { inputTokens: 1, outputTokens: 1 } })),
  );
}

describe("awaiting_subwork suspend", () => {
  it("a suspendsForSubwork tool starts subwork and suspends instead of running", async () => {
    const { dir, spine, run, tools, events, emit } = harness();
    let started: string | undefined;
    const stop = await runAgentLoop(run, spine.getAgent("agent_1")!, {
      spine,
      router: new FakeRouter([{ content: [TOOL_USE], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }]),
      tools,
      toolContext: { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") },
      emit,
      startSubwork: async (_r, call) => {
        started = call.id;
        return "cs_1";
      },
      collectSubwork: () => undefined,
    });
    expect(stop).toBe("awaiting_subwork");
    expect(started).toBe("tool_1");
    expect(spine.getRun("run_1")!.status).toBe("suspended");
    expect(spine.getRun("run_1")!.stopReason).toBe("awaiting_subwork");
    expect(events.some((e) => e.type === "run.suspended")).toBe(true);
    spine.close();
  });

  it("resume with a completed subwork commits its result as the tool_result", async () => {
    const { dir, spine, run, tools, emit } = harness();
    const toolContext = { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") };

    // First pass: suspend.
    await runAgentLoop(run, spine.getAgent("agent_1")!, {
      spine,
      router: fakeRouter([{ content: [TOOL_USE], stop: "tool_use" }]),
      tools,
      toolContext,
      emit,
      startSubwork: async () => "cs_1",
      collectSubwork: () => undefined,
    });
    expect(spine.getRun("run_1")!.stopReason).toBe("awaiting_subwork");

    // Resume: subwork completed.
    spine.setRunStatus("run_1", "running");
    const stop = await runAgentLoop(
      { ...spine.getRun("run_1")!, status: "running" },
      spine.getAgent("agent_1")!,
      {
        spine,
        router: fakeRouter([{ content: [{ type: "text", text: "all done" }], stop: "end_turn" }]),
        tools,
        toolContext,
        emit,
        startSubwork: async () => {
          throw new Error("must not restart");
        },
        collectSubwork: (runId, toolUseId) =>
          runId === "run_1" && toolUseId === "tool_1" ? { result: "session result text" } : undefined,
      },
      { resumeApproval: true },
    );

    expect(stop).toBe("completed");
    const ctx = spine.getContext("s1");
    const toolMsg = ctx.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("session result text");
    spine.close();
  });

  it("a denied gated subwork does NOT start the session", async () => {
    const { dir, spine, run, tools, events, emit } = harness({ needsApproval: true });
    const toolContext = { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") };
    let started = false;

    // First pass: the tool needs approval, so the run gates.
    const gateStop = await runAgentLoop(run, spine.getAgent("agent_1")!, {
      spine,
      router: fakeRouter([{ content: [TOOL_USE], stop: "tool_use" }]),
      tools,
      toolContext,
      emit,
      startSubwork: async () => {
        started = true;
        return "cs_1";
      },
      collectSubwork: () => undefined,
    });
    expect(gateStop).toBe("awaiting_approval");
    expect(started).toBe(false);

    // The human denies.
    const approval = spine.getApprovalsForRun("run_1").find((a) => a.toolUseId === "tool_1");
    expect(approval).toBeDefined();
    spine.resolveApproval(approval!.id, "denied", "deny");

    // Resume after denial: must NOT start the session and must NOT re-suspend.
    spine.setRunStatus("run_1", "running");
    const stop = await runAgentLoop(
      { ...spine.getRun("run_1")!, status: "running" },
      spine.getAgent("agent_1")!,
      {
        spine,
        router: fakeRouter([{ content: [{ type: "text", text: "ok, stopping" }], stop: "end_turn" }]),
        tools,
        toolContext,
        emit,
        startSubwork: async () => {
          throw new Error("must not start a denied session");
        },
        collectSubwork: () => undefined,
      },
      { resumeApproval: true },
    );

    expect(started).toBe(false);
    expect(stop).not.toBe("awaiting_subwork");
    expect(stop).toBe("completed");

    // The committed tool_result for the subwork tool is the denial (isError).
    const ctx = spine.getContext("s1");
    const toolMsg = ctx.find((m) => m.role === "tool");
    const blocks = toolMsg!.content as Array<{ toolUseId?: string; output?: string; isError?: boolean }>;
    const denied = blocks.find((b) => b.toolUseId === "tool_1");
    expect(denied?.isError).toBe(true);
    expect(denied?.output).toContain("denied");
    spine.close();
  });

  it("a multi-tool turn does NOT suspend for subwork (falls through)", async () => {
    const { dir, spine, run, tools, emit } = harness();
    tools.register({
      name: "echo",
      description: "d",
      inputSchema: z.object({ msg: z.string() }),
      needsApproval: false,
      run: async (input) => `echo: ${(input as { msg: string }).msg}`,
    });
    const toolContext = { fs: new BoundFs(join(dir, "ws")), workspaceRoot: join(dir, "ws") };

    const stop = await runAgentLoop(
      { ...run, agentId: agent.id },
      { ...spine.getAgent("agent_1")!, toolAllowlist: ["start_coding_session", "echo"] },
      {
        spine,
        router: fakeRouter([
          {
            content: [
              TOOL_USE,
              { type: "tool_use", id: "tool_2", name: "echo", input: { msg: "hi" } },
            ],
            stop: "tool_use",
          },
          { content: [{ type: "text", text: "done" }], stop: "end_turn" },
        ]),
        tools,
        toolContext,
        emit,
        startSubwork: async () => {
          throw new Error("must not start subwork for a multi-tool turn");
        },
        collectSubwork: () => undefined,
      },
    );

    // It fell through to executeTools: the subwork tool's run() throws (clean
    // error result), echo runs normally — no awaiting_subwork suspension.
    expect(stop).not.toBe("awaiting_subwork");
    const ctx = spine.getContext("s1");
    expect(JSON.stringify(ctx)).toContain("echo: hi");
    spine.close();
  });
});
