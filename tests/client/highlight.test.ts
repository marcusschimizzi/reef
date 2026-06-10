import { describe, expect, it } from "vitest";
import { tokenizeLine, usesHashComments } from "../../src/client/tui/highlight.js";

const classes = (line: string, hash = false) =>
  tokenizeLine(line, { hash }).map((t) => [t.cls, t.text]);

describe("tokenizeLine", () => {
  it("classifies keywords, identifiers, and numbers", () => {
    expect(classes("const x = 42")).toEqual([
      ["keyword", "const"],
      ["plain", " "],
      ["plain", "x"],
      ["plain", " "],
      ["plain", "="],
      ["plain", " "],
      ["number", "42"],
    ]);
  });

  it("classifies a string literal", () => {
    const toks = tokenizeLine(`return "hi"`);
    expect(toks[0]).toEqual({ cls: "keyword", text: "return" });
    expect(toks.find((t) => t.cls === "string")).toEqual({ cls: "string", text: `"hi"` });
  });

  it("treats // as a comment to end of line", () => {
    expect(classes("x // trailing")).toContainEqual(["comment", "// trailing"]);
  });

  it("treats # as a comment only when hash-langs is set", () => {
    expect(classes("x # note", true)).toContainEqual(["comment", "# note"]);
    expect(classes("x # note", false)).not.toContainEqual(["comment", "# note"]);
  });

  it("recognizes hex/binary numbers", () => {
    expect(classes("0xFF")).toEqual([["number", "0xFF"]]);
  });

  it("tolerates an unterminated string (mid-stream)", () => {
    const toks = tokenizeLine(`s = "oops`);
    expect(toks.find((t) => t.cls === "string")).toEqual({ cls: "string", text: `"oops` });
  });

  it("maps languages to the right comment style", () => {
    expect(usesHashComments("python")).toBe(true);
    expect(usesHashComments("bash")).toBe(true);
    expect(usesHashComments("ts")).toBe(false);
    expect(usesHashComments(undefined)).toBe(false);
  });
});
