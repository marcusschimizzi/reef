import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter, readTrace } from "../../src/coding/trace.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-trace-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("TraceWriter / readTrace", () => {
  it("appends JSONL lines (each stamped) and reads them back", () => {
    const path = join(tmp(), "s.jsonl");
    const w = new TraceWriter(path);
    w.write({ type: "lifecycle", event: "spawn" });
    w.write({ type: "pty.raw", bytes: Buffer.from("hi").toString("base64") });
    w.write({ type: "event", event: { type: "exited", code: 0 } });
    w.close();

    const lines = readTrace(path);
    expect(lines.map((l) => l.type)).toEqual(["lifecycle", "pty.raw", "event"]);
    expect(typeof lines[0]!.t).toBe("number");
    expect(lines[1]).toMatchObject({ type: "pty.raw", bytes: Buffer.from("hi").toString("base64") });
  });
});
