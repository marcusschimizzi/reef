import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { CodexAdapter } from "../../src/adapters/CodexAdapter.js";

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

describe("CodexAdapter", () => {
  it("parses real jsonl with partial chunks", async () => {
    const adapter = new CodexAdapter();
    const events = [];
    const data = await readFixture("codex.jsonl");
    for await (const event of adapter.parseOutput(chunkStream(data))) {
      events.push(event);
    }
    // Codex --json output is passed through as event.type = payload.type.
    // The fixture includes bootstrap noise + at least one agent_message item.
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "thread.started")).toBe(true);
    // The final human-facing content in this fixture currently comes from an agent_message item.
    expect(events.some((event) => event.type === "item.completed" && event.payload?.item?.type === "agent_message")).toBe(true);
  });

  it("emits error events for stderr noise but keeps parsing", async () => {
    const adapter = new CodexAdapter();
    const events = [];
    const data = await readFixture("codex.jsonl");
    for await (const event of adapter.parseOutput(interleaveNoise(data))) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "thread.started")).toBe(true);
  });
});
