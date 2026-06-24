import { spawn } from "node:child_process";
import { z } from "zod";
import { safeChildEnv } from "../core/env.js";
import { killProcessGroup } from "../core/processKill.js";
import type { Tool } from "./types.js";

// The shell tool — reef's escape hatch to the wider machine. Unlike the file
// tools (contained to the workspace by construction), shell can run anywhere;
// the safety boundary is *human approval* (needsApproval), so the operator sees
// the exact command before it runs (reef-docs/06: the operator is trusted; the
// gate is the approval, not a sandbox).

const MAX_OUTPUT = 100_000; // cap captured stdout/stderr to keep context sane
const TIMEOUT_MS = 120_000;

export const shellTool: Tool<{ command: string; cwd?: string }> = {
  name: "shell",
  description:
    "Run a shell command (bash -c). Requires human approval before each run. " +
    "Returns stdout, stderr, and the exit code. `cwd` defaults to the agent's workspace.",
  needsApproval: true,
  inputSchema: z.object({
    command: z.string().describe("The command to run"),
    cwd: z.string().optional().describe("Working directory (default: workspace root)"),
  }),
  async run({ command, cwd }, ctx) {
    return runCommand(command, cwd ?? ctx.workspaceRoot, ctx.signal);
  },
};

function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    // Curated env only — never hand the daemon's API keys/tokens to an arbitrary
    // command. --norc/--noprofile keep execution deterministic and independent of the
    // user's interactive dotfiles. `detached` puts the command in its OWN process group
    // (pgid === child.pid) so a timeout/cancel can SIGTERM→SIGKILL the WHOLE group and
    // not orphan grandchildren — and crucially never signals the daemon's own group.
    const child = spawn("bash", ["--norc", "--noprofile", "-c", command], {
      cwd,
      detached: true,
      env: safeChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    let cancelKill: (() => void) | undefined;
    const killGroup = (): void => { if (child.pid) cancelKill = killProcessGroup(child.pid); };
    const timer = setTimeout(killGroup, TIMEOUT_MS);
    const onAbort = (): void => killGroup();
    if (signal) {
      if (signal.aborted) killGroup();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // The child exited (close/error) — cancel any pending force-kill so we don't
      // re-signal the (now-freed, possibly reused) process group.
      cancelKill?.();
    };

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code,
      });
    });
  });
}

export const shellTools: Tool[] = [shellTool];
