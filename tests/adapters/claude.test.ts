import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { ClaudeAdapter } from "../../src/adapters/ClaudeAdapter.js";

async function readFixture(name: string): Promise<Buffer> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url));
}

function chunkStream(data: Buffer, chunkSize = 64): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  return Readable.from(chunks);
}

function interleaveNoise(data: Buffer, noise = "stderr: warning\n"): Readable {
  const pivot = Math.floor(data.length / 2);
  return Readable.from([data.slice(0, pivot), Buffer.from(noise), data.slice(pivot)]);
}

describe("ClaudeAdapter", () => {
  it("parses real stream-json with partial chunks", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    const data = await readFixture("claude-stream.jsonl");
    for await (const event of adapter.parseOutput(chunkStream(data))) {
      events.push(event);
    }
    // Current Claude stream-json output is passed through as event.type = payload.type.
    // The fixture should at least include an assistant message and a final result.
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "assistant")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(true);
  });

  it("emits error events for stderr noise but keeps parsing", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    const data = await readFixture("claude-stream.jsonl");
    for await (const event of adapter.parseOutput(interleaveNoise(data))) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "assistant")).toBe(true);
  });
});
