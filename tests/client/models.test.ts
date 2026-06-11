import { describe, expect, it } from "vitest";
import { buildModelOptions, normalizeModelId } from "../../src/client/tui/models.js";
import { emptyIndex, type SessionIndex } from "../../src/client/tui/sessionIndex.js";
import type { SessionSummary } from "../../src/core/types.js";

const session = (over: Partial<SessionSummary> & { sessionKey: string }): SessionSummary => ({
  agentId: "reef",
  status: "idle",
  title: "t",
  preview: "",
  pendingApprovals: 0,
  lastActivityAt: "",
  createdAt: "",
  ...over,
});

describe("normalizeModelId", () => {
  it("prefixes a bare id with the default (anthropic) provider; leaves prefixed ids alone", () => {
    expect(normalizeModelId("claude-opus-4-8")).toBe("anthropic/claude-opus-4-8");
    expect(normalizeModelId("openai/gpt-4o")).toBe("openai/gpt-4o");
  });
});

describe("buildModelOptions", () => {
  it("includes catalog models for a configured provider — sample models AND protocol overrides", () => {
    const raw = {
      providers: [
        { id: "opencode", kind: "openai-compatible", baseURL: "https://x", apiKeyEnv: "OPENCODE_API_KEY" },
      ],
    };
    const ids = buildModelOptions(raw, emptyIndex).map((o) => o.id);
    expect(ids).toContain("opencode/glm-5.1"); // a sampleModel
    expect(ids).toContain("opencode/minimax-m3"); // an override (anthropic-protocol) model
  });

  it("surfaces built-in models, models in use, and the default; pins a custom entry last", () => {
    const idx: SessionIndex = { s1: session({ sessionKey: "s1", model: "zai/glm-4.6" }) };
    const opts = buildModelOptions({ defaultModel: "claude-opus-4-8" }, idx);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("anthropic/claude-opus-4-8"); // built-in catalog + default
    expect(ids).toContain("openai/gpt-4o"); // a built-in provider model
    expect(ids).toContain("zai/glm-4.6"); // a model already in use
    expect(opts[opts.length - 1]).toMatchObject({ custom: true, id: "" });
  });

  it("dedupes a bare default against its prefixed catalog form", () => {
    const opts = buildModelOptions({ defaultModel: "claude-opus-4-8" }, emptyIndex);
    expect(opts.filter((o) => o.id === "anthropic/claude-opus-4-8")).toHaveLength(1);
  });
});
