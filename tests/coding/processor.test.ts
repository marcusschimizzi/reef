import { describe, expect, it } from "vitest";
import { CodingStreamProcessor } from "../../src/coding/processor.js";

describe("CodingStreamProcessor", () => {
  it("emits output for streamed chunks", () => {
    const p = new CodingStreamProcessor();
    const events = p.push("\x1b[32mhello\x1b[0m world");
    expect(events).toContainEqual({ type: "output", text: "hello world" });
  });

  it("emits prompt-pending once per distinct prompt (debounced across redraws)", () => {
    const p = new CodingStreamProcessor();
    const frame = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    const first = p.push(frame);
    expect(first.some((e) => e.type === "prompt-pending")).toBe(true);
    // a redraw (spinner change) of the same prompt must NOT re-fire
    const redraw = p.push("\x1b[2J❯ 1. Yes\n  2. No\n");
    expect(redraw.some((e) => e.type === "prompt-pending")).toBe(false);
  });

  it("re-fires after the prompt clears and a new one appears", () => {
    const p = new CodingStreamProcessor();
    p.push("❯ 1. Yes\n  2. No\n");
    p.push("\x1b[2Jworking on it...\n"); // prompt gone
    const again = p.push("❯ 1. Approve\n  2. Reject\n");
    expect(again.some((e) => e.type === "prompt-pending")).toBe(true);
  });

  it("emits exited on exit()", () => {
    const p = new CodingStreamProcessor();
    expect(p.exit(0)).toEqual([{ type: "exited", code: 0 }]);
  });
});
