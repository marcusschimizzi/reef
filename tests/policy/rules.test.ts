import { describe, expect, it } from "vitest";
import { ConfigurablePolicy } from "../../src/policy/rules.js";
import { DefaultPolicy } from "../../src/policy/policy.js";
import type { PolicyContext } from "../../src/policy/policy.js";

const ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  agentId: "reef",
  toolName: "shell",
  needsApproval: true,
  input: { command: "git diff" },
  source: { kind: "message" },
  sessionKey: "s1",
  ...over,
});

describe("ConfigurablePolicy", () => {
  it("auto-allows a safelisted shell command, but gates a sibling via the fallback", () => {
    const policy = new ConfigurablePolicy([
      { tool: "shell", command: { argvPrefixIn: [["git", "diff"]] }, action: "allow" },
    ]);
    expect(policy.decide(ctx({ input: { command: "git diff --stat" } }))).toEqual({
      action: "allow",
      reason: undefined,
    });
    // git push doesn't match the rule → falls through to DefaultPolicy → gate
    expect(policy.decide(ctx({ input: { command: "git push" } })).action).toBe("gate");
  });

  it("falls through to DefaultPolicy when no rule matches (behavior preserved)", () => {
    const policy = new ConfigurablePolicy([
      { tool: "shell", command: { argvPrefixIn: [["ls"]] }, action: "allow" },
    ]);
    // an ungated tool with no matching rule → DefaultPolicy → allow
    expect(policy.decide(ctx({ toolName: "read_file", needsApproval: false, input: {} })).action).toBe("allow");
    // a gated proactive run with no matching rule → DefaultPolicy → deny
    expect(
      policy
        .decide(ctx({ input: { command: "git push" }, source: { kind: "trigger", triggerId: "t", triggerType: "schedule" } }))
        .action,
    ).toBe("deny");
  });

  it("respects first-match order (a deny rule before an allow tightens)", () => {
    const policy = new ConfigurablePolicy([
      { tool: "shell", command: { argvPrefixIn: [["git", "diff"]] }, action: "deny", reason: "no git here" },
      { tool: "shell", command: { argvPrefixIn: [["git"]] }, action: "allow" },
    ]);
    expect(policy.decide(ctx({ input: { command: "git diff" } }))).toEqual({
      action: "deny",
      reason: "no git here",
    });
  });

  it("matches on agent and source dimensions", () => {
    const policy = new ConfigurablePolicy([
      { agent: "other", tool: "shell", action: "allow" },
    ]);
    // wrong agent → no match → fallback gate
    expect(policy.decide(ctx({ agentId: "reef" })).action).toBe("gate");
    // right agent, command-less allow is unconditional for that tool
    expect(policy.decide(ctx({ agentId: "other", input: { command: "anything goes" } })).action).toBe("allow");
  });

  it("a command rule never matches a tool whose input has no command", () => {
    const policy = new ConfigurablePolicy([
      { command: { argvPrefixIn: [["git", "diff"]] }, action: "allow" },
    ]);
    expect(policy.decide(ctx({ toolName: "write_file", input: { path: "x" } })).action).toBe("gate");
  });

  it("uses the provided fallback policy", () => {
    const denyAll = { decide: () => ({ action: "deny" as const, reason: "locked down" }) };
    const policy = new ConfigurablePolicy([], denyAll);
    expect(policy.decide(ctx({}))).toEqual({ action: "deny", reason: "locked down" });
  });
});
