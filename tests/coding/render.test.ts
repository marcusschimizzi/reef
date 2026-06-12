import { describe, expect, it } from "vitest";
import { renderScreen, renderText } from "../../src/coding/render.js";

describe("renderScreen", () => {
  it("reconstructs word spacing from cursor-forward/absolute-column moves", () => {
    // how Claude Code's Ink TUI actually lays out an option line (real shape)
    const out = renderText("2.\x1b[7GNo,\x1b[11Gexit");
    expect(out).toContain("No, exit");
    expect(out).not.toContain("No,exit");
  });

  it("overwrites earlier columns on carriage return", () => {
    expect(renderText("abc\rX")).toBe("Xbc");
  });

  it("places rows via newlines and cursor up/down", () => {
    expect(renderScreen("one\ntwo")).toEqual(["one", "two"]);
    // cursor up (\e[A) writes back into the earlier row at the current column
    expect(renderScreen("one\ntwo\x1b[A!")[0]).toBe("one!");
  });

  it("erases a line with \\e[2K", () => {
    expect(renderText("hello\x1b[2K")).toBe("");
  });

  it("ignores private-mode CSI without leaking its bytes as text", () => {
    expect(renderText("a\x1b[>0qb")).toBe("ab");
    expect(renderText("a\x1b[?25lb")).toBe("ab");
  });

  it("strips SGR color codes", () => {
    expect(renderText("\x1b[38;5;114mYes\x1b[39m")).toBe("Yes");
  });
});
