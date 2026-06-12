import { describe, expect, it } from "vitest";
import { isEventType, type ReefEvent } from "../../src/protocol/events.js";

describe("coding.* events", () => {
  it("are part of the ReefEvent union and narrow correctly", () => {
    const e: ReefEvent = {
      seq: 1, ts: 0, sessionKey: "coding:cs_1", runId: "",
      type: "coding.output", codingSessionId: "cs_1", text: "hello",
    };
    expect(isEventType(e, "coding.output")).toBe(true);
    if (isEventType(e, "coding.output")) expect(e.text).toBe("hello");
  });
});
