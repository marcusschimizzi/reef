import { existsSync, watch } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Trigger, WatchEvent, WatchEventKind } from "../core/types.js";

// The file-watch driver (Phase 4d) — reef's first *event-driven* wake source.
// Where the Scheduler polls due triggers on a tick, the FileWatcher subscribes
// to the OS filesystem and enqueues a wake the instant a watched path changes.
// Both converge on the same `{kind:"trigger"}` inbox job, so a watch reaction
// flows through `processTrigger` exactly like a scheduled fire.
//
// Two safety bounds are built in: a per-trigger *debounce* (an editor's save
// emits several events; coalesce them into one fire) and a *cooldown* (a minimum
// gap between fires — the guard against a watch on a directory the agent itself
// writes to feeding back into itself). The OS watch is created via an injected
// factory so tests can drive events synchronously without touching a real disk.

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_COOLDOWN_MS = 2000;

/** A handle to one open OS watch — closed when the trigger is disabled/removed. */
export interface WatchHandle {
  close(): void;
}

/** Creates an OS watch; injected so tests can substitute a fake event source. */
export type WatchFactory = (
  path: string,
  opts: { recursive: boolean },
  onEvent: (type: WatchEventKind, filename: string | null) => void,
) => WatchHandle;

/** What the watcher calls when a (debounced, cooldown-cleared) change fires. */
export type WatchFire = (triggerId: string, event: WatchEvent) => void;

/** The default factory — Node's fs.watch (non-persistent, so it never keeps the
 *  process alive on its own; the daemon stays up via its socket/HTTP servers). */
const defaultFactory: WatchFactory = (path, opts, onEvent) => {
  const w = watch(path, { recursive: opts.recursive, persistent: false }, (type, filename) =>
    onEvent(type === "rename" ? "rename" : "change", filename),
  );
  return { close: () => w.close() };
};

export class FileWatcher {
  private readonly handles = new Map<string, WatchHandle>();
  private readonly debouncers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastFired = new Map<string, number>();

  constructor(
    private readonly fire: WatchFire,
    private readonly factory: WatchFactory = defaultFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly log?: (message: string) => void,
  ) {}

  /** Register every enabled watch trigger in the list (idempotent — called on
   *  daemon start to arm watches restored from the durable trigger table). */
  start(triggers: Trigger[]): void {
    for (const t of triggers) if (t.enabled && t.spec.kind === "watch") this.register(t);
  }

  /** Begin watching one trigger's path. No-op if it is not a watch, already
   *  registered, or its path doesn't exist (logged, not thrown — a path that
   *  appears later can be re-registered on the next enable/restart). */
  register(trigger: Trigger): void {
    if (trigger.spec.kind !== "watch" || this.handles.has(trigger.id)) return;
    const spec = trigger.spec;
    if (!existsSync(spec.path)) {
      this.log?.(`watch ${trigger.id}: path does not exist, not watching: ${spec.path}`);
      return;
    }
    const wanted = spec.events; // undefined → all change kinds
    const debounceMs = spec.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const cooldownMs = spec.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    try {
      const handle = this.factory(spec.path, { recursive: spec.recursive ?? false }, (type, filename) => {
        if (wanted && !wanted.includes(type)) return; // filtered-out change kind
        const path = filename ? (isAbsolute(filename) ? filename : join(spec.path, filename)) : spec.path;
        this.schedule(trigger.id, { type, path }, debounceMs, cooldownMs);
      });
      this.handles.set(trigger.id, handle);
    } catch (err) {
      this.log?.(`watch ${trigger.id}: failed to watch ${spec.path}: ${(err as Error).message}`);
    }
  }

  /** Stop watching one trigger (disable/remove) and drop any pending debounce. */
  unregister(triggerId: string): void {
    this.handles.get(triggerId)?.close();
    this.handles.delete(triggerId);
    const pending = this.debouncers.get(triggerId);
    if (pending) {
      clearTimeout(pending);
      this.debouncers.delete(triggerId);
    }
  }

  /** Close every watch (daemon shutdown). */
  stop(): void {
    for (const id of [...this.handles.keys()]) this.unregister(id);
  }

  /** Debounce the burst, then fire unless we're still inside the cooldown. */
  private schedule(triggerId: string, event: WatchEvent, debounceMs: number, cooldownMs: number): void {
    const existing = this.debouncers.get(triggerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debouncers.delete(triggerId);
      // -Infinity so the first-ever fire is never inside the cooldown window.
      const last = this.lastFired.get(triggerId) ?? Number.NEGATIVE_INFINITY;
      const at = this.now();
      if (at - last < cooldownMs) {
        // Within cooldown — drop this fire (anti-feedback-loop). A later change
        // after the cooldown elapses fires normally.
        this.log?.(`watch ${triggerId}: within ${cooldownMs}ms cooldown, coalescing change`);
        return;
      }
      this.lastFired.set(triggerId, at);
      this.fire(triggerId, event);
    }, debounceMs);
    // Don't let a pending debounce keep the process alive.
    (timer as { unref?: () => void }).unref?.();
    this.debouncers.set(triggerId, timer);
  }
}
