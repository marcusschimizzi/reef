import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import {
  DaemonScheduler,
  ScheduleError,
  type ScheduleLimits,
} from "../../src/triggers/capability.js";
import type { AgentRecord } from "../../src/core/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "x",
  model: "fake",
  toolAllowlist: [],
};

const NOW = new Date("2026-06-10T12:00:00.000Z");
const LIMITS: ScheduleLimits = { maxPending: 3, maxHorizonMs: 7 * 24 * 60 * 60 * 1000, minIntervalSeconds: 60 };

/** A spine with the agent registered, plus a scheduler bound to it at a fixed clock. */
function setup(agentId = "reef"): { spine: Spine; sched: DaemonScheduler } {
  const dir = mkdtempSync(join(tmpdir(), "reef-sched-"));
  dirs.push(dir);
  const spine = new Spine(join(dir, "reef.db"));
  spine.upsertAgent(agent);
  if (agentId !== "reef") spine.upsertAgent({ ...agent, id: agentId });
  return { spine, sched: new DaemonScheduler(spine, agentId, LIMITS, () => NOW) };
}

describe("DaemonScheduler (self-scheduling capability)", () => {
  it("schedules a one-shot, persists it as an agent-authored trigger, and lists it", async () => {
    const { spine, sched } = setup();
    const s = await sched.schedule({
      spec: { kind: "once", at: "2026-06-11T09:00:00.000Z" },
      input: "check back on the build",
    });
    expect(s.nextFireAt).toBe("2026-06-11T09:00:00.000Z");

    const stored = spine.getTrigger(s.id)!;
    expect(stored.createdBy).toBe("agent");
    expect(stored.type).toBe("schedule");
    expect(stored.catchUpPolicy).toBe("fire_once");
    expect(stored.sessionKey).toBe(`reef:reef:trigger-${s.id}`);

    expect(await sched.list()).toEqual([
      expect.objectContaining({ id: s.id, input: "check back on the build" }),
    ]);
    spine.close();
  });

  it("rejects an empty instruction", async () => {
    const { sched } = setup();
    await expect(
      sched.schedule({ spec: { kind: "once", at: "2026-06-11T09:00:00.000Z" }, input: "  " }),
    ).rejects.toBeInstanceOf(ScheduleError);
  });

  it("refuses a fire beyond the horizon", async () => {
    const { sched } = setup();
    // 30 days out, horizon is 7 days
    await expect(
      sched.schedule({ spec: { kind: "once", at: "2026-07-10T12:00:00.000Z" }, input: "later" }),
    ).rejects.toThrow(/too far ahead/);
  });

  it("refuses a recurrence tighter than the floor — interval and sub-minute cron alike", async () => {
    const { sched } = setup();
    await expect(
      sched.schedule({ spec: { kind: "interval", seconds: 30 }, input: "tight" }),
    ).rejects.toThrow(/too frequently/);
    // a 6-field cron firing every 10s also trips the floor
    await expect(
      sched.schedule({ spec: { kind: "cron", expr: "*/10 * * * * *" }, input: "tight cron" }),
    ).rejects.toThrow(/too frequently/);
  });

  it("caps the pile of pending agent triggers", async () => {
    const { spine, sched } = setup();
    for (let i = 0; i < LIMITS.maxPending; i++) {
      await sched.schedule({ spec: { kind: "interval", seconds: 3600 }, input: `r${i}` });
    }
    await expect(
      sched.schedule({ spec: { kind: "interval", seconds: 3600 }, input: "one too many" }),
    ).rejects.toThrow(/the max/);

    // cancelling one frees a slot
    const mine = await sched.list();
    expect(await sched.cancel(mine[0]!.id)).toBe(true);
    await expect(
      sched.schedule({ spec: { kind: "interval", seconds: 3600 }, input: "now fits" }),
    ).resolves.toBeDefined();
    spine.close();
  });

  it("a spent one-shot stops counting against the cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reef-sched-"));
    dirs.push(dir);
    const spine = new Spine(join(dir, "reef.db"));
    spine.upsertAgent(agent);
    // clock advances: schedule at NOW, then evaluate the cap from a later "now"
    let clock = NOW;
    const sched = new DaemonScheduler(spine, "reef", LIMITS, () => clock);

    const s = await sched.schedule({ spec: { kind: "once", at: "2026-06-10T12:00:30.000Z" }, input: "soon" });
    // simulate the fire having advanced its schedule to dormant (nextFireAt cleared)
    spine.updateTriggerSchedule(s.id, { nextFireAt: undefined, lastFiredAt: "2026-06-10T12:00:30.000Z" });

    clock = new Date("2026-06-10T13:00:00.000Z");
    expect(spine.countPendingAgentTriggers("reef")).toBe(0); // spent → not counted
    spine.close();
  });

  it("cancels only the agent's own self-scheduled triggers, never operator routines", async () => {
    const { spine, sched } = setup();
    spine.createTrigger({
      id: "trg_op",
      agentId: "reef",
      type: "schedule",
      spec: { kind: "interval", seconds: 3600 },
      input: "operator routine",
      sessionKey: "reef:reef:trigger-trg_op",
      createdBy: "operator",
      enabled: true,
      catchUpPolicy: "fire_once",
      nextFireAt: "2026-06-10T13:00:00.000Z",
      createdAt: NOW.toISOString(),
    });

    expect(await sched.cancel("trg_op")).toBe(false); // can't touch operator's
    expect(spine.getTrigger("trg_op")).toBeDefined(); // still there
    expect(await sched.cancel("trg_does_not_exist")).toBe(false);
    // operator trigger is excluded from the agent's own listing
    expect((await sched.list()).map((s) => s.id)).not.toContain("trg_op");
    spine.close();
  });
});
