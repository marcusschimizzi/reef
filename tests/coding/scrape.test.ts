import { describe, expect, it } from "vitest";
import { stripAnsi, detectPrompt, parseOptions, fingerprint } from "../../src/coding/scrape.js";

describe("stripAnsi", () => {
  it("removes CSI color codes and cursor moves", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m\x1b[40Cgap")).toBe("redgap");
  });
});

describe("detectPrompt / parseOptions", () => {
  const frame = [
    "Bash command",
    "  git push origin main",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, allow all edits during this session",
    "  3. No",
  ].join("\n");

  it("detects a numbered option list with the cursor on option 1", () => {
    const options = detectPrompt(frame);
    expect(options).not.toBeNull();
    expect(options).toEqual([
      { index: 1, label: "Yes" },
      { index: 2, label: "Yes, allow all edits during this session" },
      { index: 3, label: "No" },
    ]);
  });

  it("returns null when no option list is present", () => {
    expect(detectPrompt("just some streaming output\nworking...")).toBeNull();
  });

  it("fingerprints a frame stably regardless of surrounding noise", () => {
    expect(fingerprint(`spinner ✶\n${frame}`)).toBe(fingerprint(`spinner ✻\n${frame}`));
  });
});
