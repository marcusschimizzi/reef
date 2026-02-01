import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
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

describe("parseJsonLines", () => {
  it("parses partial lines", async () => {
    const stream = Readable.from([
      '{"type":"progress","message":"a"}\n{"type":"progress"',
      ',"message":"b"}\n'
    ]);
    const events = await collect(stream);
    expect(events.length).toBe(2);
  });

  it("emits error events on malformed JSON", async () => {
    const stream = Readable.from([
      '{"type":"progress","message":"a"}\n',
      '{bad json}\n'
    ]);
    const events = [];
    for await (const event of parseJsonLines(stream, (payload) => ({
      timestamp: "now",
      type: "progress",
      agentId: "",
      payload
    }))) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

});
