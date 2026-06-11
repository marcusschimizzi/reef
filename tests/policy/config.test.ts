import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy } from "../../src/policy/config.js";
import type { PolicyContext } from "../../src/policy/policy.js";

const dirs: string[] = [];
function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reef-policy-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const shellCtx = (command: string): PolicyContext => ({
  agentId: "reef",
  toolName: "shell",
  needsApproval: true,
  input: { command },
  source: { kind: "message" },
  sessionKey: "s1",
});

describe("loadPolicy", () => {
  it("loads a valid config into a working ConfigurablePolicy", () => {
    const path = tmpFile(
      "policy.json",
      JSON.stringify({ rules: [{ tool: "shell", command: { argvPrefixIn: [["git", "diff"]] }, action: "allow" }] }),
    );
    const policy = loadPolicy(path);
    expect(policy.decide(shellCtx("git diff --stat")).action).toBe("allow");
    expect(policy.decide(shellCtx("git push")).action).toBe("gate"); // fallback
  });

  it("falls back to DefaultPolicy when the path is unset or missing", () => {
    expect(loadPolicy(undefined).decide(shellCtx("git diff")).action).toBe("gate");
    expect(loadPolicy("/no/such/policy.json").decide(shellCtx("git diff")).action).toBe("gate");
  });

  it("falls back (and logs) on invalid JSON or a schema violation — never grants authority", () => {
    const logs: string[] = [];
    const bad = tmpFile("bad.json", "{ not json");
    expect(loadPolicy(bad, (m) => logs.push(m)).decide(shellCtx("git diff")).action).toBe("gate");

    // schema violation: an empty argv prefix is refused at load
    const emptyPrefix = tmpFile(
      "empty.json",
      JSON.stringify({ rules: [{ tool: "shell", command: { argvPrefixIn: [[]] }, action: "allow" }] }),
    );
    expect(loadPolicy(emptyPrefix, (m) => logs.push(m)).decide(shellCtx("anything")).action).toBe("gate");
    expect(logs.length).toBe(2);
  });
});
