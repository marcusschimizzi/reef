import { describe, expect, it } from "vitest";
import { answerFor, classifyPrompt, promptAction } from "../../src/coding/prompts.js";
import { replayTrace } from "../../src/coding/replay.js";

describe("classifyPrompt", () => {
  it("classifies by marker text", () => {
    expect(classifyPrompt("Quick safety check: ... trust this folder?")).toBe("trust");
    expect(classifyPrompt("Do you want to create summary.txt?")).toBe("permission");
    expect(classifyPrompt("Bash command\necho hi\nDo you want to proceed?")).toBe("permission");
    expect(classifyPrompt("Claude is ready to execute. Would you like to proceed?")).toBe("plan");
    expect(classifyPrompt("Which approach do you prefer?")).toBe("question");
  });
});

describe("promptAction", () => {
  it("extracts the 'do you want to X' clause", () => {
    expect(promptAction("Do you want to create summary.txt?")).toBe("create summary.txt");
    expect(promptAction("no action phrasing here")).toBeUndefined();
  });
});

describe("answerFor", () => {
  const edit = [
    { index: 1, label: "Yes" },
    { index: 2, label: "Yes, allow all edits during this session (shift+tab)" },
    { index: 3, label: "No" },
  ];
  it("maps a decision to the right 3-option permission choice", () => {
    expect(answerFor(edit, "allow-once")).toBe(1);
    expect(answerFor(edit, "allow-always")).toBe(2);
    expect(answerFor(edit, "deny")).toBe(3);
  });

  const trust = [
    { index: 1, label: "Yes, I trust this folder" },
    { index: 2, label: "No, exit" },
  ];
  it("handles a 2-option dialog (allow-always falls back to plain yes)", () => {
    expect(answerFor(trust, "allow-once")).toBe(1);
    expect(answerFor(trust, "deny")).toBe(2);
    expect(answerFor(trust, "allow-always")).toBe(1);
  });
});

describe("against the real edit-approval fixture", () => {
  it("classifies the captured edit prompt as a permission with an action, and maps deny→No", () => {
    const events = replayTrace("tests/coding/fixtures/edit-approval.jsonl");
    const perm = events.find(
      (e) => e.type === "prompt-pending" && /summary\.txt/.test(e.promptText),
    );
    expect(perm, "the edit permission prompt should be detected").toBeDefined();
    if (perm?.type !== "prompt-pending") throw new Error("expected prompt-pending");

    expect(classifyPrompt(perm.promptText)).toBe("permission");
    expect(promptAction(perm.promptText)).toContain("summary.txt");
    expect(answerFor(perm.options, "deny")).toBe(3);
    expect(answerFor(perm.options, "allow-once")).toBe(1);
  });
});
