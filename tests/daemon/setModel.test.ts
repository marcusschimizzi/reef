import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-setmodel-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Validates ids like the real router: a "known/…" provider resolves, anything
// else throws — exercising setSessionModel's fail-fast path without a network.
class ValidatingRouter implements ModelRouter {
  async generateTurn(_input: ModelTurnInput): Promise<ModelTurn> {
    throw new Error("unused");
  }
  assertResolvable(modelId: string): void {
    if (!modelId.startsWith("known/")) {
      throw new Error(`unknown model provider "${modelId.split("/")[0]}" — configure it in .reef/config.json`);
    }
  }
}

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "x",
  model: "known/default",
  toolAllowlist: [],
};

function makeDaemon(dir: string): Daemon {
  const d = new Daemon({
    dbPath: join(dir, "reef.db"),
    workspaceDir: join(dir, "ws"),
    router: new ValidatingRouter(),
  });
  d.registerAgent(agent);
  return d;
}

describe("Daemon.setSessionModel", () => {
  it("persists a valid model and emits session.model.changed", () => {
    const d = makeDaemon(tempDir());
    const events: ReefEvent[] = [];
    d.subscribe((e) => events.push(e));

    const err = d.setSessionModel("s1", "reef", "known/fast");

    expect(err).toBeNull();
    expect(d.spine.getSessionModel("s1")).toBe("known/fast");
    expect(events.find((e) => e.type === "session.model.changed")).toMatchObject({
      sessionKey: "s1",
      model: "known/fast",
    });
  });

  it("rejects an unknown provider without changing the session", () => {
    const d = makeDaemon(tempDir());

    const err = d.setSessionModel("s1", "reef", "mystery/model");

    expect(err).toMatch(/unknown model provider/);
    expect(d.spine.getSessionModel("s1")).toBeUndefined();
  });
});
