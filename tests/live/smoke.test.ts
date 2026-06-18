import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../../src/core/env.js";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ReefEvent } from "../../src/protocol/events.js";

// Live end-to-end: the real provider-routing layer → Anthropic → a real tool
// round-trip through the loop. Double-gated so it NEVER spends credits implicitly:
// vitest.config excludes tests/live from the default `npm test`, and this file also
// requires an explicit REEF_LIVE_TESTS=1 (set by `npm run test:live`) plus a key.
loadEnv();
const runLive = !!process.env.ANTHROPIC_API_KEY && process.env.REEF_LIVE_TESTS === "1";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt:
    "You are Reef. Be concise. Use the available tools when they help.",
  model: "claude-opus-4-8",
  toolAllowlist: ["echo", "get_time"],
};

describe.skipIf(!runLive)("live smoke (real model)", () => {
  it("completes a get_time tool round-trip through the real router", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reef-live-"));
    dirs.push(dir);
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      // default router = VercelRouter (real Anthropic)
    });
    daemon.registerAgent(agent);

    const events: ReefEvent[] = [];
    daemon.subscribe((e) => events.push(e));

    await daemon.submit({
      sessionKey: "s1",
      agentId: "reef",
      message:
        "Use the get_time tool to find the current time, then tell me what it is.",
    });

    const toolRequests = events
      .filter((e): e is Extract<ReefEvent, { type: "tool.requested" }> => e.type === "tool.requested")
      .map((e) => e.name);
    expect(toolRequests).toContain("get_time");
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);

    const last = events.at(-1);
    expect(last?.type).toBe("run.completed");
    if (last?.type === "run.completed") {
      expect(last.stopReason).toBe("completed");
    }
    daemon.close();
  }, 60_000);
});
