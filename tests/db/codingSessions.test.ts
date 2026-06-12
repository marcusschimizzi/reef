import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";

const dirs: string[] = [];
const spine = () => { const d = mkdtempSync(join(tmpdir(), "reef-cs-")); dirs.push(d); return new Spine(join(d, "reef.db")); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("coding_sessions spine", () => {
  it("creates, reads, updates status, and lists", () => {
    const s = spine();
    s.createCodingSession({
      id: "cs_1", spawningRunId: null, agentKind: "claude-code",
      externalSessionId: "uuid-1", directory: "/tmp/proj", status: "running",
      task: "list files", tracePath: "/tmp/proj/.trace.jsonl",
    });
    expect(s.getCodingSession("cs_1")).toMatchObject({ id: "cs_1", status: "running", agentKind: "claude-code" });

    s.setCodingSessionStatus("cs_1", "completed", "done");
    const done = s.getCodingSession("cs_1");
    expect(done).toMatchObject({ status: "completed", result: "done" });
    expect(done!.endedAt).toBeTruthy();

    expect(s.listCodingSessions().map((c) => c.id)).toEqual(["cs_1"]);
    s.close();
  });
});
