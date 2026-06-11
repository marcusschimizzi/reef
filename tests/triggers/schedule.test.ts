import { describe, expect, it } from "vitest";
import { assertValidSpec, nextFireTime } from "../../src/triggers/schedule.js";

describe("nextFireTime", () => {
  it("advances an interval spec by its seconds", () => {
    const after = new Date("2026-06-10T12:00:00.000Z");
    const next = nextFireTime({ kind: "interval", seconds: 300 }, after);
    expect(next?.toISOString()).toBe("2026-06-10T12:05:00.000Z");
  });

  it("computes the next cron match strictly after the given instant (UTC)", () => {
    // 09:00 daily; from 10:00 the same day, next is 09:00 the next day.
    const after = new Date("2026-06-10T10:00:00.000Z");
    const next = nextFireTime({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }, after);
    expect(next?.toISOString()).toBe("2026-06-11T09:00:00.000Z");
  });

  it("fires the same day when the cron time is still ahead", () => {
    const after = new Date("2026-06-10T08:00:00.000Z");
    const next = nextFireTime({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }, after);
    expect(next?.toISOString()).toBe("2026-06-10T09:00:00.000Z");
  });

  it("returns a one-shot's instant while it is still in the future", () => {
    const after = new Date("2026-06-10T12:00:00.000Z");
    const next = nextFireTime({ kind: "once", at: "2026-06-11T09:00:00.000Z" }, after);
    expect(next?.toISOString()).toBe("2026-06-11T09:00:00.000Z");
  });

  it("exhausts a one-shot once its instant has passed (goes dormant, never re-fires)", () => {
    const at = "2026-06-10T09:00:00.000Z";
    expect(nextFireTime({ kind: "once", at }, new Date("2026-06-10T09:00:00.000Z"))).toBeUndefined();
    expect(nextFireTime({ kind: "once", at }, new Date("2026-06-10T10:00:00.000Z"))).toBeUndefined();
  });
});

describe("assertValidSpec", () => {
  it("accepts a valid interval and cron", () => {
    expect(() => assertValidSpec({ kind: "interval", seconds: 60 })).not.toThrow();
    expect(() => assertValidSpec({ kind: "cron", expr: "*/5 * * * *" })).not.toThrow();
  });

  it("rejects a non-positive interval", () => {
    expect(() => assertValidSpec({ kind: "interval", seconds: 0 })).toThrow(/seconds > 0/);
  });

  it("rejects an unparseable cron expression", () => {
    expect(() => assertValidSpec({ kind: "cron", expr: "not a cron" })).toThrow();
  });

  it("accepts a valid one-shot instant and rejects garbage", () => {
    expect(() => assertValidSpec({ kind: "once", at: "2026-06-11T09:00:00Z" })).not.toThrow();
    expect(() => assertValidSpec({ kind: "once", at: "whenever" })).toThrow(/valid ISO-8601/);
  });
});
