import { describe, expect, it } from "vitest";
import { HANDBACK_MARKER, HANDBACK_INSTRUCTION, containsHandback, stripHandback } from "../../src/coding/handback.js";

describe("handback", () => {
  it("detects the marker anywhere in rendered output", () => {
    expect(containsHandback(`all done\n${HANDBACK_MARKER}\n`)).toBe(true);
    expect(containsHandback(`${HANDBACK_MARKER}`)).toBe(true);
  });

  it("is false when the marker is absent", () => {
    expect(containsHandback("still thinking about REEF and handbacks")).toBe(false);
    expect(containsHandback("")).toBe(false);
  });

  it("the instruction names the exact marker (so the agent emits what we detect)", () => {
    expect(HANDBACK_INSTRUCTION).toContain(HANDBACK_MARKER);
  });

  it("stripHandback removes the marker and trims, leaving the real summary", () => {
    expect(stripHandback(`Done reading the file.\n\n${HANDBACK_MARKER}`)).toBe("Done reading the file.");
    expect(stripHandback(`${HANDBACK_MARKER}`)).toBe("");
    expect(stripHandback("no marker here")).toBe("no marker here");
  });
});
