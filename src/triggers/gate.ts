import type { Trigger } from "../core/types.js";

// The proactive gate (Phase 4b) — a seam distinct from the permission gate.
// Permission asks "may this action run?"; the proactive gate asks "is now a
// good time for opportunistic self-maintenance at all?". It governs heartbeat
// triggers so periodic reflection/tidying doesn't fire pointlessly or pile up.
//
// Modelled on openhuman's scheduler_gate/policy.rs (battery/idle suppression).
// The default below implements only the cross-platform, reef-internal half;
// platform-specific signals (on battery, user idle) are a future gate that
// wraps or replaces this one via DaemonOptions.gate — the seam, allow-mostly
// stub now, real policy later (same shape as the fs broker and memory backend).

export interface GateContext {
  now: Date;
  /** True if the daemon is already running a run — don't stack maintenance on it. */
  busy: boolean;
  trigger: Trigger;
}

export interface GateDecision {
  allow: boolean;
  /** Why a fire was suppressed (for logging / future observability). */
  reason?: string;
}

export interface ProactiveGate {
  check(ctx: GateContext): GateDecision | Promise<GateDecision>;
}

/**
 * Default: run opportunistic self-maintenance only when reef is otherwise idle.
 * If a run is already active, skip this tick — the next interval gets another
 * chance, so a heartbeat never queues behind active work and stale maintenance
 * runs never accumulate. This is the "run when idle" half of the gate using
 * purely cross-platform, reef-internal state.
 */
export class DefaultGate implements ProactiveGate {
  check(ctx: GateContext): GateDecision {
    if (ctx.busy) return { allow: false, reason: "a run is already active" };
    return { allow: true };
  }
}
