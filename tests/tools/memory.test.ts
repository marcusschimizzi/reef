import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundFs } from "../../src/fs/capability.js";
import { SqliteMemory } from "../../src/memory/sqlite.js";
import { recallMemoryTool, recordMemoryTool } from "../../src/tools/memory.js";
import type { ToolContext } from "../../src/tools/types.js";

const dirs: string[] = [];
function ctx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "reef-memtool-"));
  dirs.push(dir);
  return {
    fs: new BoundFs(dir),
    workspaceRoot: dir,
    memory: new SqliteMemory(join(dir, "reef.db"), "agent_a"),
  };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("memory tools", () => {
  it("record_memory then recall_memory round-trip through ctx.memory", async () => {
    const c = ctx();
    const recorded = (await recordMemoryTool.run(
      { content: "The user is based in Berlin.", kind: "fact", tags: ["location"] },
      c,
    )) as { id: string };
    expect(recorded.id).toMatch(/^mem_/);

    const recalled = (await recallMemoryTool.run({ query: "where is the user based" }, c)) as {
      results: Array<{ id: string; content: string; tags?: string[] }>;
    };
    expect(recalled.results[0]).toMatchObject({
      id: recorded.id,
      content: "The user is based in Berlin.",
      tags: ["location"],
    });
  });

  it("throws a clear error when no memory store is in context", async () => {
    const c = ctx();
    const noMemory: ToolContext = { fs: c.fs, workspaceRoot: c.workspaceRoot };
    await expect(recallMemoryTool.run({ query: "anything" }, noMemory)).rejects.toThrow(
      /without a memory store/,
    );
  });
});
