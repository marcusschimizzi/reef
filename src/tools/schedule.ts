import { z } from "zod";
import type { TriggerSpec } from "../core/types.js";
import type { SchedulerCapability } from "../triggers/capability.js";
import type { Tool, ToolContext } from "./types.js";

// Self-scheduling tools (Phase 4c): reef sets its own future wakes. The model
// describes *when* in friendly terms (a one-shot at an instant or after N
// seconds, or a recurring interval/cron); the tool translates that to a
// TriggerSpec and hands it to ctx.scheduler, which enforces the safety bounds on
// agent-authored future work. The tools are ungated — autonomy is the point and
// the bounds (count cap, horizon, recurrence floor) are the guardrail. Setting
// needsApproval on the schedule tool would suspend every self-scheduled wake for
// human sign-off instead; left off by default.

function requireScheduler(ctx: ToolContext): SchedulerCapability {
  if (!ctx.scheduler) {
    throw new Error("schedule tool called without a scheduler in context");
  }
  return ctx.scheduler;
}

/** A friendly "when", as the model supplies it. */
const whenSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("at"),
      iso: z.string().describe("ISO-8601 timestamp to fire once, e.g. 2026-06-11T09:00:00Z"),
    })
    .describe("Fire exactly once at a specific time"),
  z
    .object({
      kind: z.literal("after"),
      seconds: z.number().int().positive().describe("How many seconds from now to fire"),
    })
    .describe("Fire exactly once, a relative delay from now"),
  z
    .object({
      kind: z.literal("every"),
      seconds: z.number().int().positive().describe("Interval between fires, in seconds"),
    })
    .describe("Fire repeatedly on a fixed interval"),
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().describe("A cron expression, e.g. '0 9 * * *' for 09:00 daily"),
      tz: z.string().optional().describe("IANA timezone for the cron, e.g. America/New_York"),
    })
    .describe("Fire repeatedly on a cron schedule"),
]);

type When = z.infer<typeof whenSchema>;

/** Translate the friendly "when" into a durable TriggerSpec. */
function toSpec(when: When): TriggerSpec {
  switch (when.kind) {
    case "at":
      return { kind: "once", at: when.iso };
    case "after":
      return { kind: "once", at: new Date(Date.now() + when.seconds * 1000).toISOString() };
    case "every":
      return { kind: "interval", seconds: when.seconds };
    case "cron":
      return when.tz
        ? { kind: "cron", expr: when.expr, tz: when.tz }
        : { kind: "cron", expr: when.expr };
  }
}

export const scheduleTool: Tool<{ prompt: string; when: When }> = {
  name: "schedule",
  description:
    "Schedule a future wake for yourself — a one-shot ('check back tomorrow at 9am') " +
    "or a recurring routine. When it fires you start a fresh run seeded with `prompt`, " +
    "so write `prompt` as a self-contained instruction to your future self. There are " +
    "limits on how many wakes you can have pending, how far out they can be, and how " +
    "often they may repeat; if you hit one you'll be told and can cancel an existing " +
    "schedule first. Use list_schedules to see what you have and cancel_schedule to drop one.",
  inputSchema: z.object({
    prompt: z
      .string()
      .describe("The self-contained instruction your future run will act on when this fires"),
    when: whenSchema,
  }),
  async run({ prompt, when }, ctx) {
    const scheduler = requireScheduler(ctx);
    const s = await scheduler.schedule({ spec: toSpec(when), input: prompt });
    return { id: s.id, nextFireAt: s.nextFireAt, spec: s.spec };
  },
};

export const listSchedulesTool: Tool<Record<string, never>> = {
  name: "list_schedules",
  description:
    "List the future wakes you have scheduled for yourself — their ids, what each will " +
    "do, and when each next fires. Use this before scheduling another if you might be " +
    "near the limit, or to find the id of one to cancel.",
  inputSchema: z.object({}),
  async run(_input, ctx) {
    const scheduler = requireScheduler(ctx);
    const schedules = await scheduler.list();
    return {
      schedules: schedules.map((s) => ({
        id: s.id,
        input: s.input,
        nextFireAt: s.nextFireAt,
        spec: s.spec,
      })),
    };
  },
};

export const cancelScheduleTool: Tool<{ id: string }> = {
  name: "cancel_schedule",
  description:
    "Cancel one of your own scheduled wakes by its id (from list_schedules). Returns " +
    "whether a schedule was cancelled. You can only cancel wakes you scheduled yourself.",
  inputSchema: z.object({
    id: z.string().describe("The schedule id to cancel"),
  }),
  async run({ id }, ctx) {
    const scheduler = requireScheduler(ctx);
    return { cancelled: await scheduler.cancel(id) };
  },
};

export const scheduleTools: Tool[] = [scheduleTool, listSchedulesTool, cancelScheduleTool];
