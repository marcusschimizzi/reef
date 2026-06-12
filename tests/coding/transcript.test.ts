import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeProjectPath,
  findClaudeTranscript,
  latestToolUse,
  parseClaudeTranscript,
  renderTranscript,
} from "../../src/coding/transcript.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-tx-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("encodeProjectPath", () => {
  it("replaces every non-alphanumeric with '-' (Claude Code's scheme)", () => {
    expect(encodeProjectPath("/Users/marcus/dev/reef")).toBe("-Users-marcus-dev-reef");
    expect(encodeProjectPath("/tmp/a_b.c")).toBe("-tmp-a-b-c");
  });
});

describe("findClaudeTranscript", () => {
  it("finds a transcript by session id under a projects root; undefined when absent", () => {
    const root = tmp();
    mkdirSync(join(root, "some-proj"));
    writeFileSync(join(root, "some-proj", "abc.jsonl"), "");
    expect(findClaudeTranscript("abc", { root })).toBe(join(root, "some-proj", "abc.jsonl"));
    expect(findClaudeTranscript("missing", { root })).toBeUndefined();
  });
});

describe("parseClaudeTranscript (real captured Claude Code session)", () => {
  const entries = parseClaudeTranscript("tests/coding/fixtures/claude-session.jsonl");

  it("extracts the user task, tool calls (Read/Write) and their results", () => {
    expect(entries.some((e) => e.role === "user" && /summary\.txt/.test(e.text ?? ""))).toBe(true);
    const tools = entries.filter((e) => e.toolUse).map((e) => e.toolUse!.name);
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(entries.some((e) => /File created successfully/.test(e.toolResult ?? ""))).toBe(true);
  });

  it("latestToolUse gives the most recent tool call — a reliable approval action", () => {
    expect(latestToolUse(entries)?.name).toBe("Write");
  });

  it("renders a clean readable transcript", () => {
    const text = renderTranscript(entries);
    expect(text).toContain("tool: Write(");
    expect(text).toContain("result: File created successfully");
  });
});
