import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import { Spine } from "../../src/db/spine.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-daemon-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class FakeRouter implements ModelRouter {
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeRouter: out of turns");
    for (const b of turn.content) if (b.type === "text") input.onTextDelta?.(b.text);
    return turn;
  }
}

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "be helpful",
  model: "fake",
  toolAllowlist: ["echo", "get_time"],
};

describe("Daemon", () => {
  it("processes a wake: runs the loop, streams events, persists the conversation", async () => {
    const dir = tempDir();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        {
          stop: "tool_use",
          content: [
            { type: "tool_use", id: "t1", name: "echo", input: { message: "hi" } },
          ],
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        {
          stop: "completed",
          content: [{ type: "text", text: "echoed hi" }],
          usage: { inputTokens: 8, outputTokens: 2 },
        },
      ]),
    });
    daemon.registerAgent(agent);

    const events: ReefEvent[] = [];
    daemon.subscribe((e) => events.push(e));

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "echo hi" });

    expect(daemon.spine.getMessages("s1").map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
    // events were persisted with monotonic per-session seq
    expect(events.map((e) => e.seq)).toEqual(
      [...events].map((_, i) => i + 1),
    );
    daemon.close();
  });

  it("recovers an interrupted run by re-driving it from the durable record", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "reef.db");

    // ── simulate a crash: a run left 'running' with a pending step ──
    {
      const spine = new Spine(dbPath);
      spine.upsertAgent(agent);
      spine.ensureSession("s1", agent.id);
      spine.appendMessage("s1", "user", [{ type: "text", text: "hello" }]);
      spine.createRun({ id: "run_1", agentId: agent.id, sessionKey: "s1" });
      spine.beginStep("run_1", 0); // model call started, never returned
      spine.close();
    }

    // ── a fresh daemon recovers ──
    const daemon = new Daemon({
      dbPath,
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        {
          stop: "completed",
          content: [{ type: "text", text: "hi there" }],
          usage: { inputTokens: 4, outputTokens: 2 },
        },
      ]),
    });
    daemon.registerAgent(agent);

    await daemon.recover();

    expect(daemon.spine.getInterruptedRuns()).toEqual([]);
    expect(daemon.spine.getRun("run_1")?.status).toBe("completed");
    expect(daemon.spine.getMessages("s1").map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    daemon.close();
  });
});
