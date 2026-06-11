import { describe, expect, it } from "vitest";
import { DefaultGate } from "../../src/triggers/gate.js";
import type { Trigger } from "../../src/core/types.js";

const trigger: Trigger = {
  id: "trg_x",
  agentId: "reef",
  type: "heartbeat",
  spec: { kind: "interval", seconds: 60 },
  input: "tidy up",
  sessionKey: "reef:reef:trigger-trg_x",
  createdBy: "operator",
  enabled: true,
  catchUpPolicy: "skip",
  createdAt: "2026-06-10T00:00:00.000Z",
};

describe("DefaultGate", () => {
  it("allows a fire when reef is idle", () => {
    expect(new DefaultGate().check({ now: new Date(), busy: false, trigger })).toEqual({
      allow: true,
    });
  });

  it("suppresses a fire when a run is already active", () => {
    const d = new DefaultGate().check({ now: new Date(), busy: true, trigger });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/already active/);
  });
});
