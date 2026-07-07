import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { VercelRouter } from "../../src/model/router.js";
import { ProviderRegistry } from "../../src/model/providers.js";

/** A registry that resolves every model id to the given mock — the offline seam
 *  for exercising the real streamText translation layer (RF-30's foothold). */
class FakeRegistry extends ProviderRegistry {
  constructor(private readonly model: LanguageModel) {
    super();
  }
  override resolve(_modelId: string): LanguageModel {
    return this.model;
  }
}

const usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};

describe("VercelRouter", () => {
  it("surfaces the provider's real error cause from a stream error, not a generic no-output failure (RF-10)", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("Overloaded: the provider returned 529") },
        ]),
      }),
    });
    const router = new VercelRouter([], undefined, new FakeRegistry(model));

    // A 529/429/401 must be tellable apart in run.failed, the TUI, and logs —
    // the original provider message is the diagnosis.
    await expect(
      router.generateTurn({
        model: "anthropic/claude-x",
        system: "be helpful",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toThrow(/Overloaded: the provider returned 529/);
  });

  it("stringifies a non-Error stream error meaningfully (not '[object Object]')", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "error", error: { status: 529, message: "overloaded" } },
        ]),
      }),
    });
    const router = new VercelRouter([], undefined, new FakeRegistry(model));

    await expect(
      router.generateTurn({
        model: "anthropic/claude-x",
        system: "be helpful",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).rejects.toThrow(/529/);
  });

  it("streams text deltas and maps content, stop, and usage on the happy path", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "hello" },
          { type: "text-delta", id: "1", delta: " world" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop" }, usage },
        ]),
      }),
    });
    const router = new VercelRouter([], undefined, new FakeRegistry(model));

    const deltas: string[] = [];
    const turn = await router.generateTurn({
      model: "anthropic/claude-x",
      system: "be helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      onTextDelta: (t) => deltas.push(t),
    });

    expect(turn.content).toEqual([{ type: "text", text: "hello world" }]);
    expect(turn.stop).toBe("completed");
    expect(turn.usage.inputTokens).toBe(7);
    expect(turn.usage.outputTokens).toBe(3);
    expect(deltas.join("")).toBe("hello world");
  });
});
