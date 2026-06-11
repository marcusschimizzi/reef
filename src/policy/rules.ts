import {
  DefaultPolicy,
  type ApprovalPolicy,
  type PolicyAction,
  type PolicyContext,
  type PolicyDecision,
} from "./policy.js";
import { commandMatchesAllowlist } from "./command.js";

// A generic, user-configurable approval policy: an ordered list of rules,
// first-match-wins, falling through to a fallback (DefaultPolicy) when none
// match. Rules are pure data the user owns — they can loosen (allow a safe
// command) or tighten (deny a tool) without touching code. The only
// input-aware matcher is `command`, which reads a shell tool's `input.command`
// and admits it only through the command-safety floor (see command.ts).

/** Matches a shell command by its parsed argv prefix, behind the safety floor. */
export interface CommandMatch {
  /** Auto-match if the command's argv starts with one of these token prefixes. */
  argvPrefixIn: string[][];
}

/** All present criteria must match; then the rule's action is returned. */
export interface PolicyRule {
  tool?: string;
  agent?: string;
  source?: "message" | "trigger";
  command?: CommandMatch;
  action: PolicyAction;
  reason?: string;
}

export class ConfigurablePolicy implements ApprovalPolicy {
  constructor(
    private readonly rules: PolicyRule[],
    private readonly fallback: ApprovalPolicy = new DefaultPolicy(),
  ) {}

  decide(ctx: PolicyContext): PolicyDecision {
    for (const rule of this.rules) {
      if (matches(rule, ctx)) return { action: rule.action, reason: rule.reason };
    }
    return this.fallback.decide(ctx);
  }
}

function matches(rule: PolicyRule, ctx: PolicyContext): boolean {
  if (rule.tool !== undefined && rule.tool !== ctx.toolName) return false;
  if (rule.agent !== undefined && rule.agent !== ctx.agentId) return false;
  if (rule.source !== undefined && rule.source !== ctx.source.kind) return false;
  if (rule.command !== undefined) {
    const command = extractCommand(ctx.input);
    if (command === undefined) return false; // no command to match (wrong tool shape)
    if (!commandMatchesAllowlist(command, rule.command.argvPrefixIn)) return false;
  }
  return true;
}

/** Pull a string `command` field out of a tool's input, if present (shell). */
function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const value = (input as { command: unknown }).command;
    if (typeof value === "string") return value;
  }
  return undefined;
}
