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
  const d = mkdtempSync(join(tmpdir(), "reef-trig-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Always completes in one turn — every proactive run is a single turn here. */
class CompletingRouter implements ModelRouter {
  calls = 0;
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    this.calls++;
    input.onTextDelta?.("ok");
    return { stop: "completed", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 3, outputTokens: 1 } };
  }
}

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "be helpful",
  model: "fake",
  toolAllowlist: ["echo"],
};

function makeDaemon(dir: string): { daemon: Daemon; events: ReefEvent[]; router: CompletingRouter } {
  const router = new CompletingRouter();
  const daemon = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router });
  daemon.registerAgent(agent);
  const events: ReefEvent[] = [];
  daemon.subscribe((e) => events.push(e));
  return { daemon, events, router };
}

// A time safely past a freshly-created interval trigger's first fire, but within
// the missed-fire grace window (so fire_once and a normal tick behave the same).
const soon = (): Date => new Date(Date.now() + 90_000);
// A time long past the first fire — looks like a fire missed during downtime.
const wayLater = (): Date => new Date(Date.now() + 10 * 60_000);

describe("scheduled triggers", () => {
  it("fires a proactive run on its own session, tagged with a trigger source", async () => {
    const { daemon, events } = makeDaemon(tempDir());
    const trigger = daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "summarize the day",
    });

    await daemon.tickTriggers(soon());

    // a run happened on the trigger's stable session, seeded with its instruction
    const convo = daemon.spine.getMessages(trigger.sessionKey);
    expect(convo[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "summarize the day" }] });
    expect(convo.at(-1)?.role).toBe("assistant");

    // run.started carried the proactive source
    const started = events.find((e) => e.type === "run.started");
    expect(started).toMatchObject({ source: { kind: "trigger", triggerId: trigger.id, triggerType: "schedule" } });
    expect(events.at(-1)?.type).toBe("run.completed");

    // the schedule advanced to a future fire
    const after = daemon.listTriggers("reef")[0];
    expect(after?.lastFiredAt).toBeDefined();
    expect(Date.parse(after!.nextFireAt!)).toBeGreaterThan(Date.now());
    daemon.close();
  });

  it("fire_once (default) runs an overdue fire missed during downtime", async () => {
    const { daemon, router } = makeDaemon(tempDir());
    daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "catch up",
    });

    await daemon.tickTriggers(wayLater()); // long past due → looks missed
    expect(router.calls).toBe(1); // fired anyway
    daemon.close();
  });

  it("skip drops a fire missed during downtime but still advances the schedule", async () => {
    const { daemon, router } = makeDaemon(tempDir());
    const trigger = daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "catch up",
      catchUpPolicy: "skip",
    });

    await daemon.tickTriggers(wayLater());
    expect(router.calls).toBe(0); // missed fire dropped
    const after = daemon.spine.getTrigger(trigger.id);
    expect(Date.parse(after!.nextFireAt!)).toBeGreaterThan(Date.now()); // but rescheduled
    daemon.close();
  });

  it("does not fire a disabled trigger", async () => {
    const { daemon, router } = makeDaemon(tempDir());
    daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "x",
      enabled: false,
    });
    await daemon.tickTriggers(wayLater());
    expect(router.calls).toBe(0);
    daemon.close();
  });

  it("survives a restart — a persisted trigger fires from a fresh daemon", async () => {
    const dir = tempDir();
    const first = makeDaemon(dir);
    const trigger = first.daemon.createTrigger({
      agentId: "reef",
      spec: { kind: "interval", seconds: 60 },
      input: "still here",
    });
    first.daemon.close();

    const second = makeDaemon(dir);
    expect(second.daemon.listTriggers("reef").map((t) => t.id)).toContain(trigger.id);
    await second.daemon.tickTriggers(soon());
    expect(second.router.calls).toBe(1);
    expect(second.daemon.spine.getMessages(trigger.sessionKey)[0]).toMatchObject({
      content: [{ type: "text", text: "still here" }],
    });
    second.daemon.close();
  });
});
