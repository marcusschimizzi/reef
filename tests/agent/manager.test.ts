import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agent/AgentManager.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

const fakeAdapter = {
  name: "fake",
  spawn: () => ({ stdout: null, stdin: null } as any),
  parseOutput: async function* () {
    yield {
      timestamp: new Date().toISOString(),
      type: "needs_input",
      agentId: "",
      payload: { question: "Q", options: ["A"] }
    };
  },
  sendInput: () => {}
};

describe("AgentManager", () => {
  it("marks awaiting_input and clears on send", async () => {
    const registry = new AdapterRegistry();
    registry.register("claude", fakeAdapter as any);
    const manager = new AgentManager(registry);
    const job = manager.createJob("claude", "headless", "task", ".");
    manager.markAwaitingInput(job.id, "Question", ["A", "B"]);
    expect(manager.getJob(job.id)?.status).toBe("awaiting_input");
    manager.clearAwaitingInput(job.id, "hello");
    expect(manager.getJob(job.id)?.status).toBe("running");
  });

  it("returns events after timestamp", () => {
    const manager = new AgentManager(new AdapterRegistry());
    const job = manager.createJob("claude", "headless", "task", ".");
    const all = manager.getEvents(job.id);
    const since = all[0].timestamp;
    const after = manager.getEvents(job.id, since);
    expect(after.length).toBe(0);
  });
});
