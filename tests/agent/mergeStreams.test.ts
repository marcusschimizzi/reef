import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mergeStreams } from "../../src/agent/mergeStreams.js";
import { parseJsonLines } from "../../src/adapters/jsonl.js";

async function collect(stream: NodeJS.ReadableStream) {
  const events = [];
  for await (const event of parseJsonLines(stream, (payload) => ({
    timestamp: "now",
    type: "progress",
    agentId: "",
    payload
  }))) {
    events.push(event);
  }
  return events;
}

describe("mergeStreams", () => {
  it("merges stdout and stderr streams", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const merged = mergeStreams([stdout, stderr]);

    const promise = collect(merged);
    stdout.write('{"type":"progress","message":"out"}\n');
    stderr.write('{"type":"progress","message":"err"}\n');
    stdout.end();
    stderr.end();

    const events = await promise;
    expect(events.length).toBe(2);
  });
});
