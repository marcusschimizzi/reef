import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { ClaudeAdapter } from "../../src/adapters/ClaudeAdapter.js";

async function readFixture(name: string): Promise<Readable> {
  const data = await readFile(new URL(`../fixtures/${name}`, import.meta.url));
  return Readable.from([data]);
}

describe("ClaudeAdapter", () => {
  it("parses events and emits needs_input with options", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    for await (const event of adapter.parseOutput(await readFixture("claude-stream.jsonl"))) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "needs_input")).toBe(true);
    const needsInput = events.find((event) => event.type === "needs_input");
    expect(needsInput?.payload.question).toBeDefined();
    expect(needsInput?.payload.options).toBeDefined();
  });
});
