import { describe, expect, it } from "vitest";
import { replayTrace } from "../../src/coding/replay.js";

// Replays a REAL captured Claude Code session (the trust dialog) through the same
// processor the live run used. This is the Step-2 win: the terminal renderer
// reconstructs the cursor-positioned layout, so option labels come out readable
// ("Yes, I trust this folder") instead of fused ("Yes,Itrustthisfolder").
describe("replay of the real trust-prompt fixture", () => {
  it("detects the prompt with readable option labels", () => {
    const events = replayTrace("tests/coding/fixtures/trust-prompt.jsonl");
    const prompt = events.find((e) => e.type === "prompt-pending");
    expect(prompt, "a prompt should be detected in the captured trust dialog").toBeDefined();
    if (prompt?.type !== "prompt-pending") throw new Error("expected prompt-pending");

    const labels = prompt.options.map((o) => o.label);
    expect(labels).toContain("Yes, I trust this folder");
    expect(labels).toContain("No, exit");
  });
});
