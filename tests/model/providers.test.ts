import { describe, expect, it } from "vitest";
import { ProviderRegistry, parseModelId } from "../../src/model/providers.js";

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
});
