import { nowMs } from "../core/time.js";
import type { Spine } from "../db/spine.js";
import type { EmitFn, ReefEvent, ReefEventInit } from "../protocol/events.js";

/**
 * The event sink: the single place native-protocol events are stamped with a
 * per-session monotonic `seq` and `ts`, persisted (so a consumer can fetch
 * history and reconnect without gaps), and broadcast to connected clients.
 *
 * The loop is handed `sink.emit` and stays ignorant of seq assignment,
 * persistence, and transport.
 */
// Events broadcast to live consumers but intentionally NOT persisted. `coding.output`
// arrives at PTY / redraw-frame rate — persisting every frame floods the events table
// (O(frames) rows) and merely duplicates the flight-recorder trace, which is already
// the durable byte-level record of a coding session. Lifecycle coding.* events
// (started/paused/completed/prompt.*) stay persisted: they're O(lifecycle).
const BROADCAST_ONLY: ReadonlySet<string> = new Set(["coding.output"]);

export class EventSink {
  private readonly seqBySession = new Map<string, number>();
  private readonly subscribers = new Set<(event: ReefEvent) => void>();

  constructor(private readonly spine: Spine) {}

  emit: EmitFn = (init: ReefEventInit): void => {
    // Broadcast-only events are NOT persisted, so they must not consume a seq from
    // the persisted sequence — otherwise history has phantom gaps and a gap-detecting
    // consumer thinks it dropped events. They ride the current (last persisted) seq.
    const broadcastOnly = BROADCAST_ONLY.has(init.type);
    const seq = broadcastOnly ? this.currentSeq(init.sessionKey) : this.nextSeq(init.sessionKey);
    const event = { ...init, seq, ts: nowMs() } as ReefEvent;
    if (!broadcastOnly) this.spine.appendEvent(event);
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // a misbehaving subscriber must not break the loop or other consumers
      }
    }
  };

  subscribe(fn: (event: ReefEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private nextSeq(sessionKey: string): number {
    const next = this.currentSeq(sessionKey) + 1;
    this.seqBySession.set(sessionKey, next);
    return next;
  }

  /** The last assigned seq for a session, without consuming a new one. */
  private currentSeq(sessionKey: string): number {
    return this.seqBySession.get(sessionKey) ?? this.spine.maxEventSeq(sessionKey);
  }
}
