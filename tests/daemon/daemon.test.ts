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
    // the ungated tool call was audited as allowed/ok
    expect(daemon.listActions().some((a) => a.toolName === "echo" && a.decision === "allow" && a.outcome === "ok")).toBe(true);
    // events were persisted with monotonic per-session seq
    expect(events.map((e) => e.seq)).toEqual(
      [...events].map((_, i) => i + 1),
    );
    daemon.close();
  });

  it("carries memory across sessions: a fact recorded in one run is recalled in another", async () => {
    const dir = tempDir();
    const memAgent: AgentRecord = {
      ...agent,
      toolAllowlist: ["recall_memory", "record_memory"],
    };
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        // session s1: save a durable fact
        {
          stop: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "r1",
              name: "record_memory",
              input: { content: "The user's name is Marcus." },
            },
          ],
          usage: { inputTokens: 5, outputTokens: 2 },
        },
        { stop: "completed", content: [{ type: "text", text: "saved" }], usage: { inputTokens: 6, outputTokens: 1 } },
        // session s2 (different session, same agent): look it up
        {
          stop: "tool_use",
          content: [
            { type: "tool_use", id: "q1", name: "recall_memory", input: { query: "user's name" } },
          ],
          usage: { inputTokens: 7, outputTokens: 2 },
        },
        { stop: "completed", content: [{ type: "text", text: "It's Marcus" }], usage: { inputTokens: 8, outputTokens: 1 } },
      ]),
    });
    daemon.registerAgent(memAgent);

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "remember my name is Marcus" });
    await daemon.submit({ sessionKey: "s2", agentId: "reef", message: "what's my name?" });

    // the recall tool result in the second session surfaced the first session's fact
    const toolMsg = daemon.spine.getMessages("s2").find((m) => m.role === "tool");
    const output = toolMsg?.content[0] as { output: { results: Array<{ content: string }> } };
    expect(output.output.results[0]?.content).toBe("The user's name is Marcus.");
    daemon.close();
  });

  it("pins a session's model: changing the global default doesn't move existing sessions", async () => {
    const dir = tempDir();
    const models: string[] = [];
    const router: ModelRouter = {
      async generateTurn(input) {
        models.push(input.model);
        return { stop: "completed", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const daemon = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router });
    daemon.registerAgent({ ...agent, model: "model-a" });

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "hi" }); // snapshots model-a
    daemon.registerAgent({ ...agent, model: "model-b" }); // global default changes
    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "again" }); // s1 stays model-a
    await daemon.submit({ sessionKey: "s2", agentId: "reef", message: "new" }); // s2 gets model-b

    expect(models).toEqual(["model-a", "model-a", "model-b"]);
    daemon.close();
  });

  it("surfaces runs awaiting approval for observability", async () => {
    const dir = tempDir();
    const gatedAgent: AgentRecord = { ...agent, toolAllowlist: ["shell"] };
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        {
          stop: "tool_use",
          content: [{ type: "tool_use", id: "s1", name: "shell", input: { command: "echo hi" } }],
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      ]),
    });
    daemon.registerAgent(gatedAgent);

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "run a command" });

    const waiting = daemon.runsAwaitingApproval();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.run.sessionKey).toBe("s1");
    expect(waiting[0]?.approvals).toHaveLength(1);
    expect(waiting[0]?.approvals[0]?.toolName).toBe("shell");
    // and it shows up in the status-filtered run list
    expect(daemon.listRuns({ status: "suspended" }).map((r) => r.id)).toEqual([waiting[0]?.run.id]);
    daemon.close();
  });

  it("a recovered proactive run still auto-denies gated tools (durable RunSource, RF-07)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "reef.db");
    const gated: AgentRecord = { ...agent, toolAllowlist: ["shell"] };

    // ── crash: a proactive (trigger-sourced) run left mid-flight with a pending step ──
    {
      const spine = new Spine(dbPath);
      spine.upsertAgent(gated);
      spine.ensureSession("trg-session", gated.id);
      spine.appendMessage("trg-session", "user", [{ type: "text", text: "scheduled wake" }]);
      const run = spine.createRun({
        id: "run_pro",
        agentId: gated.id,
        sessionKey: "trg-session",
        source: { kind: "trigger", triggerId: "t1", triggerType: "schedule" },
      });
      // the source must be durable, not just in-memory
      expect(spine.getRun("run_pro")?.source).toEqual({ kind: "trigger", triggerId: "t1", triggerType: "schedule" });
      expect(run.source?.kind).toBe("trigger");
      spine.beginStep("run_pro", 0); // model call started, never returned
      spine.close();
    }

    // ── a fresh daemon recovers and re-drives the run; it must apply the PROACTIVE
    //    policy (auto-deny the gated shell, no human) — not gate-and-deadlock ──
    const daemon = new Daemon({
      dbPath,
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        { stop: "tool_use", content: [{ type: "tool_use", id: "s1", name: "shell", input: { command: "echo hi" } }], usage: { inputTokens: 5, outputTokens: 2 } },
        { stop: "completed", content: [{ type: "text", text: "proceeding without it" }], usage: { inputTokens: 4, outputTokens: 1 } },
      ]),
    });
    daemon.registerAgent(gated);

    await daemon.recover();

    expect(daemon.spine.getRun("run_pro")!.status).toBe("completed"); // NOT suspended/deadlocked
    expect(
      daemon.listActions({ runId: "run_pro" }).some((a) => a.toolName === "shell" && a.decision === "deny"),
    ).toBe(true);
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
