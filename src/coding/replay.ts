// src/coding/replay.ts
//
// Deterministic replay: feed a trace's recorded raw bytes back through a fresh
// CodingStreamProcessor — the EXACT path the live session used. This is how the
// brittle scraping is iterated and regression-tested: a captured session is a
// fixture; "why didn't it detect that prompt?" is debugged offline, no `claude`.

import { CodingStreamProcessor, type DriverEvent } from "./processor.js";
import { readTrace } from "./trace.js";

export function replayTrace(path: string): DriverEvent[] {
  const processor = new CodingStreamProcessor();
  const events: DriverEvent[] = [];
  for (const line of readTrace(path)) {
    if (line.type === "pty.raw") {
      const chunk = Buffer.from(line.bytes, "base64").toString("utf8");
      events.push(...processor.push(chunk));
    }
  }
  return events;
}
