import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { runAgentLoop } from "../../src/loop/AgentLoop.js";
import { maybeCompact } from "../../src/loop/compaction.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { builtinTools } from "../../src/tools/builtins.js";
import { BoundFs } from "../../src/fs/capability.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { AgentRecord, ContentBlock } from "../../src/core/types.js";
import type { ReefEventInit } from "../../src/protocol/events.js";

const dirs: string[] = [];
function tempDb(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-compact-"));
  dirs.push(d);
  return join(d, "reef.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const agent: AgentRecord = {
  id: "agent_test",
  name: "Test",
  systemPrompt: "be helpful",
  model: "fake-model",
  toolAllowlist: ["echo", "get_time"],
};

/**
 * Distinguishes summarizer calls from ordinary step calls by their system
 * prompt, so the same fake serves both the unit tests (only summaries) and the
 * loop integration (steps interleaved with summaries).
 */
class FakeRouter implements ModelRouter {
  calls: ModelTurnInput[] = [];
  constructor(
    private readonly stepTurns: ModelTurn[] = [],
    private readonly summaryText = "CONDENSED SUMMARY",
  ) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    this.calls.push(input);
    if (input.system.startsWith("You are compacting")) {
      return {
        content: [{ type: "text", text: this.summaryText }],
        stop: "completed",
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    }
    const turn = this.stepTurns.shift();
    if (!turn) throw new Error("FakeRouter: no scripted step turn left");
    for (const b of turn.content) if (b.type === "text") input.onTextDelta?.(b.text);
    return turn;
  }
  get summaryCalls(): ModelTurnInput[] {
    return this.calls.filter((c) => c.system.startsWith("You are compacting"));
  }
  get stepCalls(): ModelTurnInput[] {
    return this.calls.filter((c) => !c.system.startsWith("You are compacting"));
  }
}

const userMsg = (t: string): ContentBlock[] => [{ type: "text", text: t }];
const asstTool = (id: string): ContentBlock[] => [
  { type: "tool_use", id, name: "echo", input: { message: id } },
];
const toolRes = (id: string): ContentBlock[] => [
  { type: "tool_result", toolUseId: id, output: { echoed: id } },
];

/** A session with a 5-message history and one committed step whose usage we set. */
function seededSpine(dbPath: string, lastInputTokens: number): Spine {
  const spine = new Spine(dbPath);
  spine.upsertAgent(agent);
  spine.ensureSession("s1", agent.id);
  spine.appendMessage("s1", "user", userMsg("start the work")); // seq 1
  spine.appendMessage("s1", "assistant", asstTool("t0")); // seq 2
  spine.appendMessage("s1", "tool", toolRes("t0")); // seq 3
  spine.appendMessage("s1", "assistant", asstTool("t1")); // seq 4
  spine.appendMessage("s1", "tool", toolRes("t1")); // seq 5
  spine.createRun({ id: "run_1", agentId: agent.id, sessionKey: "s1" });
  spine.beginStep("run_1", 0);
  spine.commitStep("run_1", 0, { usage: { inputTokens: lastInputTokens, outputTokens: 10 } });
  return spine;
}

function args(spine: Spine, router: FakeRouter, events: ReefEventInit[], policy: {
  triggerTokens: number;
  keepRecentMessages: number;
}) {
  return {
    spine,
    router,
    run: spine.getRun("run_1")!,
    agent,
    emit: (body: unknown) =>
      events.push({ ...(body as object), sessionKey: "s1", runId: "run_1" } as ReefEventInit),
    policy,
  };
}

describe("maybeCompact", () => {
  it("compacts a fresh single-step (chat) run off the SESSION's last step, not just the current run's (RF-09)", async () => {
    // A no-tool chat run commits its one step only when it ENDS, so maybeCompact at
    // the loop top sees 0 committed steps for the current run — it must trigger off the
    // session's most recent committed step (here, the prior run's) or chat sessions
    // grow unboundedly and never compact.
    const spine = seededSpine(tempDb(), 200); // run_1 committed a step measured at 200 tokens
    spine.createRun({ id: "run_2", agentId: agent.id, sessionKey: "s1" }); // fresh chat run, no steps yet
    const router = new FakeRouter();
    const events: ReefEventInit[] = [];

    const did = await maybeCompact({
      spine,
      router,
      run: spine.getRun("run_2")!,
      agent,
      emit: (body: unknown) => events.push({ ...(body as object), sessionKey: "s1", runId: "run_2" } as ReefEventInit),
      policy: { triggerTokens: 100, keepRecentMessages: 2 },
    });

    expect(did).toBe(true);
    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(spine.getLatestCompaction("s1")?.throughSeq).toBe(3);
  });

  it("folds older messages into a durable summary; getContext returns summary + tail", async () => {
    const spine = seededSpine(tempDb(), 200);
    const router = new FakeRouter();
    const events: ReefEventInit[] = [];

    const did = await maybeCompact(
      args(spine, router, events, { triggerTokens: 100, keepRecentMessages: 2 }),
    );

    expect(did).toBe(true);
    // 5 messages, keep last 2 → fold seq 1..3, summary stands in through seq 3.
    const comp = spine.getLatestCompaction("s1");
    expect(comp?.throughSeq).toBe(3);
    expect(comp?.summary).toBe("CONDENSED SUMMARY");

    // getContext: a leading summary user-turn, then the verbatim tail (seq 4,5).
    const ctx = spine.getContext("s1");
    expect(ctx).toHaveLength(3);
    expect(ctx[0]?.role).toBe("user");
    expect((ctx[0]?.content[0] as { text: string }).text).toContain("Summary of earlier");
    expect(ctx[1]?.content).toEqual(asstTool("t1"));
    expect(ctx[2]?.content).toEqual(toolRes("t1"));

    // raw log is untouched — compaction is a view, not a rewrite.
    expect(spine.getMessages("s1")).toHaveLength(5);

    const compacted = events.find((e) => e.type === "context.compacted");
    expect(compacted).toMatchObject({ throughSeq: 3, foldedMessages: 3 });
    spine.close();
  });

  it("never splits a tool_use / tool_result pair at the cut", async () => {
    const spine = seededSpine(tempDb(), 200);
    const router = new FakeRouter();
    const events: ReefEventInit[] = [];

    // keepRecentMessages: 1 → naive cut lands on the trailing tool_result (seq 5),
    // which must snap back to keep assistant(seq 4)+tool(seq 5) together in the tail.
    await maybeCompact(
      args(spine, router, events, { triggerTokens: 100, keepRecentMessages: 1 }),
    );

    expect(spine.getLatestCompaction("s1")?.throughSeq).toBe(3);
    const ctx = spine.getContext("s1");
    // after the summary turn, the tail must NOT begin with an orphan tool_result.
    expect(ctx[1]?.role).toBe("assistant");
    expect(ctx[1]?.content[0]).toMatchObject({ type: "tool_use", id: "t1" });
    expect(ctx[2]?.content[0]).toMatchObject({ type: "tool_result", toolUseId: "t1" });
    spine.close();
  });

  it("is a cheap no-op below the threshold (no model call)", async () => {
    const spine = seededSpine(tempDb(), 50);
    const router = new FakeRouter();
    const events: ReefEventInit[] = [];

    const did = await maybeCompact(
      args(spine, router, events, { triggerTokens: 100, keepRecentMessages: 2 }),
    );

    expect(did).toBe(false);
    expect(router.calls).toHaveLength(0);
    expect(spine.getLatestCompaction("s1")).toBeUndefined();
    spine.close();
  });

  it("is a no-op when nothing beyond the recent tail remains to fold", async () => {
    const spine = seededSpine(tempDb(), 200);
    const router = new FakeRouter();
    const events: ReefEventInit[] = [];

    // keepRecentMessages bigger than the whole history → nothing foldable.
    const did = await maybeCompact(
      args(spine, router, events, { triggerTokens: 100, keepRecentMessages: 20 }),
    );

    expect(did).toBe(false);
    expect(router.summaryCalls).toHaveLength(0);
    spine.close();
  });

  it("survives a daemon restart — the compacted view rebuilds from SQLite", async () => {
    const dbPath = tempDb();
    const spine = seededSpine(dbPath, 200);
    const router = new FakeRouter();
    await maybeCompact(
      args(spine, router, [], { triggerTokens: 100, keepRecentMessages: 2 }),
    );
    spine.close();

    // Reopen on the same file — recovery is a query, so the view is intact.
    const reopened = new Spine(dbPath);
    expect(reopened.getLatestCompaction("s1")?.throughSeq).toBe(3);
    const ctx = reopened.getContext("s1");
    expect(ctx[0]?.role).toBe("user");
    expect((ctx[0]?.content[0] as { text: string }).text).toContain("Summary of earlier");
    expect(ctx).toHaveLength(3);
    reopened.close();
  });
});

describe("runAgentLoop with compaction", () => {
  it("compacts mid-run and feeds the summary into a later turn", async () => {
    const spine = new Spine(tempDb());
    spine.upsertAgent(agent);
    spine.ensureSession("s1", agent.id);
    const tools = new ToolRegistry();
    for (const t of builtinTools) tools.register(t);
    const events: ReefEventInit[] = [];

    // Two tool-using turns (each reports a large context), then completion.
    const router = new FakeRouter([
      {
        stop: "tool_use",
        content: [{ type: "tool_use", id: "a", name: "echo", input: { message: "1" } }],
        usage: { inputTokens: 200, outputTokens: 4 },
      },
      {
        stop: "tool_use",
        content: [{ type: "tool_use", id: "b", name: "echo", input: { message: "2" } }],
        usage: { inputTokens: 200, outputTokens: 4 },
      },
      {
        stop: "completed",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 200, outputTokens: 3 },
      },
    ]);

    spine.appendMessage("s1", "user", userMsg("go"));
    const run = spine.createRun({ id: "run_1", agentId: agent.id, sessionKey: "s1" });

    const stop = await runAgentLoop(run, agent, {
      spine,
      router,
      tools,
      toolContext: { fs: new BoundFs(join(tmpdir(), "ws")), workspaceRoot: join(tmpdir(), "ws") },
      emit: (e) => events.push(e),
      compaction: { triggerTokens: 100, keepRecentMessages: 2 },
    });

    expect(stop).toBe("completed");
    // compaction fired at least once between steps...
    expect(events.some((e) => e.type === "context.compacted")).toBe(true);
    expect(router.summaryCalls.length).toBeGreaterThan(0);
    expect(spine.getLatestCompaction("s1")).toBeDefined();
    // ...and a later step actually saw the summary as its leading message.
    const sawSummary = router.stepCalls.some(
      (c) =>
        c.messages[0]?.role === "user" &&
        (c.messages[0]?.content[0] as { text?: string }).text?.includes("Summary of earlier"),
    );
    expect(sawSummary).toBe(true);
    spine.close();
  });
});
