import { afterEach, describe, expect, it } from "vitest";
import { ProviderRegistry, missingProviderKeys, parseModelId, withOverride } from "../../src/model/providers.js";
import { catalogEntry } from "../../src/model/catalog.js";
import type { ProviderConfig } from "../../src/model/providers.js";

describe("parseModelId", () => {
  it("splits on the first slash; the model may contain more (OpenRouter)", () => {
    expect(parseModelId("openrouter/anthropic/claude-3.5-sonnet")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(parseModelId("ollama/llama3.1")).toEqual({ provider: "ollama", model: "llama3.1" });
  });

  it("treats a bare id as the default (Anthropic) — old configs keep working", () => {
    expect(parseModelId("claude-opus-4-8")).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });
});

describe("ProviderRegistry", () => {
  it("resolves all built-in providers without a network call", () => {
    const r = new ProviderRegistry();
    for (const id of ["claude-opus-4-8", "openai/gpt-4o", "ollama/llama3.1", "openrouter/meta-llama/llama-3.1"]) {
      expect(r.resolve(id), id).toBeDefined();
    }
    expect(r.list()).toEqual(expect.arrayContaining(["anthropic", "openai", "ollama", "openrouter"]));
  });

  it("throws for an unknown provider, pointing at config", () => {
    expect(() => new ProviderRegistry().resolve("mystery/model")).toThrow(/unknown model provider/);
  });

  it("accepts a user-configured openai-compatible endpoint", () => {
    const r = new ProviderRegistry([
      { id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/v1", apiKey: "k" },
    ]);
    expect(r.resolve("zai/glm-4.6")).toBeDefined();
    expect(r.list()).toContain("zai");
  });

  it("rejects an openai-compatible provider with no baseURL", () => {
    const r = new ProviderRegistry([{ id: "bad", kind: "openai-compatible" }]);
    expect(() => r.resolve("bad/model")).toThrow(/needs a baseURL/);
  });

  it("lets a user provider override a built-in of the same id", () => {
    const r = new ProviderRegistry([
      { id: "openai", kind: "openai-compatible", baseURL: "https://proxy.local/v1", apiKey: "k" },
    ]);
    expect(r.resolve("openai/gpt-4o")).toBeDefined(); // resolves via the override
  });

  it("routes per-model via overrides: one provider, one key, right protocol", () => {
    // the OpenCode Go catalog entry — most models openai-compatible, MiniMax/Qwen anthropic
    const opencode = catalogEntry("opencode")!;
    const config: ProviderConfig = {
      id: "opencode",
      kind: opencode.kind,
      baseURL: opencode.baseURL,
      apiKeyEnv: opencode.apiKeyEnv,
      overrides: opencode.overrides,
    };
    // a GLM model keeps the provider default (openai-compatible)
    expect(withOverride(config, "glm-5.1").kind).toBe("openai-compatible");
    // a MiniMax/Qwen model is routed to the anthropic protocol + bearer, same key/baseURL
    const minimax = withOverride(config, "minimax-m3");
    expect(minimax).toMatchObject({ kind: "anthropic", auth: "bearer", apiKeyEnv: "OPENCODE_API_KEY" });
    expect(minimax.baseURL).toBe(config.baseURL);

    // and both resolve through one registry/provider without error
    const r = new ProviderRegistry([config]);
    expect(r.resolve("opencode/glm-5.1")).toBeDefined();
    expect(r.resolve("opencode/minimax-m3")).toBeDefined();
  });

  it("resolves an anthropic-compatible gateway using bearer auth", () => {
    const r = new ProviderRegistry([
      { id: "opencode-anthropic", kind: "anthropic", baseURL: "https://opencode.ai/zen/go/v1", apiKey: "k", auth: "bearer" },
    ]);
    expect(r.resolve("opencode-anthropic/minimax-m3")).toBeDefined();
  });
});

describe("missingProviderKeys", () => {
  const saved = process.env.SOME_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.SOME_KEY;
    else process.env.SOME_KEY = saved;
  });

  it("flags providers whose key env var is unset or empty, not those with a key", () => {
    delete process.env.SOME_KEY;
    const missing = missingProviderKeys([
      { id: "needy", kind: "openai-compatible", baseURL: "https://x", apiKeyEnv: "SOME_KEY" },
      { id: "literal", kind: "openai", apiKey: "sk-..." }, // literal key → fine
      { id: "ollama", kind: "openai-compatible", baseURL: "https://x" }, // no key needed
    ]);
    expect(missing).toEqual(["needy (no key — run `npm run setup`, or set SOME_KEY)"]);

    process.env.SOME_KEY = "set-now";
    expect(missingProviderKeys([{ id: "needy", kind: "openai-compatible", apiKeyEnv: "SOME_KEY" }])).toEqual([]);
  });

  it("treats a key present in the secret store as not-missing", () => {
    delete process.env.SOME_KEY;
    const store = {
      backend: "test",
      get: (id: string) => (id === "zai" ? "stored-key" : undefined),
      set: () => {},
      delete: () => {},
    };
    const providers = [{ id: "zai", kind: "openai-compatible" as const, baseURL: "https://x", apiKeyEnv: "SOME_KEY" }];
    expect(missingProviderKeys(providers)).toEqual(["zai (no key — run `npm run setup`, or set SOME_KEY)"]);
    expect(missingProviderKeys(providers, store)).toEqual([]); // key is in the store
  });

  it("never echoes a value-like apiKeyEnv (no secret in logs)", () => {
    const missing = missingProviderKeys([
      { id: "zai", kind: "openai-compatible", baseURL: "https://x", apiKeyEnv: "sk-super-secret-123" },
    ]);
    expect(missing).toHaveLength(1);
    expect(missing[0]).not.toContain("sk-super-secret-123");
    expect(missing[0]).toMatch(/must be an env var NAME/);
  });
});
