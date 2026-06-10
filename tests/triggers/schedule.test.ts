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
});
