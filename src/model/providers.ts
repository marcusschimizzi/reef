import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// The provider registry — reef's map from a `provider/model` id to a vendored
// (AI SDK) language model. Providers are described by *kind*: `anthropic`,
// `openai`, or the generic `openai-compatible` (a baseURL + key). That last kind
// is the lever — Ollama, OpenRouter, Z.ai, and most gateways speak the OpenAI
// wire format, so they're configured endpoints, not bespoke integrations. The
// loop never sees any of this; it only knows the ModelRouter interface
// (reef-docs/09: own the loop, vendor the routing).

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export interface ProviderConfig {
  /** The id used as the model-id prefix, e.g. "openrouter" in "openrouter/foo". */
  id: string;
  kind: ProviderKind;
  /** API base URL — required for `openai-compatible`, an optional override else. */
  baseURL?: string;
  /** A literal API key, or `apiKeyEnv` to read one from the environment. */
  apiKey?: string;
  apiKeyEnv?: string;
  /**
   * How the key is sent. Matters for `anthropic`-kind gateways: "x-api-key" (the
   * default — real Anthropic) vs "bearer" (`Authorization: Bearer`, what most
   * Anthropic-compatible gateways like OpenCode want). openai/openai-compatible
   * always use Bearer regardless.
   */
  auth?: "bearer" | "x-api-key";
}

/** Built-in providers, wired from conventional env vars (no config needed). The
 *  cheap/free ones — Ollama (local), OpenRouter — are first-class so dev doesn't
 *  burn premium credits. Custom endpoints (Z.ai, etc.) are added via config. */
const BUILTINS: ProviderConfig[] = [
  { id: "anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "openai", kind: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  // Ollama ignores the key but the client requires a non-empty one.
  { id: "ollama", kind: "openai-compatible", baseURL: "http://localhost:11434/v1", apiKey: "ollama" },
  { id: "openrouter", kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
];

/** A bare model id (no `provider/` prefix) is Anthropic — preserves old configs. */
export const DEFAULT_PROVIDER = "anthropic";

export interface ParsedModelId {
  provider: string;
  model: string;
}

/** Split "provider/model" on the FIRST slash (the model may contain more, e.g.
 *  OpenRouter's "vendor/model"); a bare id resolves to the default provider. */
export function parseModelId(id: string): ParsedModelId {
  const slash = id.indexOf("/");
  if (slash === -1) return { provider: DEFAULT_PROVIDER, model: id };
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly factories = new Map<string, (model: string) => LanguageModel>();

  /** Built-ins first, then user providers (so config can override a built-in). */
  constructor(providers: ProviderConfig[] = []) {
    for (const p of [...BUILTINS, ...providers]) this.configs.set(p.id, p);
  }

  /** The provider ids this registry knows. */
  list(): string[] {
    return [...this.configs.keys()];
  }

  resolve(modelId: string): LanguageModel {
    const { provider, model } = parseModelId(modelId);
    return this.factoryFor(provider)(model);
  }

  private factoryFor(providerId: string): (model: string) => LanguageModel {
    const cached = this.factories.get(providerId);
    if (cached) return cached;
    const config = this.configs.get(providerId);
    if (!config) {
      throw new Error(`unknown model provider "${providerId}" — configure it in .reef/config.json`);
    }
    const factory = build(config);
    this.factories.set(providerId, factory);
    return factory;
  }
}

function apiKeyOf(c: ProviderConfig): string | undefined {
  const key = c.apiKey ?? (c.apiKeyEnv ? process.env[c.apiKeyEnv] : undefined);
  return key?.trim() ? key : undefined; // empty/whitespace → treat as unset
}

/**
 * Configured providers whose API key env var is unset or empty — so the daemon
 * can warn at startup instead of failing with a 401 mid-run. Returns
 * `["zai (ZAI_API_KEY)", …]` for the offenders.
 */
export function missingProviderKeys(providers: ProviderConfig[]): string[] {
  return providers
    .filter((p) => p.apiKeyEnv && !p.apiKey && !process.env[p.apiKeyEnv]?.trim())
    .map((p) => `${p.id} (${p.apiKeyEnv})`);
}

function build(c: ProviderConfig): (model: string) => LanguageModel {
  switch (c.kind) {
    case "anthropic": {
      const key = apiKeyOf(c);
      // Bearer (authToken) for gateways; x-api-key (apiKey) for real Anthropic.
      const provider = createAnthropic(
        c.auth === "bearer"
          ? { baseURL: c.baseURL, authToken: key }
          : { baseURL: c.baseURL, apiKey: key },
      );
      return (model) => provider(model);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: apiKeyOf(c), baseURL: c.baseURL });
      return (model) => provider(model);
    }
    case "openai-compatible": {
      if (!c.baseURL) {
        throw new Error(`provider "${c.id}" (openai-compatible) needs a baseURL`);
      }
      const provider = createOpenAICompatible({ name: c.id, baseURL: c.baseURL, apiKey: apiKeyOf(c) });
      return (model) => provider(model);
    }
  }
}
