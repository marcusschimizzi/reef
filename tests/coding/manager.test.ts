import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { CodingSessionManager } from "../../src/coding/manager.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ReefEvent, ReefEventInit } from "../../src/protocol/events.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-mgr-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class FakeHandle implements CodingDriverHandle {
  dataCb?: (c: string) => void; exitCb?: (c: number | null) => void;
  written: string[] = []; killed = false;
  onData(cb: (c: string) => void) { this.dataCb = cb; }
  onExit(cb: (c: number | null) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  kill() { this.killed = true; }
  feed(chunk: string) { this.dataCb?.(chunk); }
  die(code: number | null) { this.exitCb?.(code); }
}
class FakeDriver implements CodingAgentDriver {
  handle = new FakeHandle();
  start(_opts: StartOpts): CodingDriverHandle { return this.handle; }
}

function setup() {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  const driver = new FakeDriver();
  const mgr = new CodingSessionManager({ spine, emit, driver, traceDir: join(dir, "traces") });
  return { spine, events, driver, mgr, dir };
}

describe("CodingSessionManager", () => {
  it("starts a session: row + started event + trace", () => {
    const { spine, events, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "list files" });
    expect(spine.getCodingSession(id)).toMatchObject({ status: "running", agentKind: "claude-code" });
    expect(events.find((e) => e.type === "coding.session.started")).toMatchObject({ codingSessionId: id });
    expect(existsSync(spine.getCodingSession(id)!.tracePath)).toBe(true);
  });

  it("forwards output and flags a detected prompt (status -> awaiting_decision)", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("hello\n");
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(events.some((e) => e.type === "coding.output")).toBe(true);
    expect(events.find((e) => e.type === "coding.prompt.detected")).toMatchObject({ codingSessionId: id });
    expect(spine.getCodingSession(id)!.status).toBe("awaiting_decision");
  });

  it("send() injects to the driver; cancel() kills it", () => {
    const { driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    mgr.send(id, "1\r");
    expect(driver.handle.written).toContain("1\r");
    mgr.cancel(id);
    expect(driver.handle.killed).toBe(true);
  });

  it("on exit, marks completed and emits completed", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.die(0);
    expect(spine.getCodingSession(id)!.status).toBe("completed");
    expect(events.some((e) => e.type === "coding.session.completed")).toBe(true);
  });

  it("a cancelled session exits as `cancelled`, not `failed`", () => {
    const { spine, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    mgr.cancel(id);
    driver.handle.die(143); // the PTY exits non-zero from the kill
    expect(spine.getCodingSession(id)!.status).toBe("cancelled");
  });

  it("close() kills live sessions and marks them cancelled", () => {
    const { spine, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    mgr.close();
    expect(driver.handle.killed).toBe(true);
    expect(spine.getCodingSession(id)!.status).toBe("cancelled");
  });
});
