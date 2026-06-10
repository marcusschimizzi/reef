import { Cron } from "croner";
import type { TriggerSpec } from "../core/types.js";

// Next-fire computation for scheduled triggers (Phase 4a). The ONE place that
// understands a schedule spec — the scheduler only ever asks "when next, after
// this instant?". Cron parsing is delegated to croner (zero-dependency); it is
// quarantined here so swapping the cron implementation (or hand-rolling it)
// touches nothing else. Intervals are computed directly.

/**
 * The next time this spec should fire strictly after `after`, or undefined if
 * the schedule is exhausted (a cron that never matches again). For intervals,
 * fires every `seconds` from `after`.
 */
export function nextFireTime(spec: TriggerSpec, after: Date): Date | undefined {
  switch (spec.kind) {
    case "interval": {
      const ms = Math.max(1, Math.floor(spec.seconds)) * 1000;
      return new Date(after.getTime() + ms);
    }
    case "cron": {
      // croner's nextRun(date) returns the next run strictly after `date`.
      const cron = new Cron(spec.expr, spec.tz ? { timezone: spec.tz } : {});
      return cron.nextRun(after) ?? undefined;
    }
  }
}

/** Validate a spec up front (cron expressions especially), throwing on garbage. */
export function assertValidSpec(spec: TriggerSpec): void {
  if (spec.kind === "interval") {
    if (!(spec.seconds > 0)) throw new Error("interval trigger needs seconds > 0");
    return;
  }
  // Constructing a Cron throws on an unparseable expression.
  const cron = new Cron(spec.expr, spec.tz ? { timezone: spec.tz } : {});
  if (!cron.nextRun()) {
    throw new Error(`cron expression has no future runs: ${spec.expr}`);
  }
}
