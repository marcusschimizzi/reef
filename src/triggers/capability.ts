import { newTriggerId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { Trigger, TriggerSpec } from "../core/types.js";
import type { Spine } from "../db/spine.js";
import { assertValidSpec, nextFireTime } from "./schedule.js";

// The self-scheduling seam (Phase 4c). Tools reach trigger-creation only through
// this capability — never the daemon or the spine directly — exactly as they
// reach the filesystem through FsCapability and memory through MemoryStore. The
// capability is the ONE place the safety bounds on agent-authored future work
// live: a count cap, a horizon, and a recurrence floor, all enforced at
// creation time. Bound to a single agent, so an agent can only ever schedule,
// list, and cancel its *own* future work.

/** The agent's view of one self-scheduled trigger. */
export interface SelfSchedule {
  id: string;
  spec: TriggerSpec;
  /** The instruction the future run is seeded with. */
  input: string;
  /** ISO-8601 of the next (for `once`, the only) fire; absent once spent. */
  nextFireAt?: string;
  createdAt: string;
}

export interface SchedulerCapability {
  /**
   * Create an agent-authored trigger, enforcing the safety bounds. Throws a
   * ScheduleError (whose message is fed back to the model as a tool error) when
   * a bound is violated, so the model can correct course — cancel one first,
   * pick a nearer time, slow a too-frequent recurrence.
   */
  schedule(req: { spec: TriggerSpec; input: string }): Promise<SelfSchedule>;
  /** The agent's own pending schedules (operator and heartbeat triggers excluded). */
  list(): Promise<SelfSchedule[]>;
  /** Cancel one of the agent's own schedules; false if unknown or not its own. */
  cancel(id: string): Promise<boolean>;
}

/** A bound was violated. Message is model-facing — phrase it as actionable. */
export class ScheduleError extends Error {}

/** The bounds on agent-authored future work (Phase 4c). */
export interface ScheduleLimits {
  /** Max pending agent triggers per agent; the next one is refused. */
  maxPending: number;
  /** A first fire can be at most this far out (caps one-shots like "in 5 years"). */
  maxHorizonMs: number;
  /** A recurring self-schedule may fire no more often than this (anti tight-loop). */
  minIntervalSeconds: number;
}

export const DEFAULT_LIMITS: ScheduleLimits = {
  maxPending: 25,
  maxHorizonMs: 90 * 24 * 60 * 60 * 1000, // 90 days
  minIntervalSeconds: 60,
};

/** Stable per-trigger session — a recurring routine is one ongoing thread. */
export function triggerSessionKey(agentId: string, triggerId: string): string {
  return `reef:${agentId}:trigger-${triggerId}`;
}

/**
 * The spine-backed capability handed to a run's tools. Stateless beyond its
 * bindings (spine + agentId + limits + clock), so it is cheap to build per run.
 */
export class DaemonScheduler implements SchedulerCapability {
  constructor(
    private readonly spine: Spine,
    private readonly agentId: string,
    private readonly limits: ScheduleLimits = DEFAULT_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async schedule(req: { spec: TriggerSpec; input: string }): Promise<SelfSchedule> {
    const { spec, input } = req;
    assertValidSpec(spec); // bad cron / interval / instant → throws

    if (!input.trim()) {
      throw new ScheduleError("a schedule needs a non-empty instruction for the future run");
    }

    const now = this.now();
    const first = nextFireTime(spec, now);
    if (!first) {
      throw new ScheduleError("that schedule has no upcoming fire — pick a time in the future");
    }

    // Horizon: the first fire can't be arbitrarily far out.
    if (first.getTime() - now.getTime() > this.limits.maxHorizonMs) {
      const days = Math.round(this.limits.maxHorizonMs / (24 * 60 * 60 * 1000));
      throw new ScheduleError(`that fires too far ahead — schedules must start within ${days} days`);
    }

    // Recurrence floor: a repeating schedule may not fire faster than the floor.
    const gapMs = recurrenceGapMs(spec, first);
    if (gapMs !== undefined && gapMs < this.limits.minIntervalSeconds * 1000) {
      throw new ScheduleError(
        `that recurs too frequently — repeating schedules must be at least ${this.limits.minIntervalSeconds}s apart`,
      );
    }

    // Count cap: bound the standing pile of agent-authored future work.
    if (this.spine.countPendingAgentTriggers(this.agentId) >= this.limits.maxPending) {
      throw new ScheduleError(
        `you already have ${this.limits.maxPending} pending schedules (the max) — cancel one before adding another`,
      );
    }

    const id = newTriggerId();
    const trigger: Trigger = {
      id,
      agentId: this.agentId,
      type: "schedule",
      spec,
      input,
      sessionKey: triggerSessionKey(this.agentId, id),
      createdBy: "agent",
      enabled: true,
      // A self-scheduled wake the daemon slept through still runs once on wake —
      // "check back tomorrow" matters even if reef was down at the appointed time.
      catchUpPolicy: "fire_once",
      nextFireAt: first.toISOString(),
      createdAt: nowIso(),
    };
    this.spine.createTrigger(trigger);
    return toSelf(trigger);
  }

  async list(): Promise<SelfSchedule[]> {
    return this.spine
      .listTriggers(this.agentId)
      .filter((t) => t.createdBy === "agent" && t.enabled && t.nextFireAt)
      .map(toSelf);
  }

  async cancel(id: string): Promise<boolean> {
    const t = this.spine.getTrigger(id);
    // Only the agent's own self-scheduled triggers — never an operator routine
    // or the heartbeat, even if the model guesses an id.
    if (!t || t.agentId !== this.agentId || t.createdBy !== "agent") return false;
    this.spine.deleteTrigger(id);
    return true;
  }
}

function toSelf(t: Trigger): SelfSchedule {
  return { id: t.id, spec: t.spec, input: t.input, nextFireAt: t.nextFireAt, createdAt: t.createdAt };
}

/**
 * The interval between consecutive fires of a *recurring* spec, or undefined for
 * a one-shot (no recurrence to floor). For cron, the gap from the first fire to
 * the one after it — which is what bounds how often a `* * * * * *` would run.
 */
function recurrenceGapMs(spec: TriggerSpec, first: Date): number | undefined {
  if (spec.kind === "once") return undefined;
  if (spec.kind === "interval") return Math.max(1, Math.floor(spec.seconds)) * 1000;
  const second = nextFireTime(spec, first);
  return second ? second.getTime() - first.getTime() : undefined;
}
