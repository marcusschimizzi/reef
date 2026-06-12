import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../../src/coding/trace.js";
import { replayTrace } from "../../src/coding/replay.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-replay-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("replayTrace", () => {
  it("re-derives events by feeding recorded raw bytes back through the processor", () => {
    const path = join(tmp(), "s.jsonl");
    const w = new TraceWriter(path);
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    w.write({ type: "pty.raw", bytes: b64("working...\n") });
    w.write({ type: "pty.raw", bytes: b64("Do you want to proceed?\n❯ 1. Yes\n  2. No\n") });
    w.close();

    const events = replayTrace(path);
    expect(events.some((e) => e.type === "prompt-pending")).toBe(true);
  });
});
