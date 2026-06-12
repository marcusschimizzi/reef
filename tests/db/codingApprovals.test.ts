import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-ca-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const spine = () => new Spine(join(tmp(), "reef.db"));

function makeSession(s: Spine, over: Partial<Parameters<Spine["createCodingSession"]>[0]> = {}) {
  const id = `cs_${Math.random().toString(16).slice(2)}`;
  s.createCodingSession({
    id, spawningRunId: null, spawningToolUseId: null, agentKind: "claude-code",
    externalSessionId: "ext", directory: "/tmp/x", status: "running", task: "t",
    tracePath: "/tmp/x.jsonl", ...over,
  });
  return id;
}

describe("coding_sessions subwork link", () => {
  it("round-trips spawning_tool_use_id and finds by (run, toolUse)", () => {
    const s = spine();
    const id = makeSession(s, { spawningRunId: "run_1", spawningToolUseId: "tool_9" });
    expect(s.getCodingSession(id)!.spawningToolUseId).toBe("tool_9");
    expect(s.findCodingSessionBySubwork("run_1", "tool_9")!.id).toBe(id);
    expect(s.findCodingSessionBySubwork("run_1", "nope")).toBeUndefined();
  });
});
