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

describe("coding_approvals", () => {
  it("creates pending, reads back, and resolves", () => {
    const s = spine();
    const cs = makeSession(s);
    s.createCodingApproval({
      id: "apr_1", codingSessionId: cs, promptText: "Do you want to edit a.ts?",
      options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }],
      toolName: "claude-code:Edit", input: { path: "a.ts" },
    });
    const a = s.getCodingApproval("apr_1")!;
    expect(a).toMatchObject({ codingSessionId: cs, status: "pending", toolName: "claude-code:Edit" });
    expect(a.options).toEqual([{ index: 1, label: "Yes" }, { index: 2, label: "No" }]);

    s.resolveCodingApproval("apr_1", "allowed", "allow-once");
    const r = s.getCodingApproval("apr_1")!;
    expect(r.status).toBe("allowed");
    expect(r.decision).toBe("allow-once");
    expect(r.decidedAt).toBeTruthy();
  });

  it("getCodingApproval returns undefined for an unknown id", () => {
    expect(spine().getCodingApproval("nope")).toBeUndefined();
  });
});
