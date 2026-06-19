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

  it("resets the in-flight guard and keeps ticking if a tick throws SYNCHRONOUSLY (RF-11 hardening)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    // a non-async onTick (a valid contract) that throws before returning a promise
    const s = new Scheduler(() => { calls += 1; throw new Error("sync boom"); }, 100);
    s.start();
    await vi.advanceTimersByTimeAsync(100); // tick 1 throws
    await vi.advanceTimersByTimeAsync(100); // guard must have reset → tick 2 still fires
    expect(calls).toBe(2);
    s.stop();
  });

  it("keeps ticking when a tick REJECTS (no wedged guard)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = new Scheduler(async () => { calls += 1; throw new Error("async boom"); }, 100);
    s.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
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
