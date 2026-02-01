import { describe, expect, it } from "vitest";
import { nowTimestamp, makeEvent } from "../src/events.js";

describe("events", () => {
  it("creates ISO timestamps", () => {
    const ts = nowTimestamp();
    expect(ts).toMatch(/T/);
  });

  it("stamps events", () => {
    const event = makeEvent("started", "job-1", { task: "x" });
    expect(event.timestamp).toBeDefined();
  });
});
