// The Scheduler (Phase 4a) is just a clock: on a fixed cadence it asks the
// daemon to reconcile due triggers. All the real logic — which triggers are
// due, how to advance them, catch-up policy — lives in the daemon's tick
// handler, so this stays a trivially-correct timer and the tick can be driven
// directly (and deterministically) from tests without waiting on wall time.

export const DEFAULT_TICK_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  /** True while a tick is in flight — the next interval is skipped rather than run
   *  concurrently. Without this, a tick slower than the interval (e.g. a sweep that
   *  resolves approvals, or many due triggers) overlaps itself: two reconciliation
   *  passes race the same due triggers (double-fire) and the same expiring approvals. */
  private ticking = false;

  constructor(
    private readonly onTick: () => void | Promise<void>,
    private readonly intervalMs: number = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking) return; // a previous tick is still running — skip, don't overlap
      this.ticking = true;
      void Promise.resolve(this.onTick()).finally(() => {
        this.ticking = false;
      });
    }, this.intervalMs);
    // Don't keep the process alive solely for the scheduler.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
