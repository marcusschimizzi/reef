import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { CodingSessionManager } from "../../src/coding/manager.js";
import { encodeProjectPath } from "../../src/coding/transcript.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ReefEvent, ReefEventInit } from "../../src/protocol/events.js";
import type { ApprovalPolicy, PolicyContext, PolicyDecision } from "../../src/policy/policy.js";

class FakePolicy implements ApprovalPolicy {
  constructor(private readonly fn: (ctx: PolicyContext) => PolicyDecision) {}
  last?: PolicyContext;
  decide(ctx: PolicyContext): PolicyDecision { this.last = ctx; return this.fn(ctx); }
}

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
  lastOpts?: StartOpts;
  start(opts: StartOpts): CodingDriverHandle { this.lastOpts = opts; return this.handle; }
}

function setup(policy: ApprovalPolicy = new FakePolicy(() => ({ action: "gate" }))) {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  const driver = new FakeDriver();
  const mgr = new CodingSessionManager({ spine, emit, driver, traceDir: join(dir, "traces"), policy });
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

  it("threads an explicit model to the driver", () => {
    const { driver, mgr } = setup();
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t", model: "haiku" });
    expect(driver.lastOpts?.model).toBe("haiku");
  });

  it("falls back to REEF_CODING_MODEL when no explicit model is given", () => {
    const { driver, mgr } = setup();
    process.env.REEF_CODING_MODEL = "sonnet";
    try {
      mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
      expect(driver.lastOpts?.model).toBe("sonnet");
    } finally {
      delete process.env.REEF_CODING_MODEL;
    }
  });

  it("an explicit model overrides REEF_CODING_MODEL", () => {
    const { driver, mgr } = setup();
    process.env.REEF_CODING_MODEL = "sonnet";
    try {
      mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t", model: "haiku" });
      expect(driver.lastOpts?.model).toBe("haiku");
    } finally {
      delete process.env.REEF_CODING_MODEL;
    }
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

  it("policy 'allow' injects the mapped digit + audits + returns to running", () => {
    const policy = new FakePolicy(() => ({ action: "allow" }));
    const { spine, driver, mgr } = setup(policy);
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toContain("1\r");
    expect(spine.getCodingSession(id)!.status).toBe("running");
    expect(policy.last).toMatchObject({ needsApproval: true, sessionKey: `coding:${id}` });
  });

  it("an allow decision's audit row links to the spawning run id", () => {
    const policy = new FakePolicy(() => ({ action: "allow" }));
    const { spine, driver, mgr } = setup(policy);
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t", spawningRunId: "run_xyz" });
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toContain("1\r");
    const actions = spine.listActions({ runId: "run_xyz" });
    expect(actions.length).toBe(1);
    expect(actions[0]!.runId).toBe("run_xyz");
    expect(spine.listActions({ runId: id })).toEqual([]);
  });

  it("policy 'deny' injects the No option", () => {
    const policy = new FakePolicy(() => ({ action: "deny" }));
    const { driver, mgr } = setup(policy);
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toContain("2\r");
  });

  it("policy 'gate' writes a coding_approvals row + approval.requested, then waits", () => {
    const { spine, events, driver, mgr } = setup(); // default policy gates
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toEqual([]); // nothing injected — waiting
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string } | undefined;
    expect(req).toBeTruthy();
    expect(spine.getCodingApproval(req!.approvalId)!.status).toBe("pending");
    expect(spine.getCodingSession(id)!.status).toBe("awaiting_decision");
  });

  it("resolveCodingApproval('allow-once') injects Yes and resolves the row", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n");
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string };
    mgr.resolveCodingApproval(req.approvalId, "allow-once");
    expect(driver.handle.written).toContain("1\r");
    expect(spine.getCodingApproval(req.approvalId)!.status).toBe("allowed");
    expect(spine.getCodingSession(id)!.status).toBe("running");
  });

  it("on completion, stores the transcript's final assistant text as result", () => {
    const { spine, driver, mgr, dir } = setup(new FakePolicy(() => ({ action: "allow" })));
    const root = join(dir, "claude-projects");
    const workdir = join(dir, "work");
    mkdirSync(workdir, { recursive: true });
    const id = mgr.start({ agentKind: "claude-code", directory: workdir, task: "t" });
    const ext = spine.getCodingSession(id)!.externalSessionId;
    const tdir = join(root, encodeProjectPath(workdir));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      join(tdir, `${ext}.jsonl`),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: created a.ts" }] } }) + "\n",
    );
    // Point the manager's transcript lookup at our temp root.
    process.env.REEF_CLAUDE_PROJECTS = root;
    driver.handle.die(0);
    delete process.env.REEF_CLAUDE_PROJECTS;
    expect(spine.getCodingSession(id)!.result).toBe("Done: created a.ts");
  });

  it("close() kills live sessions and marks them cancelled", () => {
    const { spine, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    mgr.close();
    expect(driver.handle.killed).toBe(true);
    expect(spine.getCodingSession(id)!.status).toBe("cancelled");
  });
});
