// Graceful termination of a spawned process and ALL its descendants.
//
// A bare `child.kill()` signals only the direct child — its grandchildren (a shell's
// subprocesses, Claude Code's MCP servers / Bash tool processes) are orphaned and keep
// running. The fix is to signal the process GROUP: spawn the child as a group leader
// (`detached: true`, or a PTY via setsid), then signal the negative pid so the whole
// group receives it. We escalate: SIGTERM (let them clean up) → SIGKILL after a grace.

export interface KillProcessGroupOpts {
  /** Milliseconds to wait after SIGTERM before SIGKILL. Default 2000. */
  graceMs?: number;
  /** Injectable signal fn (tests). Defaults to `process.kill`, swallowing the
   *  ESRCH thrown when the group is already gone. */
  kill?: (target: number, signal: NodeJS.Signals) => void;
}

export function killProcessGroup(pid: number, opts: KillProcessGroupOpts = {}): void {
  const kill =
    opts.kill ??
    ((target, signal) => {
      try {
        process.kill(target, signal);
      } catch {
        // ESRCH (already gone) / EPERM — nothing to do.
      }
    });
  // Negative pid → the process group led by `pid` (requires the child to be a group
  // leader: detached spawn or a PTY's setsid).
  kill(-pid, "SIGTERM");
  const timer = setTimeout(() => kill(-pid, "SIGKILL"), opts.graceMs ?? 2000);
  // A teardown backstop must not keep the daemon's event loop alive on its own.
  (timer as { unref?: () => void }).unref?.();
}
