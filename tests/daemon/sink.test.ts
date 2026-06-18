import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { EventSink } from "../../src/daemon/sink.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const dirs: string[] = [];
function newSpine(): Spine {
  const dir = mkdtempSync(join(tmpdir(), "reef-sink-"));
  dirs.push(dir);
  return new Spine(join(dir, "reef.db"));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("EventSink persistence policy (RF-04)", () => {
  it("broadcasts coding.output live but does NOT persist it (the trace is the durable record)", () => {
    const spine = newSpine();
    const sink = new EventSink(spine);
    const seen: ReefEvent[] = [];
    sink.subscribe((e) => seen.push(e));
    const sk = "coding:cs_1";

    sink.emit({ type: "coding.session.started", sessionKey: sk, runId: "", codingSessionId: "cs_1", agentKind: "claude", directory: "/tmp" });
    for (let i = 0; i < 50; i++) {
      sink.emit({ type: "coding.output", sessionKey: sk, runId: "", codingSessionId: "cs_1", text: `frame ${i}` });
    }
    sink.emit({ type: "coding.session.completed", sessionKey: sk, runId: "", codingSessionId: "cs_1", result: "done" });

    // live consumers still see every output frame
    expect(seen.filter((e) => e.type === "coding.output")).toHaveLength(50);

    // but the events table holds only the O(lifecycle) rows, not the 50 frames
    const persisted = spine.getEventsSince(sk, 0);
    expect(persisted.some((e) => e.type === "coding.session.started")).toBe(true);
    expect(persisted.some((e) => e.type === "coding.session.completed")).toBe(true);
    expect(persisted.filter((e) => e.type === "coding.output")).toHaveLength(0);
    spine.close();
  });

  it("still persists ordinary lifecycle events", () => {
    const spine = newSpine();
    const sink = new EventSink(spine);
    sink.emit({ type: "run.started", sessionKey: "s1", runId: "r1", agentId: "reef" });
    sink.emit({ type: "run.completed", sessionKey: "s1", runId: "r1", stopReason: "completed" });
    const persisted = spine.getEventsSince("s1", 0);
    expect(persisted.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
    spine.close();
  });
});
