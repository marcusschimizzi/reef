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

function harness() {
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
    needsApproval: false,
    run: async () => {
      throw new Error("should not run");
    },
  });
  const events: ReefEventInit[] = [];
  const emit = (e: ReefEventInit) => events.push(e);
  return { dir, spine, run, tools, events, emit };
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
});
