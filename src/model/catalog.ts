import type { ProviderKind } from "./providers.js";

// The built-in provider catalog — presets that make `reef setup` a pick-from-a-
// list flow instead of "type a base URL and guess the auth scheme". Each entry
// knows a provider's kind, endpoint, auth, and a few sample model ids; setup
// only has to ask for the API key (and which model). A "custom" provider is
// always possible by entering the fields by hand.

export interface CatalogEntry {
  /** Suggested provider id (the `provider/` prefix in model ids). */
  id: string;
  /** Menu label. */
  label: string;
  kind: ProviderKind;
  baseURL?: string;
  auth?: "bearer" | "x-api-key";
  /** Conventional env var, used as a key-resolution fallback and a hint. */
  apiKeyEnv?: string;
  /** Whether the provider needs an API key (Ollama, being local, does not). */
  needsKey: boolean;
  /** A few model ids to suggest as the default. */
  sampleModels: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    needsKey: true,
    sampleModels: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    needsKey: true,
    sampleModels: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "ollama",
    label: "Ollama (local, free — no key)",
    kind: "openai-compatible",
    baseURL: "http://localhost:11434/v1",
    needsKey: false,
    sampleModels: ["llama3.1", "qwen2.5", "deepseek-r1"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models, cheap)",
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    needsKey: true,
    sampleModels: ["meta-llama/llama-3.1-70b-instruct", "deepseek/deepseek-chat"],
  },
  {
    id: "zai",
    label: "Z.ai (GLM, general API)",
    kind: "openai-compatible",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    needsKey: true,
    sampleModels: ["glm-4.6", "glm-4.7"],
  },
  {
    id: "zai-coding",
    label: "Z.ai Coding Plan (GLM, cheap)",
    kind: "openai-compatible",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    needsKey: true,
    sampleModels: ["glm-4.6", "glm-5.1"],
  },
  {
    id: "opencode",
    label: "OpenCode Go (open models, subscription)",
    kind: "openai-compatible",
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    needsKey: true,
    sampleModels: ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"],
  },
  {
    id: "opencode-anthropic",
    label: "OpenCode Go (Anthropic-protocol models)",
    kind: "anthropic",
    baseURL: "https://opencode.ai/zen/go/v1",
    auth: "bearer",
    apiKeyEnv: "OPENCODE_API_KEY",
    needsKey: true,
    sampleModels: ["minimax-m3", "qwen3.7-max"],
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
