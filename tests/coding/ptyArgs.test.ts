import { describe, expect, it } from "vitest";
import { claudeArgs, claudeEnv } from "../../src/coding/ptyClaude.js";

describe("claudeEnv", () => {
  it("strips API-key credentials so the session bills against the Max plan", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-test";
    try {
      const env = claudeEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.TERM).toBe("xterm-256color");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});

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

  it("includes --settings before --append-system-prompt when set", () => {
    const args = claudeArgs({ directory: "/x", sessionId: "u", task: "t", settingsPath: "/tmp/s.json", appendSystemPrompt: "hint" });
    expect(args).toEqual(["--session-id", "u", "--settings", "/tmp/s.json", "--append-system-prompt", "hint", "t"]);
  });

  it("uses --resume (not --session-id) in resume mode, with the text as the prompt", () => {
    const args = claudeArgs({ directory: "/x", sessionId: "uuid-1", task: "now do step 2", resume: true, model: "haiku" });
    expect(args).toEqual(["--resume", "uuid-1", "--model", "haiku", "now do step 2"]);
    expect(args).not.toContain("--session-id");
  });
});
