import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.js";

const dirs: string[] = [];
function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reef-config-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a valid config with custom providers", () => {
    const path = tmpFile(
      JSON.stringify({
        defaultModel: "ollama/llama3.1",
        policyFile: ".reef/policy.json",
        providers: [{ id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/v1", apiKeyEnv: "ZAI_API_KEY" }],
      }),
    );
    expect(loadConfig(path)).toEqual({
      defaultModel: "ollama/llama3.1",
      policyFile: ".reef/policy.json",
      providers: [{ id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/v1", apiKeyEnv: "ZAI_API_KEY" }],
      surfaces: [],
      proactiveApproval: "deny",
    });
  });

  it("returns safe defaults when the path is unset or missing", () => {
    expect(loadConfig(undefined)).toEqual({ providers: [], surfaces: [], proactiveApproval: "deny" });
    expect(loadConfig("/no/such/config.json")).toEqual({ providers: [], surfaces: [], proactiveApproval: "deny" });
  });

  it("parses surfaces and proactive-approval settings", () => {
    const path = tmpFile(
      JSON.stringify({
        proactiveApproval: "route",
        proactiveApprovalTimeoutSeconds: 1800,
        surfaces: [{ kind: "desktop" }, { kind: "webhook", urlEnv: "WH_URL" }],
      }),
    );
    expect(loadConfig(path)).toMatchObject({
      proactiveApproval: "route",
      proactiveApprovalTimeoutSeconds: 1800,
      surfaces: [{ kind: "desktop" }, { kind: "webhook", urlEnv: "WH_URL" }],
    });
  });

  it("falls back to defaults (and logs) on invalid JSON or a schema violation", () => {
    const logs: string[] = [];
    const empty = { providers: [], surfaces: [], proactiveApproval: "deny" };
    expect(loadConfig(tmpFile("{ broken"), (m) => logs.push(m))).toEqual(empty);
    // bad provider kind → schema violation
    const badKind = tmpFile(JSON.stringify({ providers: [{ id: "x", kind: "grpc" }] }));
    expect(loadConfig(badKind, (m) => logs.push(m))).toEqual(empty);
    expect(logs).toHaveLength(2);
  });

  it("rejects a value-like apiKeyEnv (a key must never live in config) without echoing it", () => {
    const logs: string[] = [];
    const path = tmpFile(
      JSON.stringify({ providers: [{ id: "zai", kind: "openai-compatible", baseURL: "https://x", apiKeyEnv: "sk-leak.123" }] }),
    );
    expect(loadConfig(path, (m) => logs.push(m))).toEqual({ providers: [], surfaces: [], proactiveApproval: "deny" });
    expect(logs.join(" ")).not.toContain("sk-leak.123");
  });

  it("tolerates unknown keys (a newer config still loads on an older reef)", () => {
    const path = tmpFile(JSON.stringify({ defaultModel: "x", somethingNew: true }));
    expect(loadConfig(path)).toEqual({ defaultModel: "x", providers: [], surfaces: [], proactiveApproval: "deny" });
  });

  it("never accepts a literal api key (secrets stay in env)", () => {
    // apiKey is not in the schema; it's stripped, leaving only apiKeyEnv
    const path = tmpFile(
      JSON.stringify({ providers: [{ id: "x", kind: "openai", apiKey: "sk-leak", apiKeyEnv: "X_KEY" }] }),
    );
    expect(loadConfig(path).providers[0]).toEqual({ id: "x", kind: "openai", apiKeyEnv: "X_KEY" });
  });
});
