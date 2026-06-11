import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

/** The raw config object on disk (unknown keys intact), or undefined if absent.
 *  Editors (the CLI, the TUI) work on the raw object so they preserve keys the
 *  schema doesn't know yet; loadConfig is for the daemon's typed read. */
export function readRawConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Write a raw config object (pretty-printed), creating the directory if needed. */
export function writeRawConfig(path: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Validate + normalize a raw config object (throws on a schema violation). */
export function parseConfig(raw: unknown): ReefConfig {
  const parsed = configSchema.parse(raw);
  return {
    defaultModel: parsed.defaultModel,
    providers: parsed.providers ?? [],
    policyFile: parsed.policyFile,
  };
}

/** A scalar config key the CLI can set directly. */
export type ScalarKey = "defaultModel" | "policyFile";

/** A single edit the `reef config` CLI applies to the raw config object. */
export type ConfigEdit =
  | { op: "set"; key: ScalarKey; value: string }
  | { op: "unset"; key: ScalarKey }
  | { op: "provider-set"; provider: { id: string; kind: string; baseURL?: string; apiKeyEnv?: string } }
  | { op: "provider-rm"; id: string };

/**
 * Apply an edit to the RAW config object (not the parsed view) so unknown keys
 * a newer reef might use are preserved, then validate the result — throwing if
 * the edit would make the config invalid, so the CLI never writes a file the
 * daemon would reject. Pure: returns a new object, mutates nothing.
 */
export function applyConfigEdit(
  raw: Record<string, unknown>,
  edit: ConfigEdit,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  const providerList = (): Array<Record<string, unknown>> =>
    Array.isArray(next.providers) ? [...(next.providers as Array<Record<string, unknown>>)] : [];
  const idOf = (p: Record<string, unknown>): unknown => p?.id;

  switch (edit.op) {
    case "set":
      next[edit.key] = edit.value;
      break;
    case "unset":
      delete next[edit.key];
      break;
    case "provider-set": {
      const providers = providerList();
      const i = providers.findIndex((p) => idOf(p) === edit.provider.id);
      // drop undefined optionals so we don't write null/empty keys
      const entry = Object.fromEntries(Object.entries(edit.provider).filter(([, v]) => v !== undefined));
      if (i >= 0) providers[i] = entry;
      else providers.push(entry);
      next.providers = providers;
      break;
    }
    case "provider-rm":
      next.providers = providerList().filter((p) => idOf(p) !== edit.id);
      break;
  }
  parseConfig(next); // throws if the edit produced an invalid config
  return next;
}

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
    const config = parseConfig(raw);
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
