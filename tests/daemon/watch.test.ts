import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { ReefEvent } from "../../src/protocol/events.js";
import type { WatchFactory } from "../../src/triggers/watcher.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-watchint-"));
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
  toolAllowlist: ["echo"],
};

function fakeFactory() {
  let cb: ((type: "change" | "rename", filename: string | null) => void) | undefined;
  const factory: WatchFactory = (_path, _opts, onEvent) => {
    cb = onEvent;
    return { close: () => {} };
  };
  return { factory, emit: (t: "change" | "rename", f: string | null) => cb?.(t, f) };
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("file-watch triggers (Phase 4d)", () => {
  it("runs the agent on a filesystem change, threading the changed path into the wake", async () => {
    const dir = tempDir();
    const watch = fakeFactory();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([
        { stop: "completed", content: [{ type: "text", text: "reacted" }], usage: { inputTokens: 3, outputTokens: 1 } },
      ]),
      watchFactory: watch.factory,
    });
    daemon.registerAgent(agent);

    const events: ReefEvent[] = [];
    daemon.subscribe((e) => events.push(e));

    // Watch the temp dir; debounce/cooldown 0 so the test doesn't wait on timers.
    const trigger = daemon.ensureWatch({
      agentId: "reef",
      path: dir,
      input: "Source changed — react.",
      debounceMs: 0,
      cooldownMs: 0,
    });
    expect(trigger.type).toBe("watch");
    expect(trigger.nextFireAt).toBeUndefined(); // never time-fires

    watch.emit("change", "main.ts");
    await waitFor(() => events.some((e) => e.type === "run.completed"));

    // The wake message carried the change, and was persisted on the trigger session.
    const userMsg = daemon.spine
      .getMessages(trigger.sessionKey)
      .find((m) => m.role === "user");
    const text = userMsg?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    expect(text).toContain("Source changed");
    expect(text).toContain("main.ts");

    // run.started carries the watch source + the concrete event.
    const started = events.find((e) => e.type === "run.started");
    expect(started).toMatchObject({
      type: "run.started",
      source: { kind: "trigger", triggerType: "watch", event: { type: "change" } },
    });

    daemon.close();
  });

  it("ensureWatch is idempotent per (agent, path)", () => {
    const dir = tempDir();
    const watch = fakeFactory();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      router: new FakeRouter([]),
      watchFactory: watch.factory,
    });
    daemon.registerAgent(agent);

    const a = daemon.ensureWatch({ agentId: "reef", path: dir, input: "react" });
    const b = daemon.ensureWatch({ agentId: "reef", path: dir, input: "react again" });
    expect(b.id).toBe(a.id); // found the existing one, no duplicate
    expect(daemon.listTriggers("reef").filter((t) => t.spec.kind === "watch")).toHaveLength(1);

    daemon.close();
  });
});
