// src/coding/trace.ts
//
// The flight recorder. Every coding session writes a complete, timestamped JSONL
// trace: raw PTY bytes (ground truth), detected events, injections, lifecycle.
// Raw bytes make the session REPLAYABLE — the regression net for brittle scraping.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DriverEvent } from "./processor.js";

export type TraceBody =
  | { type: "pty.raw"; bytes: string } // base64 of exactly what the agent emitted
  | { type: "event"; event: DriverEvent }
  | { type: "inject"; data: string; reason: string }
  | { type: "lifecycle"; event: string; code?: number | null };

export type TraceLine = TraceBody & { t: number };

export class TraceWriter {
  private readonly fd: number;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  write(body: TraceBody): void {
    const line: TraceLine = { t: Date.now(), ...body };
    appendFileSync(this.fd, `${JSON.stringify(line)}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Parse a trace file into its lines (skips blanks/garbage defensively). */
export function readTrace(path: string): TraceLine[] {
  const out: TraceLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as TraceLine);
    } catch {
      // a partially-written final line on a crash — ignore
    }
  }
  return out;
}
