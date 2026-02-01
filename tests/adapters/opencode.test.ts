import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { OpenCodeAdapter } from "../../src/adapters/OpenCodeAdapter.js";

async function readFixture(name: string): Promise<Buffer> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url));
}

function chunkStream(data: Buffer, chunkSize = 32): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  return Readable.from(chunks);
}

describe("OpenCodeAdapter", () => {
  it("parses real jsonl fixture", async () => {
    const adapter = new OpenCodeAdapter();
    const events = [];
    const data = await readFixture("opencode-real.jsonl");
    for await (const event of adapter.parseOutput(chunkStream(data))) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "step_start")).toBe(true);
    expect(events.some((event) => event.type === "step_finish")).toBe(true);
  });
});
