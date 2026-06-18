import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessGroup } from "../../src/core/processKill.js";

afterEach(() => vi.useRealTimers());

describe("killProcessGroup (RF-14 — graceful process-group teardown)", () => {
  it("signals the process GROUP (negative pid), SIGTERM first then SIGKILL after the grace", () => {
    vi.useFakeTimers();
    const calls: Array<[number, string]> = [];
    killProcessGroup(4242, { graceMs: 2000, kill: (t, s) => calls.push([t, s]) });

    // immediate graceful term to the whole group (-pid → child + grandchildren)
    expect(calls).toEqual([[-4242, "SIGTERM"]]);

    vi.advanceTimersByTime(2000);
    // anything still alive is force-killed
    expect(calls).toEqual([
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
  });

  it("swallows ESRCH-style errors from the default killer (process already gone)", () => {
    // the default path uses process.kill; a non-existent group must not throw
    expect(() => killProcessGroup(2147480000, { graceMs: 0 })).not.toThrow();
  });
});
