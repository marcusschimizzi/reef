import { describe, expect, it } from "vitest";
import { parseInline, parseSegments } from "../../src/client/tui/markdown.js";

describe("parseSegments", () => {
  it("returns a single text segment when there is no code", () => {
    expect(parseSegments("just a plain reply")).toEqual([{ kind: "text", text: "just a plain reply" }]);
  });

  it("splits prose, a fenced code block (with language), and trailing prose", () => {
    const segs = parseSegments("Here you go:\n```ts\nconst x = 1;\n```\nDone.");
    expect(segs).toEqual([
      { kind: "text", text: "Here you go:" },
      { kind: "code", lang: "ts", code: "const x = 1;" },
      { kind: "text", text: "Done." },
    ]);
  });

  it("captures only the first token of the info string as the language", () => {
    const segs = parseSegments("```python title=foo.py\nprint(1)\n```");
    expect(segs[0]).toEqual({ kind: "code", lang: "python", code: "print(1)" });
  });

  it("treats an unclosed fence (mid-stream) as a code block", () => {
    const segs = parseSegments("writing:\n```js\nconst a = ");
    expect(segs).toEqual([
      { kind: "text", text: "writing:" },
      { kind: "code", lang: "js", code: "const a = " },
    ]);
  });

  it("handles a fence with no language and drops empty separator text", () => {
    const segs = parseSegments("```\nraw\n```");
    expect(segs).toEqual([{ kind: "code", lang: undefined, code: "raw" }]);
  });

  it("preserves blank lines inside a code block", () => {
    const segs = parseSegments("```\na\n\nb\n```");
    expect(segs[0]).toMatchObject({ kind: "code", code: "a\n\nb" });
  });
});

describe("parseInline", () => {
  it("returns one plain span when there is no markup", () => {
    expect(parseInline("just text")).toEqual([{ text: "just text" }]);
  });

  it("parses **bold** and __bold__", () => {
    expect(parseInline("**Files & workspace**")).toEqual([{ text: "Files & workspace", bold: true }]);
    expect(parseInline("a __b__ c")).toEqual([{ text: "a " }, { text: "b", bold: true }, { text: " c" }]);
  });

  it("parses *italic* and inline `code`", () => {
    expect(parseInline("*hi*")).toEqual([{ text: "hi", italic: true }]);
    expect(parseInline("use `recall_memory`")).toEqual([
      { text: "use " },
      { text: "recall_memory", code: true },
    ]);
  });

  it("treats underscore-italic at word boundaries but leaves snake_case alone", () => {
    expect(parseInline("_emph_")).toEqual([{ text: "emph", italic: true }]);
    expect(parseInline("call my_var_name now")).toEqual([{ text: "call my_var_name now" }]);
  });

  it("leaves an unterminated marker as literal text", () => {
    expect(parseInline("**Files")).toEqual([{ text: "**Files" }]);
  });
});
