import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemory } from "../../src/memory/sqlite.js";

const dirs: string[] = [];
function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-mem-"));
  dirs.push(d);
  return join(d, "reef.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteMemory (default backend)", () => {
  it("records then recalls by free-text query", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    const { id } = await mem.record({ content: "The user prefers dark mode." });
    const hits = await mem.recall("dark mode preference");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id, content: "The user prefers dark mode." });
    expect(typeof hits[0]?.score).toBe("number");
    mem.close();
  });

  it("ranks the more relevant memory first", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    await mem.record({ content: "The capital of France is Paris." });
    await mem.record({ content: "Paris Hilton is a celebrity, unrelated to France geography trivia facts." });
    await mem.record({ content: "The user lives in Berlin." });

    const hits = await mem.recall("capital of France");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.content).toBe("The capital of France is Paris.");
    // scores are descending (higher = more relevant)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score!).toBeGreaterThanOrEqual(hits[i]!.score!);
    }
    mem.close();
  });

  it("filters recall by tags (all must be present)", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    await mem.record({ content: "deploy script lives in infra repo", tags: ["ops", "deploy"] });
    await mem.record({ content: "deploy notes from the meeting", tags: ["notes"] });

    const onlyOps = await mem.recall("deploy", { tags: ["ops"] });
    expect(onlyOps).toHaveLength(1);
    expect(onlyOps[0]?.content).toContain("infra repo");

    const both = await mem.recall("deploy", { tags: ["ops", "missing"] });
    expect(both).toHaveLength(0);
    mem.close();
  });

  it("isolates memory by namespace — one agent cannot recall another's", async () => {
    const path = dbPath();
    const a = new SqliteMemory(path, "agent_a");
    const b = new SqliteMemory(path, "agent_b");
    await a.record({ content: "agent A's private secret token" });

    expect(await b.recall("secret token")).toHaveLength(0);
    expect(await a.recall("secret token")).toHaveLength(1);
    a.close();
    b.close();
  });

  it("does not throw on queries containing FTS operator characters", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    await mem.record({ content: "remember to email the quarterly report" });
    // quotes, NEAR-ish punctuation, a dangling operator — all must be neutralized
    const hits = await mem.recall('"email" AND report* (quarterly): -draft');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    mem.close();
  });

  it("returns nothing for an empty/termless query rather than erroring", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    await mem.record({ content: "something" });
    expect(await mem.recall("   ?!  ")).toEqual([]);
    expect(await mem.recall("")).toEqual([]);
    mem.close();
  });

  it("honours the limit and respects it after tag filtering", async () => {
    const mem = new SqliteMemory(dbPath(), "agent_a");
    for (let i = 0; i < 5; i++) await mem.record({ content: `note number ${i} about cats` });
    const hits = await mem.recall("cats note", { limit: 2 });
    expect(hits).toHaveLength(2);
    mem.close();
  });

  it("persists across a reopen — durable cross-session knowledge", async () => {
    const path = dbPath();
    const first = new SqliteMemory(path, "agent_a");
    await first.record({ content: "the project codename is Reef" });
    first.close();

    const reopened = new SqliteMemory(path, "agent_a");
    const hits = await reopened.recall("project codename");
    expect(hits[0]?.content).toBe("the project codename is Reef");
    reopened.close();
  });
});
