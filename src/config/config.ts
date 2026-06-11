import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { ProviderConfig } from "../model/providers.js";

// Reef's user configuration — the one place non-secret settings live (the rest
// was scattered across env vars and hardcoded defaults). Mirrors the policy
// loader's contract: zod-validated and FAIL-SOFT, so an absent/unreadable/
// invalid config yields safe defaults rather than crashing the daemon. Secrets
// never live here — a provider names the ENV VAR its key comes from (apiKeyEnv),
// never the key itself. Unknown keys are tolerated (zod strips them), so a config
// written for a newer reef still loads on an older one.

// Secrets-in-env: the config carries `apiKeyEnv` (a variable name), not a key.
const providerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["anthropic", "openai", "openai-compatible"]),
  baseURL: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

const configSchema = z.object({
  /** Default agent model as `provider/model` (env REEF_MODEL still overrides). */
  defaultModel: z.string().optional(),
  /** Custom providers (e.g. Z.ai, OpenCode Go) extending the built-in registry. */
  providers: z.array(providerSchema).optional(),
  /** Path to the approval-policy file (env REEF_POLICY_FILE still overrides). */
  policyFile: z.string().optional(),
});

export interface ReefConfig {
  defaultModel?: string;
  providers: ProviderConfig[];
  policyFile?: string;
}

const EMPTY: ReefConfig = { providers: [] };

/**
 * Load config from a JSON file. Returns safe defaults (no providers, no
 * overrides) when the path is unset/missing or the file fails to parse/validate,
 * logging why — a broken config must never take the daemon down or change
 * behavior silently.
 */
export function loadConfig(
  path: string | undefined,
  log: (message: string) => void = () => {},
): ReefConfig {
  if (!path || !existsSync(path)) return EMPTY;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = configSchema.parse(raw);
    const config: ReefConfig = {
      defaultModel: parsed.defaultModel,
      providers: parsed.providers ?? [],
      policyFile: parsed.policyFile,
    };
    log(
      `config loaded from ${path}` +
        (config.providers.length ? ` (${config.providers.length} custom provider(s))` : ""),
    );
    return config;
  } catch (err) {
    log(`config at ${path} is invalid — using defaults: ${String(err)}`);
    return EMPTY;
  }
}
