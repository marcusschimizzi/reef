import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { CodingSessionManager } from "../../src/coding/manager.js";
import { HANDBACK_MARKER } from "../../src/coding/handback.js";
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

function setup(policy: ApprovalPolicy = new FakePolicy(() => ({ action: "gate" })), idleMs?: number) {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  const driver = new FakeDriver();
  // Inject a fake handback-file watcher: captures onSignal so a test can fire the
  // Stop-hook signal synchronously, and tracks dispose so leak-on-teardown is
  // checkable. Injecting it also keeps every test off the real fs.watch (no leaks).
  let triggerStopHook: (() => void) | undefined;
  let disposed = false;
  const watchHandbackFile = (_file: string, onSignal: () => void) => {
    triggerStopHook = onSignal;
    disposed = false;
    return () => { triggerStopHook = undefined; disposed = true; };
  };
  const mgr = new CodingSessionManager({
    spine, emit, driver, traceDir: join(dir, "traces"), policy, idleMs, watchHandbackFile,
  });
  return {
    spine, events, driver, mgr, dir,
    getTrigger: () => triggerStopHook,
    isDisposed: () => disposed,
  };
}

describe("CodingSessionManager", () => {
  it("starts a session: row + started event + trace", () => {
    const { spine, events, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "list files" });
    expect(spine.getCodingSession(id)).toMatchObject({ status: "running", agentKind: "claude-code" });
    expect(events.find((e) => e.type === "coding.session.started")).toMatchObject({ codingSessionId: id });
    expect(existsSync(spine.getCodingSession(id)!.tracePath)).toBe(true);
  });

  it("expands a leading ~ and resolves the directory to an absolute path", () => {
    const { spine, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "~/dev/push", task: "t" });
    const expected = join(homedir(), "dev/push");
    expect(driver.lastOpts?.directory).toBe(expected); // node-pty cwd must be absolute, not "~/…"
    expect(spine.getCodingSession(id)!.directory).toBe(expected);
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

  it("resolveCodingApproval fails closed on a non-canonical decision (injects No, denies)", () => {
    const { spine, events, driver, mgr } = setup();
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n");
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string };
    mgr.resolveCodingApproval(req.approvalId, "garbage");
    // a garbage decision must NOT inject Yes (option 1) and must record a denial
    expect(driver.handle.written).toContain("2\r");
    expect(driver.handle.written).not.toContain("1\r");
    expect(spine.getCodingApproval(req.approvalId)!.status).toBe("denied");
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

  it("injects the handback instruction into the agent's system prompt", () => {
    const { driver, mgr } = setup();
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    expect(driver.lastOpts?.appendSystemPrompt).toContain(HANDBACK_MARKER);
  });

  it("idle silence parks the session paused (fallback handback)", () => {
    vi.useFakeTimers();
    try {
      const { spine, events, mgr, driver } = setup(new FakePolicy(() => ({ action: "allow" })), 50);
      const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
      driver.handle.feed("working...\n"); // arms the idle timer
      vi.advanceTimersByTime(60); // idle fires → handback → kill
      expect(driver.handle.killed).toBe(true);
      driver.handle.die(143); // exit finalizes paused
      expect(events.find((e) => e.type === "coding.session.paused")).toMatchObject({ codingSessionId: id });
      expect(spine.getCodingSession(id)!.status).toBe("paused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Stop-hook signal parks the session paused and tears down the PTY (no completed)", () => {
    const { spine, events, driver, mgr, getTrigger } = setup(new FakePolicy(() => ({ action: "allow" })));
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    getTrigger()!(); // the Stop hook touched the sentinel → reef's watcher fires
    expect(driver.handle.killed).toBe(true);
    expect(events.some((e) => e.type === "coding.session.paused")).toBe(false);
    driver.handle.die(143); // exit finalizes paused
    expect(events.find((e) => e.type === "coding.session.paused")).toMatchObject({ codingSessionId: id });
    expect(spine.getCodingSession(id)!.status).toBe("paused");
    expect(events.some((e) => e.type === "coding.session.completed")).toBe(false);
  });

  it("passes --settings pointing at a reef-owned Stop-hook settings file", () => {
    const { driver, mgr } = setup();
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    const settingsPath = driver.lastOpts?.settingsPath;
    expect(settingsPath).toMatch(/\.settings\.json$/);
    expect(existsSync(settingsPath!)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath!, "utf8")) as {
      hooks?: { Stop?: Array<{ hooks: Array<{ type: string; command: string }> }> };
    };
    const command = parsed.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    expect(command).toContain("touch");
    expect(command).toContain(".handback");
  });

  it("the Stop-hook handback is latched — only one paused event even if it re-fires", () => {
    const { events, mgr, driver, getTrigger } = setup(new FakePolicy(() => ({ action: "allow" })));
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    const trigger = getTrigger()!;
    trigger();
    // A duplicate Stop touch + a sentinel marker must both be no-ops after the latch.
    trigger();
    driver.handle.feed(`done\n${HANDBACK_MARKER}\n`);
    driver.handle.die(143); // one exit → exactly one paused
    expect(events.filter((e) => e.type === "coding.session.paused").length).toBe(1);
  });

  it("disposes the Stop-hook watcher on a normal exit (no leaked fs.watch)", () => {
    const { driver, mgr, isDisposed } = setup();
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    expect(isDisposed()).toBe(false);
    driver.handle.die(0); // normal completion, no handback
    expect(isDisposed()).toBe(true);
  });

  it("resume() revives a paused session via --resume and re-links the subwork", () => {
    const { spine, driver, mgr, getTrigger } = setup(new FakePolicy(() => ({ action: "allow" })));
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "step 1" });
    const ext = spine.getCodingSession(id)!.externalSessionId;
    // Drive it to paused (Stop-hook signal → handback → kill → paused on exit).
    getTrigger()!();
    driver.handle.die(143);
    expect(spine.getCodingSession(id)!.status).toBe("paused");

    mgr.resume(id, "now do step 2", { spawningRunId: "run_2", spawningToolUseId: "tool_2" });
    expect(spine.getCodingSession(id)!.status).toBe("running");
    expect(spine.findCodingSessionBySubwork("run_2", "tool_2")!.id).toBe(id);
    expect(driver.lastOpts?.resume).toBe(true);
    expect(driver.lastOpts?.sessionId).toBe(ext);
    expect(driver.lastOpts?.task).toBe("now do step 2");
  });

  it("resume() reuses the session's stored model", () => {
    const { spine, driver, mgr, getTrigger } = setup(new FakePolicy(() => ({ action: "allow" })));
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t", model: "haiku" });
    getTrigger()!();
    driver.handle.die(143);
    expect(spine.getCodingSession(id)!.status).toBe("paused");
    mgr.resume(id, "again");
    expect(driver.lastOpts?.model).toBe("haiku");
  });

  it("resume() throws on a non-paused session and on an unknown id", () => {
    const { mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    expect(() => mgr.resume(id, "x")).toThrow(/not resumable/);
    expect(() => mgr.resume("cs_nope", "x")).toThrow(/not resumable/);
  });

  it("resume() re-arms the handback watcher so the next turn can pause again", () => {
    const { spine, events, driver, mgr, getTrigger } = setup(new FakePolicy(() => ({ action: "allow" })));
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    getTrigger()!(); // first handback
    driver.handle.die(143);
    expect(spine.getCodingSession(id)!.status).toBe("paused");

    mgr.resume(id, "step 2");
    expect(spine.getCodingSession(id)!.status).toBe("running");
    // launch re-armed the watcher → getTrigger() now returns the NEW onSignal.
    getTrigger()!();
    driver.handle.die(143);
    expect(spine.getCodingSession(id)!.status).toBe("paused");
    expect(events.filter((e) => e.type === "coding.session.paused").length).toBe(2);
  });

  it("a gated prompt disarms the idle timer (no handback while a human decides)", () => {
    vi.useFakeTimers();
    try {
      const { spine, events, mgr, driver } = setup(undefined, 50); // default policy gates
      const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
      driver.handle.feed("working...\n"); // arms idle
      driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n"); // gates, disarms idle
      vi.advanceTimersByTime(100);
      expect(events.some((e) => e.type === "coding.session.paused")).toBe(false);
      expect(spine.getCodingSession(id)!.status).toBe("awaiting_decision");
    } finally {
      vi.useRealTimers();
    }
  });
});
