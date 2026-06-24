import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BoundFs } from "../../src/fs/capability.js";
import { shellTool } from "../../src/tools/shell.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(): ToolContext {
  const root = tmpdir();
  return { fs: new BoundFs(root), workspaceRoot: root };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20));
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

  it("kills the whole process group on abort — no orphaned grandchild (RF-14)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reef-shellkill-"));
    dirs.push(dir);
    const pidfile = join(dir, "gc.pid");
    const ac = new AbortController();
    const c: ToolContext = { fs: new BoundFs(dir), workspaceRoot: dir, signal: ac.signal };

    // bash backgrounds `sleep 30` (a grandchild in bash's process group), records its
    // pid, then waits. A single-pid kill of bash would orphan the sleep; a group kill
    // reaps it too.
    const run = shellTool.run({ command: `sleep 30 & echo $! > ${pidfile}; wait` }, c);

    await waitUntil(() => { try { return readFileSync(pidfile, "utf8").trim().length > 0; } catch { return false; } }, 2000);
    const gpid = Number(readFileSync(pidfile, "utf8").trim());
    expect(gpid).toBeGreaterThan(0);
    expect(isAlive(gpid)).toBe(true);

    ac.abort();
    await run.catch(() => undefined); // settles (the kill exits bash)
    await waitUntil(() => !isAlive(gpid), 3000);
    expect(isAlive(gpid)).toBe(false);
  });
});
