import { describe, expect, it } from "vitest";
import { DefaultPolicy, PROACTIVE_DENY_REASON } from "../../src/policy/policy.js";
import type { PolicyContext } from "../../src/policy/policy.js";

const ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  agentId: "reef",
  toolName: "shell",
  needsApproval: true,
  input: { command: "ls" },
  source: { kind: "message" },
  sessionKey: "s1",
  ...over,
});

describe("DefaultPolicy", () => {
  const policy = new DefaultPolicy();

  it("allows an ungated tool", () => {
    expect(policy.decide(ctx({ needsApproval: false }))).toEqual({ action: "allow" });
  });

  it("gates a gated tool in an interactive run", () => {
    expect(policy.decide(ctx({ source: { kind: "message" } }))).toEqual({ action: "gate" });
  });

  it("denies a gated tool in a proactive run (no human to approve)", () => {
    const d = policy.decide(ctx({ source: { kind: "trigger", triggerId: "t", triggerType: "schedule" } }));
    expect(d.action).toBe("deny");
    expect(d.reason).toBe(PROACTIVE_DENY_REASON);
  });
});
