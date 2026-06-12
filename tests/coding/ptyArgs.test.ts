import { describe, expect, it } from "vitest";
import { claudeArgs } from "../../src/coding/ptyClaude.js";

describe("claudeArgs", () => {
  it("includes --session-id and the task, no --model by default", () => {
    const args = claudeArgs({ directory: "/x", sessionId: "uuid-1", task: "do it" });
    expect(args).toEqual(["--session-id", "uuid-1", "do it"]);
    expect(args).not.toContain("--model");
  });

  it("adds --model before the task when a model is set", () => {
    const args = claudeArgs({ directory: "/x", sessionId: "uuid-1", task: "do it", model: "haiku" });
    expect(args).toEqual(["--session-id", "uuid-1", "--model", "haiku", "do it"]);
  });

  it("includes --append-system-prompt when set", () => {
    const args = claudeArgs({ directory: "/x", sessionId: "u", task: "t", model: "haiku", appendSystemPrompt: "hint" });
    expect(args).toEqual(["--session-id", "u", "--model", "haiku", "--append-system-prompt", "hint", "t"]);
  });
});
