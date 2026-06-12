import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-dc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class NullRouter implements ModelRouter { async generateTurn(_i: ModelTurnInput): Promise<ModelTurn> { throw new Error("unused"); } }
class FakeHandle implements CodingDriverHandle {
  dataCb?: (c: string) => void; exitCb?: (c: number | null) => void; written: string[] = []; killed = false;
  onData(cb: (c: string) => void) { this.dataCb = cb; } onExit(cb: (c: number | null) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); } kill() { this.killed = true; }
}
class FakeDriver implements CodingAgentDriver { handle = new FakeHandle(); start(_o: StartOpts): CodingDriverHandle { return this.handle; } }

describe("Daemon coding-session control", () => {
  it("starts, sends, and cancels a coding session via the daemon API", () => {
    const dir = tmp();
    const driver = new FakeDriver();
    const d = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router: new NullRouter(), codingDriver: driver });
    const id = d.startCodingSession({ agentKind: "claude-code", directory: dir, task: "list" });
    expect(d.spine.getCodingSession(id)!.status).toBe("running");
    d.sendToCodingSession(id, "1\r");
    expect(driver.handle.written).toContain("1\r");
    d.cancelCodingSession(id);
    expect(driver.handle.killed).toBe(true);
    d.close();
  });
});
