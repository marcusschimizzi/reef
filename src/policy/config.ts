import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DefaultPolicy, type ApprovalPolicy } from "./policy.js";
import { ConfigurablePolicy, type PolicyRule } from "./rules.js";

// Loads the user's approval policy from a JSON file. Fail-safe by construction:
// an absent, unreadable, or schema-invalid config yields DefaultPolicy (today's
// behavior) rather than an empty/garbage rule set — a broken config must never
// silently grant authority. The shape is validated with zod; the command
// matcher's prefixes are required non-empty (an empty prefix would match every
// command — refused here and in command.ts).

const commandMatchSchema = z.object({
  argvPrefixIn: z.array(z.array(z.string()).min(1)).min(1),
});

const ruleSchema = z.object({
  tool: z.string().optional(),
  agent: z.string().optional(),
  source: z.enum(["message", "trigger"]).optional(),
  command: commandMatchSchema.optional(),
  action: z.enum(["allow", "gate", "deny"]),
  reason: z.string().optional(),
});

const configSchema = z.object({ rules: z.array(ruleSchema) });

/**
 * Build the approval policy from a config file path. The `fallback` is used when
 * no rule matches, and is also returned wholesale when the path is unset/missing
 * or the file fails to parse/validate (logging why) — so authority is never
 * granted by a malformed config. The caller passes a DefaultPolicy configured for
 * the proactive-approval mode (deny vs route).
 */
export function loadPolicy(
  path: string | undefined,
  log: (message: string) => void = () => {},
  fallback: ApprovalPolicy = new DefaultPolicy(),
): ApprovalPolicy {
  if (!path || !existsSync(path)) return fallback;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const config = configSchema.parse(raw);
    log(`approval policy loaded from ${path} (${config.rules.length} rule(s))`);
    return new ConfigurablePolicy(config.rules as PolicyRule[], fallback);
  } catch (err) {
    log(`approval policy at ${path} is invalid — falling back to default: ${String(err)}`);
    return fallback;
  }
}
