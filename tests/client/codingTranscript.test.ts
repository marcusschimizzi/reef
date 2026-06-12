import { describe, expect, it } from "vitest";
import { initialState, reduceEvent } from "../../src/client/tui/transcript.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const ev = (body: Partial<ReefEvent> & { type: ReefEvent["type"] }): ReefEvent =>
  ({ seq: 1, ts: 0, sessionKey: "coding:cs_1", runId: "", ...body }) as ReefEvent;

describe("transcript renders coding.* events", () => {
  it("appends coding output and a prompt notice", () => {
    let s = reduceEvent(initialState, ev({ type: "coding.output", codingSessionId: "cs_1", text: "building..." } as Partial<ReefEvent> & { type: ReefEvent["type"] }));
    s = reduceEvent(s, ev({ type: "coding.prompt.detected", codingSessionId: "cs_1", promptText: "Proceed?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] } as Partial<ReefEvent> & { type: ReefEvent["type"] }));
    const text = s.items.map((i) => ("text" in i ? i.text : "")).join("\n");
    expect(text).toContain("building...");
    expect(text).toContain("Yes");
  });
});
