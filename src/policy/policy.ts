import type { RunSource } from "../core/types.js";

// The approval-policy seam. Whether a tool call runs, suspends for a human, or
// is refused is a *policy decision*, not a static per-tool flag — so the rule
// can depend on the agent, the tool, its arguments, and how the run started.
// The loop consults a policy at the one decision point; the daemon injects which
// policy is in force (like the proactive gate). This is deliberately the shape a
// future user-configurable, rule-driven policy (and the broker's fs leases) slot
// into — the engine is generic; the rules are data the user owns.

export type PolicyAction = "allow" | "gate" | "deny";

export interface PolicyDecision {
  action: PolicyAction;
  /** Model-facing rationale for a deny; surfaced in the tool result and audit. */
  reason?: string;
}

export interface PolicyContext {
  agentId: string;
  toolName: string;
  /** The tool's own default sensitivity (its `needsApproval` flag). */
  needsApproval: boolean;
  input: unknown;
  /** How the run started — interactive vs a trigger (no human attached). */
  source: RunSource;
  sessionKey: string;
}

export interface ApprovalPolicy {
  decide(ctx: PolicyContext): PolicyDecision;
}

const ALLOW: PolicyDecision = { action: "allow" };

/** Reason shown when a proactive run can't get an approval no one will answer. */
export const PROACTIVE_DENY_REASON =
  "Approval required, but this run was started by a trigger with no human " +
  "available to approve it — treated as denied. Continue without this tool.";

/**
 * The default policy — reproduces reef's built-in behavior exactly, now
 * expressed as data rather than scattered loop branches:
 *   • an ungated tool always runs;
 *   • a gated tool in an interactive run suspends for human approval;
 *   • a gated tool in a proactive (trigger) run is denied — there is no human
 *     on that session to approve it (folds in the old hard-coded auto-deny).
 * A user-configurable policy wraps or replaces this; it is the floor.
 */
export class DefaultPolicy implements ApprovalPolicy {
  decide(ctx: PolicyContext): PolicyDecision {
    if (!ctx.needsApproval) return ALLOW;
    if (ctx.source.kind === "trigger") return { action: "deny", reason: PROACTIVE_DENY_REASON };
    return { action: "gate" };
  }
}
