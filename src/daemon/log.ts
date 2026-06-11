import { nowIso } from "../core/time.js";
import type { RunSource } from "../core/types.js";
import type { Daemon } from "./Daemon.js";
import type { ReefEvent } from "../protocol/events.js";

// Daemon observability (Phase 4c follow-up). Before this, a proactive run that
// fired in the background — and any run that suspended, failed, or auto-denied a
// tool — left no trace except rows in SQLite you had to query by hand. The
// EventSink already sees every native event; this is a subscriber that turns the
// load-bearing lifecycle events into structured log lines, so "what did the
// scheduled wake actually do?" is answerable from the daemon's output.

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/** A line-per-event logger to stderr: `<iso> <LEVEL> <message> k=v k=v`. */
export function consoleLogger(): Logger {
  return {
    log(level, message, fields) {
      const tail = fields
        ? " " +
          Object.entries(fields)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${fmt(v)}`)
            .join(" ")
        : "";
      process.stderr.write(`${nowIso()} ${level.toUpperCase()} ${message}${tail}\n`);
    },
  };
}

function fmt(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // keep one event on one line, and short — full detail still lives in the db
  const clipped = s.length > 120 ? `${s.slice(0, 120)}…` : s;
  return /\s/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

const short = (id: string): string => id.replace(/^(run|trg|apr)_/, "$1:").slice(0, 12);

function sourceLabel(source: RunSource | undefined): string {
  if (source?.kind === "trigger") return `trigger:${source.triggerType}`;
  return "message";
}

/**
 * Subscribe a logger to a daemon's event stream and log run lifecycle. Tracks
 * each run's source (only `run.started` carries it) so later events can be
 * labelled and a proactive suspension can be flagged loudly. Returns the
 * unsubscribe handle.
 */
export function attachRunLogger(daemon: Daemon, logger: Logger = consoleLogger()): () => void {
  const sourceByRun = new Map<string, RunSource | undefined>();
  const srcOf = (e: ReefEvent): RunSource | undefined =>
    e.runId ? sourceByRun.get(e.runId) : undefined;

  return daemon.subscribe((e: ReefEvent) => {
    switch (e.type) {
      case "run.started":
        sourceByRun.set(e.runId, e.source);
        logger.log("info", "run started", {
          run: short(e.runId),
          agent: e.agentId,
          source: sourceLabel(e.source),
          session: e.sessionKey,
        });
        break;
      case "run.completed":
        logger.log("info", "run completed", {
          run: short(e.runId),
          source: sourceLabel(srcOf(e)),
          stop: e.stopReason,
        });
        sourceByRun.delete(e.runId);
        break;
      case "run.failed":
        logger.log("error", "run failed", {
          run: short(e.runId),
          source: sourceLabel(srcOf(e)),
          error: e.error,
        });
        sourceByRun.delete(e.runId);
        break;
      case "run.suspended": {
        // Proactive runs auto-deny gated tools now, so they shouldn't reach
        // here — if one does, it's a deadlock and worth a warning.
        const proactive = srcOf(e)?.kind === "trigger";
        logger.log(
          proactive ? "warn" : "info",
          proactive ? "proactive run suspended with no approver" : "run suspended",
          { run: short(e.runId), stop: e.stopReason, session: e.sessionKey },
        );
        break;
      }
      case "approval.requested":
        logger.log("info", "approval requested", { run: short(e.runId), action: e.action });
        break;
      case "tool.failed":
        // surfaces the proactive auto-deny ("treated as denied") and real errors
        logger.log("warn", "tool failed", { run: short(e.runId), tool: e.toolUseId, error: e.error });
        break;
      case "context.compacted":
        logger.log("info", "context compacted", {
          session: e.sessionKey,
          folded: e.foldedMessages,
        });
        break;
      default:
        break;
    }
  });
}
