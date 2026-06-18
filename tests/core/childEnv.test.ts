import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { safeChildEnv } from "../../src/core/env.js";
import { claudeEnv } from "../../src/coding/ptyClaude.js";
import { shellTool } from "../../src/tools/shell.js";
import { BoundFs } from "../../src/fs/capability.js";
import type { ToolContext } from "../../src/tools/types.js";

// A spawned child (the PTY `claude` and the `shell` tool's bash) must NOT inherit
// the daemon's full environment — that leaks every API key / token the daemon holds
// to an arbitrary subprocess. Only a curated allowlist crosses the boundary.

const SECRET = "REEF_TEST_SECRET_XYZ";
const TOUCHED = [SECRET, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MY_EXTRA", "REEF_CHILD_ENV_ALLOW"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  process.env[SECRET] = "shh";
  process.env.OPENAI_API_KEY = "sk-openai";
  process.env.ANTHROPIC_API_KEY = "sk-anthropic";
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("safeChildEnv — curated allowlist for spawned children (RF-03)", () => {
  it("excludes arbitrary daemon secrets", () => {
    const env = safeChildEnv();
    expect(env[SECRET]).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("passes through the safe base vars a dev loop needs (PATH, HOME)", () => {
    const env = safeChildEnv();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it("merges caller-provided extras (e.g. TERM) over the allowlist", () => {
    expect(safeChildEnv({ TERM: "xterm-256color" }).TERM).toBe("xterm-256color");
  });

  it("honors the REEF_CHILD_ENV_ALLOW opt-in passthrough, without opening secrets", () => {
    process.env.MY_EXTRA = "v";
    process.env.REEF_CHILD_ENV_ALLOW = "MY_EXTRA";
    expect(safeChildEnv().MY_EXTRA).toBe("v");
    expect(safeChildEnv()[SECRET]).toBeUndefined();
  });
});

describe("claudeEnv — on-plan billing + no secret leak (RF-03)", () => {
  it("strips ANTHROPIC creds and arbitrary secrets, keeps PATH + TERM", () => {
    const env = claudeEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env[SECRET]).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.TERM).toBe("xterm-256color");
  });
});

describe("shell tool child env (RF-03)", () => {
  it("does not leak a daemon secret to the spawned command, but keeps PATH", async () => {
    const ctx: ToolContext = { fs: new BoundFs(tmpdir()), workspaceRoot: tmpdir() };
    const res = (await shellTool.run(
      { command: `echo "secret=[$${SECRET}]"; echo "path=[$PATH]"` },
      ctx,
    )) as { stdout: string };
    expect(res.stdout).toContain("secret=[]");
    expect(res.stdout).not.toContain("shh");
    expect(res.stdout).toMatch(/path=\[.+\]/);
  });
});
