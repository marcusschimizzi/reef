import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import { DefaultPolicy } from "../../src/policy/policy.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn } from "../../src/model/router.js";
import type { ApprovalNotification, Surface } from "../../src/surfaces/index.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-route-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Returns the queued turns in order: a gated shell call, then completion. */
class ScriptedRouter implements ModelRouter {
  calls = 0;
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(): Promise<ModelTurn> {
    this.calls += 1;
    const t = this.turns.shift();
    if (!t) throw new Error("out of turns");
    return t;
  }
}

const GATED: ModelTurn = {
  stop: "tool_use",
  content: [{ type: "tool_use", id: "t1", name: "shell", input: { command: "echo hi" } }],
  usage: { inputTokens: 5, outputTokens: 2 },
};
const DONE: ModelTurn = {
  stop: "completed",
  content: [{ type: "text", text: "ok" }],
  usage: { inputTokens: 4, outputTokens: 1 },
};

class FakeSurface implements Surface {
  readonly id = "fake";
  notes: ApprovalNotification[] = [];
  async notify(n: ApprovalNotification): Promise<void> {
    this.notes.push(n);
  }
}

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "x",
  model: "fake",
  toolAllowlist: ["shell"],
};

const soon = (): Date => new Date(Date.now() + 90_000);

describe("proactive approval routing", () => {
  it("routes: a proactive gated tool suspends, notifies surfaces, and arms an expiry", async () => {
    const dir = tempDir();
    const surface = new FakeSurface();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new ScriptedRouter([GATED, DONE]),
      policy: new DefaultPolicy({ proactiveGatedAction: "gate" }), // routing on
      surfaces: [surface],
      proactiveApprovalTimeoutSeconds: 60,
    });
    daemon.registerAgent(agent);
    const trigger = daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "do the thing",
    });

    await daemon.tickTriggers(soon());

    // suspended awaiting approval (not auto-denied)
    const waiting = daemon.runsAwaitingApproval();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.run.sessionKey).toBe(trigger.sessionKey);
    const approval = waiting[0]!.approvals[0]!;
    expect(approval.toolName).toBe("shell");
    expect(approval.expiresAt).toBeDefined(); // auto-deny deadline armed

    // the surface was reached
    expect(surface.notes).toHaveLength(1);
    expect(surface.notes[0]).toMatchObject({ kind: "approval", action: expect.stringContaining("shell") });

    // the sweep auto-denies it once the deadline passes, and the run resumes to
    // completion (rather than hanging) — the original deadlock can't recur.
    daemon.sweepExpiredApprovals(new Date(Date.now() + 120_000));
    expect(daemon.spine.getApproval(approval.id)?.status).toBe("denied");
    const runId = waiting[0]!.run.id;
    for (let i = 0; i < 100 && daemon.spine.getRun(runId)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 5)); // let the async resume drain
    }
    expect(daemon.spine.getRun(runId)?.status).toBe("completed");
    daemon.close();
  });

  it("deny (default): a proactive gated tool auto-denies, never suspends, never notifies", async () => {
    const dir = tempDir();
    const surface = new FakeSurface();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new ScriptedRouter([GATED, DONE]),
      policy: new DefaultPolicy(), // default: deny proactive gated
      surfaces: [surface],
    });
    daemon.registerAgent(agent);
    daemon.createTrigger({ agentId: "reef", spec: { kind: "interval", seconds: 60 }, input: "x" });

    await daemon.tickTriggers(soon());

    expect(daemon.runsAwaitingApproval()).toHaveLength(0); // completed, not parked
    expect(surface.notes).toHaveLength(0); // no human to reach — auto-denied
    expect(daemon.listRuns({ status: "completed" })).toHaveLength(1);
    daemon.close();
  });
});
