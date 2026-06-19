import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "../../src/daemon/Scheduler.js";

afterEach(() => vi.useRealTimers());

describe("Scheduler reentrancy (RF-11)", () => {
  it("does not overlap ticks — a tick still in-flight skips the next interval", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: (() => void) | undefined;
    const onTick = () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const s = new Scheduler(onTick, 100);
    s.start();

    await vi.advanceTimersByTimeAsync(100); // tick 1 fires and stays in-flight
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(100); // tick 2 would fire — but tick 1 is still running
    expect(calls).toBe(1); // skipped, no overlap

    release!(); // tick 1 completes
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100); // now the next tick is free to run
    expect(calls).toBe(2);

    s.stop();
  });

  it("keeps ticking on the cadence when each tick completes promptly", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = new Scheduler(async () => { calls += 1; }, 100);
    s.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(3);
    s.stop();
  });
});
