import { describe, expect, it } from "vitest";
import { attachRunLogger, type Logger, type LogLevel } from "../../src/daemon/log.js";
import type { Daemon } from "../../src/daemon/Daemon.js";
import type { ReefEvent } from "../../src/protocol/events.js";

/** A minimal Daemon stand-in: just the subscribe surface attachRunLogger uses. */
function fakeDaemon(): { daemon: Daemon; emit: (e: ReefEvent) => void } {
  const subs = new Set<(e: ReefEvent) => void>();
  const daemon = {
    subscribe(fn: (e: ReefEvent) => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  } as unknown as Daemon;
  return { daemon, emit: (e) => subs.forEach((fn) => fn(e)) };
}

interface Line {
  level: LogLevel;
  message: string;
  fields?: Record<string, unknown>;
}
function capture(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return { logger: { log: (level, message, fields) => lines.push({ level, message, fields }) }, lines };
}

const ev = (body: Partial<ReefEvent> & { type: ReefEvent["type"] }): ReefEvent =>
  ({ seq: 1, ts: 0, sessionKey: "s", runId: "run_abc123def456", ...body }) as ReefEvent;

describe("attachRunLogger", () => {
  it("logs run lifecycle with the run's source carried from run.started", () => {
    const { daemon, emit } = fakeDaemon();
    const { logger, lines } = capture();
    attachRunLogger(daemon, logger);

    emit(ev({ type: "run.started", agentId: "reef", source: { kind: "trigger", triggerId: "t", triggerType: "schedule" } }));
    emit(ev({ type: "run.completed", stopReason: "completed" }));

    expect(lines[0]).toMatchObject({ level: "info", message: "run started", fields: { source: "trigger:schedule" } });
    // source is remembered across events for the same run
    expect(lines[1]).toMatchObject({ message: "run completed", fields: { source: "trigger:schedule", stop: "completed" } });
  });

  it("logs an interactive run's source as message", () => {
    const { daemon, emit } = fakeDaemon();
    const { logger, lines } = capture();
    attachRunLogger(daemon, logger);
    emit(ev({ type: "run.started", agentId: "reef" }));
    expect(lines[0]?.fields).toMatchObject({ source: "message" });
  });

  it("errors on run.failed and warns on tool failures (the proactive auto-deny surface)", () => {
    const { daemon, emit } = fakeDaemon();
    const { logger, lines } = capture();
    attachRunLogger(daemon, logger);

    emit(ev({ type: "tool.failed", toolUseId: "x", error: "treated as denied" }));
    emit(ev({ type: "run.failed", error: "boom" }));

    expect(lines[0]).toMatchObject({ level: "warn", message: "tool failed" });
    expect(lines[1]).toMatchObject({ level: "error", message: "run failed", fields: { error: "boom" } });
  });

  it("warns loudly if a proactive run ever suspends (it shouldn't, post auto-deny)", () => {
    const { daemon, emit } = fakeDaemon();
    const { logger, lines } = capture();
    attachRunLogger(daemon, logger);

    emit(ev({ type: "run.started", agentId: "reef", source: { kind: "trigger", triggerId: "t", triggerType: "heartbeat" } }));
    emit(ev({ type: "run.suspended", stopReason: "awaiting_approval" }));
    const suspend = lines.find((l) => l.message.includes("suspended"));
    expect(suspend?.level).toBe("warn");

    // an interactive suspension is just info
    const other = fakeDaemon();
    const cap2 = capture();
    attachRunLogger(other.daemon, cap2.logger);
    other.emit(ev({ type: "run.started", agentId: "reef" }));
    other.emit(ev({ type: "run.suspended", stopReason: "awaiting_approval" }));
    expect(cap2.lines.find((l) => l.message.includes("suspended"))?.level).toBe("info");
  });
});
