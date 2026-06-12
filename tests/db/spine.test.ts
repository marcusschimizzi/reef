import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import type { AgentRecord } from "../../src/core/types.js";

const dirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reef-spine-"));
  dirs.push(dir);
  return join(dir, "reef.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const agent: AgentRecord = {
  id: "agent_test",
  name: "Test Agent",
  systemPrompt: "be helpful",
  model: "test-model",
  toolAllowlist: ["echo"],
};

describe("Spine", () => {
  it("round-trips an agent record", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);
    expect(spine.getAgent("agent_test")).toEqual(agent);
    spine.close();
  });

  it("appends and reconstructs the conversation in order", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);
    spine.ensureSession("s1", agent.id);

    const a = spine.appendMessage("s1", "user", [{ type: "text", text: "hi" }]);
    const b = spine.appendMessage("s1", "assistant", [
      { type: "text", text: "hello" },
    ]);

    expect([a, b]).toEqual([1, 2]); // per-session monotonic seq
    expect(spine.getMessages("s1")).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    spine.close();
  });

  it("survives a crash mid-step and reports exactly what was in flight", () => {
    const path = tempDbPath();

    // ── first process: start a run, begin a step, then "crash" (no commit) ──
    {
      const spine = new Spine(path);
      spine.upsertAgent(agent);
      spine.ensureSession("s1", agent.id);
      const run = spine.createRun({
        id: "run_1",
        agentId: agent.id,
        sessionKey: "s1",
      });
      spine.beginStep(run.id, 0); // model call started, never returned
      spine.close(); // process dies here
    }

    // ── recovery: a fresh process reopens the same DB file ──
    {
      const spine = new Spine(path);
      const interrupted = spine.getInterruptedRuns();
      expect(interrupted.map((r) => r.id)).toEqual(["run_1"]);
      expect(interrupted[0]?.status).toBe("running");

      const pending = spine.getPendingSteps();
      expect(pending).toEqual([{ runId: "run_1", index: 0 }]);

      // reconcile: commit the step and finalize the run
      spine.commitStep("run_1", 0, {
        response: [{ type: "text", text: "recovered" }],
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      spine.setRunStatus("run_1", "completed", {
        stopReason: "completed",
        endedAt: new Date().toISOString(),
      });
      spine.close();
    }

    // ── after reconciliation, nothing is in flight ──
    {
      const spine = new Spine(path);
      expect(spine.getInterruptedRuns()).toEqual([]);
      expect(spine.getPendingSteps()).toEqual([]);

      const steps = spine.getSteps("run_1");
      expect(steps).toHaveLength(1);
      expect(steps[0]?.state).toBe("committed");
      expect(steps[0]?.response).toEqual([{ type: "text", text: "recovered" }]);

      const run = spine.getRun("run_1");
      expect(run?.status).toBe("completed");
      expect(run?.stopReason).toBe("completed");
      spine.close();
    }
  });

  it("does not treat a suspended run as interrupted", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);
    spine.ensureSession("s1", agent.id);
    spine.createRun({ id: "run_s", agentId: agent.id, sessionKey: "s1" });
    spine.setRunStatus("run_s", "suspended", { stopReason: "awaiting_input" });

    // suspended is intentional parking, not a crash — recovery must skip it
    expect(spine.getInterruptedRuns()).toEqual([]);
    spine.close();
  });

  it("snapshots a session's model at creation and keeps it (sticky)", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);
    spine.ensureSession("s1", agent.id, "model-x");
    spine.ensureSession("s1", agent.id, "model-y"); // OR IGNORE — original sticks
    expect(spine.getSessionModel("s1")).toBe("model-x");
    expect(spine.listSessions().find((s) => s.sessionKey === "s1")?.model).toBe("model-x");
    spine.close();
  });

  it("summarizes sessions for the sessions view (title, preview, status, approvals)", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);

    // a finished interactive session
    spine.ensureSession("s_done", agent.id);
    spine.appendMessage("s_done", "user", [{ type: "text", text: "what's my name?" }]);
    spine.appendMessage("s_done", "assistant", [{ type: "text", text: "It's Marcus" }]);
    const done = spine.createRun({ id: "run_done", agentId: agent.id, sessionKey: "s_done" });
    spine.setRunStatus(done.id, "completed", { stopReason: "completed" });

    // a session parked awaiting approval
    spine.ensureSession("s_wait", agent.id);
    spine.appendMessage("s_wait", "user", [{ type: "text", text: "run a deploy" }]);
    const wait = spine.createRun({ id: "run_wait", agentId: agent.id, sessionKey: "s_wait" });
    spine.setRunStatus(wait.id, "suspended", { stopReason: "awaiting_approval" });
    spine.createApproval({
      id: "apr_1",
      runId: wait.id,
      sessionKey: "s_wait",
      toolUseId: "t1",
      toolName: "shell",
      input: { command: "deploy" },
    });

    const byKey = Object.fromEntries(spine.listSessions().map((s) => [s.sessionKey, s]));
    expect(byKey.s_done).toMatchObject({
      status: "idle",
      title: "what's my name?",
      preview: "It's Marcus",
      pendingApprovals: 0,
    });
    expect(byKey.s_wait).toMatchObject({
      status: "awaiting_approval",
      title: "run a deploy",
      pendingApprovals: 1,
      pendingApprovalId: "apr_1",
    });
    spine.close();
  });

  it("a subwork-suspended run shows as working, not awaiting_approval", () => {
    const spine = new Spine(tempDbPath());
    spine.upsertAgent(agent);
    spine.ensureSession("s_sub", agent.id);
    spine.appendMessage("s_sub", "user", [{ type: "text", text: "build a feature" }]);
    const run = spine.createRun({ id: "run_sub", agentId: agent.id, sessionKey: "s_sub" });
    spine.setRunStatus(run.id, "suspended", { stopReason: "awaiting_subwork" });

    const summary = spine.listSessions().find((s) => s.sessionKey === "s_sub");
    expect(summary?.status).not.toBe("awaiting_approval");
    expect(summary?.status).toBe("working");
    spine.close();
  });
});
