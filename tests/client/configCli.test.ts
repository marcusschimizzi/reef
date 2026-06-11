import { describe, expect, it } from "vitest";
import { runConfigCli, type ConfigIo } from "../../src/client/config-cli.js";

/** An in-memory IO over a starting config object; captures output and writes. */
function io(start?: Record<string, unknown>): ConfigIo & { current?: Record<string, unknown>; lines: string[] } {
  const lines: string[] = [];
  const state = { current: start };
  return {
    path: "/tmp/.reef/config.json",
    lines,
    get current() {
      return state.current;
    },
    read: () => state.current,
    write: (raw) => {
      state.current = raw;
    },
    out: (line) => lines.push(line),
  };
}

describe("runConfigCli", () => {
  it("sets and gets a scalar key, validating before write", () => {
    const x = io();
    expect(runConfigCli(["set", "defaultModel", "ollama/llama3.1"], x)).toBe(0);
    expect(x.current).toEqual({ defaultModel: "ollama/llama3.1" });
    expect(x.lines.at(-1)).toMatch(/restart the daemon/);

    const g = io(x.current);
    expect(runConfigCli(["get", "defaultModel"], g)).toBe(0);
    expect(g.lines).toContain("ollama/llama3.1");
  });

  it("rejects an unknown scalar key without writing", () => {
    const x = io({ defaultModel: "x" });
    expect(runConfigCli(["set", "bogus", "1"], x)).toBe(1);
    expect(x.current).toEqual({ defaultModel: "x" }); // unchanged
  });

  it("adds, lists, and removes a provider", () => {
    const x = io();
    expect(
      runConfigCli(
        ["provider", "add", "zai", "openai-compatible", "--base-url", "https://api.z.ai/v1", "--api-key-env", "ZAI_API_KEY"],
        x,
      ),
    ).toBe(0);
    expect(x.current?.providers).toEqual([
      { id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/v1", apiKeyEnv: "ZAI_API_KEY" },
    ]);

    const r = io(x.current);
    expect(runConfigCli(["provider", "rm", "zai"], r)).toBe(0);
    expect(r.current?.providers).toEqual([]);
  });

  it("replaces a provider with the same id rather than duplicating", () => {
    let x = io();
    runConfigCli(["provider", "add", "zai", "openai-compatible", "--base-url", "https://a/v1"], x);
    x = io(x.current);
    runConfigCli(["provider", "add", "zai", "openai-compatible", "--base-url", "https://b/v1"], x);
    expect((x.current?.providers as unknown[]).length).toBe(1);
    expect((x.current?.providers as Array<{ baseURL: string }>)[0]?.baseURL).toBe("https://b/v1");
  });

  it("refuses a value-like --api-key-env and never echoes the secret", () => {
    const x = io();
    expect(
      runConfigCli(["provider", "add", "zai", "openai-compatible", "--base-url", "https://x", "--api-key-env", "sk-leak-xyz"], x),
    ).toBe(1);
    expect(x.current).toBeUndefined(); // nothing written
    expect(x.lines.join(" ")).not.toContain("sk-leak-xyz");
  });

  it("refuses an invalid edit (bad provider kind) and does not write", () => {
    const x = io({ defaultModel: "keep" });
    expect(runConfigCli(["provider", "add", "x", "grpc"], x)).toBe(1);
    expect(x.current).toEqual({ defaultModel: "keep" }); // untouched
    expect(x.lines.at(-1)).toMatch(/invalid edit/);
  });

  it("preserves unknown keys across an edit (forward-compat)", () => {
    const x = io({ somethingNew: { future: true } });
    runConfigCli(["set", "defaultModel", "x"], x);
    expect(x.current).toEqual({ somethingNew: { future: true }, defaultModel: "x" });
  });

  it("show prints the config and help prints usage", () => {
    const x = io({ defaultModel: "x" });
    runConfigCli(["show"], x);
    expect(x.lines.at(-1)).toContain("defaultModel");
    runConfigCli(["help"], x);
    expect(x.lines.at(-1)).toMatch(/reef config/);
  });
});
