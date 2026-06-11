import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatcher, type WatchFactory } from "../../src/triggers/watcher.js";
import type { Trigger, TriggerSpec, WatchEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reef-watch-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

// A real (existing) temp dir so register()'s existsSync passes; the OS watch
// itself is faked so events are driven synchronously.
function watchTrigger(spec: Partial<Extract<TriggerSpec, { kind: "watch" }>> = {}, id = "w1"): Trigger {
  return {
    id,
    agentId: "reef",
    type: "watch",
    spec: { kind: "watch", path: dir, ...spec },
    input: "react",
    sessionKey: `reef:reef:trigger-${id}`,
    createdBy: "operator",
    enabled: true,
    catchUpPolicy: "skip",
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}

/** A fake OS watch: exposes the captured callback so a test can emit events,
 *  and goes inert once closed (modelling a real handle's close()). */
function fakeFactory() {
  let cb: ((type: "change" | "rename", filename: string | null) => void) | undefined;
  let closed = false;
  const factory: WatchFactory = (_path, _opts, onEvent) => {
    cb = onEvent;
    return { close: () => (closed = true) };
  };
  return {
    factory,
    emit: (type: "change" | "rename", filename: string | null) => {
      if (!closed) cb?.(type, filename);
    },
    closed: () => closed,
    registered: () => cb !== undefined,
  };
}

describe("FileWatcher", () => {
  it("debounces a burst of events into a single fire", () => {
    const fires: Array<{ id: string; event: WatchEvent }> = [];
    const f = fakeFactory();
    const w = new FileWatcher((id, event) => fires.push({ id, event }), f.factory, () => 0);
    w.start([watchTrigger({ debounceMs: 50, cooldownMs: 0 })]);

    f.emit("change", "a.ts");
    f.emit("change", "a.ts");
    f.emit("change", "a.ts");
    expect(fires).toHaveLength(0); // still within the debounce window

    vi.advanceTimersByTime(50);
    expect(fires).toHaveLength(1); // coalesced into one
    expect(fires[0]!.event.path).toContain("a.ts");
  });

  it("suppresses fires inside the cooldown, then fires again after it elapses", () => {
    const fires: WatchEvent[] = [];
    let now = 0;
    const f = fakeFactory();
    const w = new FileWatcher((_id, event) => fires.push(event), f.factory, () => now);
    w.start([watchTrigger({ debounceMs: 10, cooldownMs: 1000 })]);

    f.emit("change", "a.ts");
    vi.advanceTimersByTime(10);
    expect(fires).toHaveLength(1); // first fire always passes

    now = 500; // within cooldown
    f.emit("change", "b.ts");
    vi.advanceTimersByTime(10);
    expect(fires).toHaveLength(1); // dropped

    now = 1200; // past cooldown
    f.emit("change", "c.ts");
    vi.advanceTimersByTime(10);
    expect(fires).toHaveLength(2); // fires again
  });

  it("honors an events filter", () => {
    const fires: WatchEvent[] = [];
    const f = fakeFactory();
    const w = new FileWatcher((_id, event) => fires.push(event), f.factory, () => 0);
    w.start([watchTrigger({ events: ["rename"], debounceMs: 0, cooldownMs: 0 })]);

    f.emit("change", "a.ts");
    vi.advanceTimersByTime(0);
    expect(fires).toHaveLength(0); // change filtered out

    f.emit("rename", "a.ts");
    vi.advanceTimersByTime(0);
    expect(fires).toHaveLength(1);
  });

  it("unregister closes the OS handle and stops firing", () => {
    const fires: WatchEvent[] = [];
    const f = fakeFactory();
    const w = new FileWatcher((_id, event) => fires.push(event), f.factory, () => 0);
    w.start([watchTrigger({ debounceMs: 10, cooldownMs: 0 })]);

    w.unregister("w1");
    expect(f.closed()).toBe(true);
    f.emit("change", "a.ts");
    vi.advanceTimersByTime(50);
    expect(fires).toHaveLength(0);
  });

  it("skips a trigger whose path does not exist (no watch created)", () => {
    const f = fakeFactory();
    const w = new FileWatcher(() => {}, f.factory, () => 0);
    w.start([watchTrigger({ path: join(dir, "does-not-exist") })]);
    expect(f.registered()).toBe(false); // factory never called
  });
});
