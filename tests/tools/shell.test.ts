import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { BoundFs } from "../../src/fs/capability.js";
import { shellTool } from "../../src/tools/shell.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(): ToolContext {
  const root = tmpdir();
  return { fs: new BoundFs(root), workspaceRoot: root };
}

describe("shell tool", () => {
  it("is gated by approval", () => {
    expect(shellTool.needsApproval).toBe(true);
  });

  it("runs a command and captures stdout + exit code", async () => {
    const res = (await shellTool.run({ command: "echo hello" }, ctx())) as {
      stdout: string;
      exitCode: number | null;
    };
    expect(res.stdout.trim()).toBe("hello");
    expect(res.exitCode).toBe(0);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const res = (await shellTool.run({ command: "echo oops >&2; exit 3" }, ctx())) as {
      stderr: string;
      exitCode: number | null;
    };
    expect(res.stderr.trim()).toBe("oops");
    expect(res.exitCode).toBe(3);
  });

  it("runs in the given cwd", async () => {
    const res = (await shellTool.run({ command: "pwd", cwd: "/tmp" }, ctx())) as {
      stdout: string;
    };
    // macOS /tmp is a symlink to /private/tmp; accept either
    expect(res.stdout.trim()).toMatch(/\/tmp$/);
  });
});
