import { describe, expect, it } from "vitest";
import {
  scheduleTool,
  listSchedulesTool,
  cancelScheduleTool,
} from "../../src/tools/schedule.js";
import type { SchedulerCapability, SelfSchedule } from "../../src/triggers/capability.js";
import type { TriggerSpec } from "../../src/core/types.js";
import type { ToolContext } from "../../src/tools/types.js";

/** A scheduler that records the spec it was handed and returns a canned handle. */
class FakeScheduler implements SchedulerCapability {
  lastSpec?: TriggerSpec;
  cancelled: string[] = [];
  schedules: SelfSchedule[] = [];
  async schedule(req: { spec: TriggerSpec; input: string }): Promise<SelfSchedule> {
    this.lastSpec = req.spec;
    const s: SelfSchedule = {
      id: "trg_fake",
      spec: req.spec,
      input: req.input,
      nextFireAt: "2026-06-11T09:00:00.000Z",
      createdAt: "2026-06-10T12:00:00.000Z",
    };
    this.schedules.push(s);
    return s;
  }
  async list(): Promise<SelfSchedule[]> {
    return this.schedules;
  }
  async cancel(id: string): Promise<boolean> {
    this.cancelled.push(id);
    return id === "trg_fake";
  }
}

const ctx = (scheduler?: SchedulerCapability): ToolContext =>
  ({ fs: null as never, workspaceRoot: "/tmp", scheduler }) as ToolContext;

describe("schedule tool — when → spec translation", () => {
  it("maps an absolute one-shot to a once spec", async () => {
    const s = new FakeScheduler();
    await scheduleTool.run({ prompt: "ping", when: { kind: "at", iso: "2026-06-11T09:00:00Z" } }, ctx(s));
    expect(s.lastSpec).toEqual({ kind: "once", at: "2026-06-11T09:00:00Z" });
  });

  it("maps a relative one-shot to a once spec ~N seconds out", async () => {
    const s = new FakeScheduler();
    const before = Date.now();
    await scheduleTool.run({ prompt: "ping", when: { kind: "after", seconds: 3600 } }, ctx(s));
    expect(s.lastSpec?.kind).toBe("once");
    const at = Date.parse((s.lastSpec as { kind: "once"; at: string }).at);
    expect(at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(at).toBeLessThan(before + 3600 * 1000 + 5000);
  });

  it("maps recurring 'every' and 'cron' through, carrying tz only when given", async () => {
    const s = new FakeScheduler();
    await scheduleTool.run({ prompt: "p", when: { kind: "every", seconds: 900 } }, ctx(s));
    expect(s.lastSpec).toEqual({ kind: "interval", seconds: 900 });

    await scheduleTool.run({ prompt: "p", when: { kind: "cron", expr: "0 9 * * *" } }, ctx(s));
    expect(s.lastSpec).toEqual({ kind: "cron", expr: "0 9 * * *" });

    await scheduleTool.run(
      { prompt: "p", when: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" } },
      ctx(s),
    );
    expect(s.lastSpec).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "America/New_York" });
  });

  it("returns the created schedule's id and next fire", async () => {
    const out = (await scheduleTool.run(
      { prompt: "ping", when: { kind: "at", iso: "2026-06-11T09:00:00Z" } },
      ctx(new FakeScheduler()),
    )) as { id: string; nextFireAt?: string };
    expect(out).toMatchObject({ id: "trg_fake", nextFireAt: "2026-06-11T09:00:00.000Z" });
  });
});

describe("list_schedules / cancel_schedule", () => {
  it("lists the agent's own schedules", async () => {
    const s = new FakeScheduler();
    await s.schedule({ spec: { kind: "interval", seconds: 900 }, input: "routine" });
    const out = (await listSchedulesTool.run({}, ctx(s))) as { schedules: unknown[] };
    expect(out.schedules).toHaveLength(1);
  });

  it("cancels by id and reports the result", async () => {
    const s = new FakeScheduler();
    expect(await cancelScheduleTool.run({ id: "trg_fake" }, ctx(s))).toEqual({ cancelled: true });
    expect(await cancelScheduleTool.run({ id: "nope" }, ctx(s))).toEqual({ cancelled: false });
  });
});

describe("guard", () => {
  it("throws when no scheduler is in context (so the loop reports it back to the model)", async () => {
    await expect(
      scheduleTool.run({ prompt: "p", when: { kind: "every", seconds: 900 } }, ctx()),
    ).rejects.toThrow(/without a scheduler/);
  });
});
