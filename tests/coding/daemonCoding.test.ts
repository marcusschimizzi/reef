import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";
import type { ApprovalPolicy, PolicyContext, PolicyDecision } from "../../src/policy/policy.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-dc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class NullRouter implements ModelRouter { async generateTurn(_i: ModelTurnInput): Promise<ModelTurn> { throw new Error("unused"); } }
class FakeHandle implements CodingDriverHandle {
  dataCb?: (c: string) => void; exitCb?: (c: number | null) => void; written: string[] = []; killed = false;
  onData(cb: (c: string) => void) { this.dataCb = cb; } onExit(cb: (c: number | null) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); } kill() { this.killed = true; }
  /** Push raw output bytes (drives prompt detection + handback). */
  feed(c: string) { this.dataCb?.(c); }
  /** Drive the PTY exit so the manager records the terminal status + emits. */
  die(code: number | null) { this.exitCb?.(code); }
}
class FakeDriver implements CodingAgentDriver { handle = new FakeHandle(); start(_o: StartOpts): CodingDriverHandle { return this.handle; } }

/** Scripted router: hands out turns in order, mirroring tests/daemon/daemon.test.ts. */
class FakeRouter implements ModelRouter {
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("FakeRouter: out of turns");
    for (const b of turn.content) if (b.type === "text") input.onTextDelta?.(b.text);
    return turn;
  }
}

/** Policy that always allows — isolates the subwork suspend from the approval gate. */
class AllowPolicy implements ApprovalPolicy {
  decide(_ctx: PolicyContext): PolicyDecision { return { action: "allow" }; }
}

const agent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "be helpful",
  model: "fake",
  toolAllowlist: ["start_coding_session"],
};

/** Build a daemon wired for the agent-initiated coding-session flow. The router
 *  scripts the two turns: turn 1 calls start_coding_session, turn 2 finishes. */
function setup() {
  const dir = tmp();
  const workDir = tmp();
  const driver = new FakeDriver();
  // Fake handback-file watcher: captures onSignal so a test can fire the Stop-hook
  // signal synchronously (re-armed on each launch → returns the latest onSignal).
  let triggerStopHook: (() => void) | undefined;
  const codingWatchHandbackFile = (_file: string, onSignal: () => void) => {
    triggerStopHook = onSignal;
    return () => { triggerStopHook = undefined; };
  };
  const daemon = new Daemon({
    dbPath: join(dir, "reef.db"),
    workspaceDir: join(dir, "ws"),
    codingTraceDir: join(dir, "traces"),
    codingWatchHandbackFile,
    router: new FakeRouter([
      {
        stop: "tool_use",
        content: [
          { type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } },
        ],
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      {
        stop: "completed",
        content: [{ type: "text", text: "subwork done, continuing" }],
        usage: { inputTokens: 8, outputTokens: 2 },
      },
    ]),
    policy: new AllowPolicy(),
    codingDriver: driver,
  });
  daemon.registerAgent(agent);
  return { daemon, driver, workDir, getTrigger: () => triggerStopHook };
}

/** Build a daemon whose router drives start_coding_session → send_feedback →
 *  done. Turn 2's send_feedback needs the cs_ id, unknown at scripting time, so
 *  the router is a stateful closure that reads it from the spine at call time. */
function setupFeedback() {
  const dir = tmp();
  const workDir = tmp();
  const driver = new FakeDriver();
  let turn = 0;
  // Fake handback-file watcher: re-armed on each launch → getTrigger returns the
  // latest onSignal, so firing it after a resume drives the 2nd handback cycle.
  let triggerStopHook: (() => void) | undefined;
  const codingWatchHandbackFile = (_file: string, onSignal: () => void) => {
    triggerStopHook = onSignal;
    return () => { triggerStopHook = undefined; };
  };
  // The closure router is constructed after the daemon so it can read the spine.
  let daemonRef: Daemon | undefined;
  const router: ModelRouter = {
    async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
      turn++;
      if (turn === 1) {
        return {
          stop: "tool_use",
          content: [
            { type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } },
          ],
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      }
      if (turn === 2) {
        // Read the just-created coding session id and feed it to send_feedback.
        const csId = daemonRef!.spine.listCodingSessions()[0].id;
        return {
          stop: "tool_use",
          content: [
            { type: "tool_use", id: "tool_2", name: "send_feedback", input: { sessionId: csId, text: "do step 2" } },
          ],
          usage: { inputTokens: 6, outputTokens: 2 },
        };
      }
      input.onTextDelta?.("all steps done");
      return {
        stop: "completed",
        content: [{ type: "text", text: "all steps done" }],
        usage: { inputTokens: 8, outputTokens: 2 },
      };
    },
  };
  const daemon = new Daemon({
    dbPath: join(dir, "reef.db"),
    workspaceDir: join(dir, "ws"),
    codingTraceDir: join(dir, "traces"),
    codingWatchHandbackFile,
    router,
    policy: new AllowPolicy(),
    codingDriver: driver,
  });
  daemonRef = daemon;
  daemon.registerAgent({ ...agent, toolAllowlist: ["start_coding_session", "send_feedback"] });
  return { daemon, driver, workDir, getTrigger: () => triggerStopHook };
}

/** A promise that resolves on `run.suspended` for the given run id. */
function whenRunSuspends(daemon: Daemon, runId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = daemon.subscribe((e: ReefEvent) => {
      if (e.type === "run.suspended" && e.runId === runId) { off(); resolve(); }
    });
  });
}

/** A promise that resolves on `run.completed` for the given run id. */
function whenRunCompletes(daemon: Daemon, runId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = daemon.subscribe((e: ReefEvent) => {
      if (e.type === "run.completed" && e.runId === runId) { off(); resolve(); }
    });
  });
}

/** A promise that resolves when the run next terminates or suspends — used to let
 *  a cancellation-driven resume job drain before tearing the daemon down. */
function whenRunSettles(daemon: Daemon, runId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = daemon.subscribe((e: ReefEvent) => {
      if (
        (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.suspended") &&
        e.runId === runId
      ) { off(); resolve(); }
    });
  });
}

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

  it("coding_feedback: an operator revives a paused session via the daemon API", () => {
    const dir = tmp();
    const driver = new FakeDriver();
    let trigger: (() => void) | undefined;
    const d = new Daemon({
      dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router: new NullRouter(), codingDriver: driver,
      codingWatchHandbackFile: (_f, onSignal) => { trigger = onSignal; return () => { trigger = undefined; }; },
    });
    const id = d.startCodingSession({ agentKind: "claude-code", directory: dir, task: "go" });
    expect(d.spine.getCodingSession(id)!.status).toBe("running");

    // Hand back → paused (the Stop-hook signal, then the PTY exit finalizes paused).
    trigger!();
    driver.handle.die(143);
    expect(d.spine.getCodingSession(id)!.status).toBe("paused");

    // Operator feedback revives it → running again.
    d.feedbackToCodingSession(id, "now do step 2");
    expect(d.spine.getCodingSession(id)!.status).toBe("running");

    // A non-resumable session (now running, or unknown) is an error.
    expect(() => d.feedbackToCodingSession(id, "x")).toThrow(/not resumable/);
    expect(() => d.feedbackToCodingSession("cs_nope", "x")).toThrow(/not resumable/);
    d.close();
  });

  it("end-to-end: an agent starts a coding session, suspends awaiting_subwork, and resumes to completion when it finishes", async () => {
    const { daemon, driver } = setup();

    // Deliver a user message; the run starts the coding session and parks.
    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });

    // The run suspended awaiting_subwork, with a coding_sessions row tying back to it.
    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1");
    expect(run).toBeDefined();
    expect(run!.status).toBe("suspended");
    expect(run!.stopReason).toBe("awaiting_subwork");

    const cs = daemon.spine.findCodingSessionBySubwork(run!.id, "tool_1");
    expect(cs).toBeDefined();
    expect(cs!.spawningRunId).toBe(run!.id);
    expect(cs!.spawningToolUseId).toBe("tool_1");
    expect(cs!.status).toBe("running");

    // The PTY exits cleanly → coding.session.completed → daemon enqueues a resume.
    const completed = whenRunCompletes(daemon, run!.id);
    driver.handle.die(0);
    await completed;

    expect(daemon.spine.getRun(run!.id)!.status).toBe("completed");
    expect(daemon.spine.getCodingSession(cs!.id)!.status).toBe("completed");
    // the sub-agent's result re-enters the parent wrapped as untrusted content (RF-22)
    const toolMsg = daemon.spine.getMessages("s1").find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg?.content[0])).toContain('untrusted-content source=\\"coding-session\\"');
    daemon.close();
  });

  it("handback: the agent emits the marker → session parks `paused` → manager run resumes", async () => {
    const { daemon, driver, getTrigger } = setup();
    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });

    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1");
    expect(run!.stopReason).toBe("awaiting_subwork");
    const cs = daemon.spine.findCodingSessionBySubwork(run!.id, "tool_1")!;

    // The agent finishes the increment; the Stop hook touches the sentinel. The
    // manager parks the session `paused` (resumable) and tears down the PTY; the
    // daemon resumes the spawning run with the increment result.
    const completed = whenRunCompletes(daemon, run!.id);
    getTrigger()!();
    driver.handle.die(143); // the PTY exits from the deliberate handback kill
    await completed;

    expect(daemon.spine.getRun(run!.id)!.status).toBe("completed");
    // Parked, not terminally done — still revivable via --resume <externalSessionId>.
    expect(daemon.spine.getCodingSession(cs.id)!.status).toBe("paused");
    daemon.close();
  });

  it("send_feedback revives the SAME paused session (re-linked, no new row) and the run completes", async () => {
    const { daemon, driver, getTrigger } = setupFeedback();

    // Turn 1: start_coding_session → run suspends awaiting_subwork.
    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.stopReason).toBe("awaiting_subwork");
    const cs = daemon.spine.findCodingSessionBySubwork(run.id, "tool_1")!;
    expect(cs.status).toBe("running");

    // Cycle 1 handback: Stop hook + die → session parks `paused` → run resumes → turn 2
    // calls send_feedback → run suspends awaiting_subwork again (SAME session revived).
    const suspendedAgain = whenRunSuspends(daemon, run.id);
    getTrigger()!();
    driver.handle.die(143);
    await suspendedAgain;

    // The revive re-linked the SAME session to turn-2's tool_use — no new row.
    expect(daemon.spine.listCodingSessions().length).toBe(1);
    const revived = daemon.spine.getCodingSession(cs.id)!;
    expect(revived.status).toBe("running");
    expect(revived.spawningToolUseId).toBe("tool_2");
    expect(daemon.spine.findCodingSessionBySubwork(run.id, "tool_2")!.id).toBe(cs.id);

    // Cycle 2 handback: the resume re-armed the watcher, so getTrigger() now returns
    // the new onSignal. Stop hook + die → paused → run resumes → turn 3 text → completes.
    const completed = whenRunCompletes(daemon, run.id);
    getTrigger()!();
    driver.handle.die(143);
    await completed;

    expect(daemon.spine.getRun(run.id)!.status).toBe("completed");
    // Still exactly one session, parked paused, never a second row.
    expect(daemon.spine.listCodingSessions().length).toBe(1);
    expect(daemon.spine.getCodingSession(cs.id)!.status).toBe("paused");
    daemon.close();
  });

  it("sweepExpiredApprovals auto-denies an expired pending coding approval (route-mode backstop, finding #1)", () => {
    const dir = tmp();
    const driver = new FakeDriver();
    const d = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: (_f, _on) => () => {},
      router: new NullRouter(),
      codingDriver: driver,
    });
    const id = d.startCodingSession({ agentKind: "claude-code", directory: tmp(), task: "t" }); // live session
    // A proactive coding gate armed an expiry earlier; the deadline has now passed and
    // no human answered. (Simulated directly — the arming path is covered separately.)
    d.spine.createCodingApproval({
      id: "ca_1",
      codingSessionId: id,
      promptText: "Do you want to edit a.ts?",
      options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }],
      toolName: "claude-code:Write",
      input: {},
    });
    d.spine.setCodingApprovalExpiry("ca_1", new Date(Date.now() - 1000).toISOString());
    expect(d.spine.getCodingApproval("ca_1")!.status).toBe("pending");

    d.sweepExpiredApprovals(new Date());

    // auto-denied (no permanent deadlock) and the manager injected "No" into the live PTY
    expect(d.spine.getCodingApproval("ca_1")!.status).toBe("denied");
    expect(driver.handle.written).toContain("2\r");
    d.close();
  });

  it("send_feedback refuses to revive a coding session this agent did not start (finding #4 scoping)", async () => {
    const dir = tmp();
    const driver = new FakeDriver();
    let trigger: (() => void) | undefined;
    let opSessionId = "";
    let turn = 0;
    const router: ModelRouter = {
      async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
        turn++;
        if (turn === 1) {
          return { stop: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "send_feedback", input: { sessionId: opSessionId, text: "hijack the operator's repo" } }], usage: { inputTokens: 5, outputTokens: 2 } };
        }
        input.onTextDelta?.("acknowledged the refusal");
        return { stop: "completed", content: [{ type: "text", text: "acknowledged the refusal" }], usage: { inputTokens: 4, outputTokens: 1 } };
      },
    };
    const d = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: (_f, on) => { trigger = on; return () => { trigger = undefined; }; },
      router,
      policy: new AllowPolicy(),
      codingDriver: driver,
    });
    d.registerAgent({ ...agent, toolAllowlist: ["send_feedback"] });

    // An OPERATOR starts a coding session (no spawning run) and it hands back → paused.
    opSessionId = d.startCodingSession({ agentKind: "claude-code", directory: tmp(), task: "operator work" });
    trigger!();
    driver.handle.die(143);
    expect(d.spine.getCodingSession(opSessionId)!.status).toBe("paused");

    // The agent tries to revive the operator's session via send_feedback.
    await d.submit({ sessionKey: "s1", agentId: "reef", message: "go" });

    // Refused: the session is NOT revived (still paused), and the run got a graceful
    // isError tool_result instead of pushing model-controlled work into that repo.
    expect(d.spine.getCodingSession(opSessionId)!.status).toBe("paused");
    const run = d.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.status).toBe("completed");
    const toolMsg = d.spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    d.close();
  });

  it("recovers a coding session orphaned by a daemon restart: marks it process_lost and resumes the stranded run", async () => {
    const dir = tmp();
    const workDir = tmp();
    const noopWatch = (_f: string, _on: () => void) => () => {};

    // ── daemon 1 reaches awaiting_subwork with a running coding session ──
    const d1 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      router: new FakeRouter([
        { stop: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } }], usage: { inputTokens: 5, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d1.registerAgent(agent);
    await d1.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = d1.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.stopReason).toBe("awaiting_subwork");
    const cs = d1.spine.findCodingSessionBySubwork(run.id, "tool_1")!;
    expect(cs.status).toBe("running");

    // ── simulate a CRASH: drop the db connection without a clean shutdown, so the
    //    coding session stays `running` (close() would mark it process_lost) ──
    d1.spine.close();

    // ── daemon 2 on the same db has an empty live map → recover() must reconcile ──
    const d2 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      // one turn: after the lost subwork is committed as an error result, the run finishes.
      router: new FakeRouter([
        { stop: "completed", content: [{ type: "text", text: "the coding session was lost; reporting back" }], usage: { inputTokens: 4, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d2.registerAgent(agent);

    await d2.recover();

    // the orphaned session is marked process_lost (not left running forever)
    expect(d2.spine.getCodingSession(cs.id)!.status).toBe("process_lost");
    // process_lost is lifecycle-ended → ended_at is stamped (consistency with terminal states)
    expect(d2.spine.getCodingSession(cs.id)!.endedAt).toBeTruthy();
    // and the stranded awaiting_subwork run is resumed to completion (not hung)
    expect(d2.spine.getRun(run.id)!.status).toBe("completed");
    // the agent received an isError tool_result for the interrupted subwork
    const toolMsg = d2.spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    d2.close();
  });

  it("a message to a session parked awaiting_subwork is queued, not appended — and delivers after the run resumes", async () => {
    const dir = tmp();
    const workDir = tmp();
    const driver = new FakeDriver();
    const daemon = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: (_f: string, _on: () => void) => () => {},
      router: new FakeRouter([
        { stop: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } }], usage: { inputTokens: 5, outputTokens: 2 } },
        { stop: "completed", content: [{ type: "text", text: "subwork done, continuing" }], usage: { inputTokens: 8, outputTokens: 2 } },
        { stop: "completed", content: [{ type: "text", text: "answering your queued message" }], usage: { inputTokens: 4, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: driver,
    });
    daemon.registerAgent(agent);

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.stopReason).toBe("awaiting_subwork");

    // Chat with the session while it's parked. The suspended turn's last message is
    // a deliberately dangling tool_use awaiting its tool_result — appending a user
    // message there makes every later model call 400, poisoning the session forever.
    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "also, use bun please" });
    expect(daemon.listRuns({}).filter((r) => r.sessionKey === "s1")).toHaveLength(1);
    expect(JSON.stringify(daemon.spine.getMessages("s1"))).not.toContain("use bun");

    // Subwork completes → the parked run resumes and finishes → the queued message
    // is delivered as its own run afterwards.
    const queuedRunDone = new Promise<void>((resolve) => {
      const off = daemon.subscribe((e: ReefEvent) => {
        if (e.type === "run.completed" && e.sessionKey === "s1" && e.runId !== run.id) { off(); resolve(); }
      });
    });
    driver.handle.die(0);
    await queuedRunDone;

    const runs = daemon.listRuns({}).filter((r) => r.sessionKey === "s1");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    // The transcript stays provider-valid: every tool_use is answered by the
    // immediately following tool message, and the queued text lands after it.
    const messages = daemon.spine.getMessages("s1");
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === "assistant" && messages[i]!.content.some((b) => b.type === "tool_use")) {
        expect(messages[i + 1]?.role).toBe("tool");
      }
    }
    const bunIdx = messages.findIndex((m) => JSON.stringify(m.content).includes("use bun"));
    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(bunIdx).toBeGreaterThan(toolIdx);
    daemon.close();
  });

  it("a queued message survives a restart and delivers after recovery resumes the stranded run", async () => {
    const dir = tmp();
    const workDir = tmp();
    const noopWatch = (_f: string, _on: () => void) => () => {};

    // ── daemon 1: park awaiting_subwork, then a message arrives (queued) ──
    const d1 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      router: new FakeRouter([
        { stop: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } }], usage: { inputTokens: 5, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d1.registerAgent(agent);
    await d1.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    await d1.submit({ sessionKey: "s1", agentId: "reef", message: "remember to run the tests" });
    d1.close();

    // ── daemon 2: recovery resumes the stranded run, then delivers the parked message ──
    const d2 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      router: new FakeRouter([
        { stop: "completed", content: [{ type: "text", text: "the session was interrupted; reporting back" }], usage: { inputTokens: 4, outputTokens: 2 } },
        { stop: "completed", content: [{ type: "text", text: "on it — running the tests" }], usage: { inputTokens: 4, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d2.registerAgent(agent);
    await d2.recover();
    // The delivery job rides the serial inbox; a marker submit drains behind it.
    // (Its own run rejects — the router is out of turns — which is expected.)
    await d2.submit({ sessionKey: "marker", agentId: "reef", message: "drain" }).catch(() => undefined);

    const runs = d2.listRuns({}).filter((r) => r.sessionKey === "s1");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    expect(JSON.stringify(d2.spine.getMessages("s1"))).toContain("remember to run the tests");
    d2.close();
  });

  it("clean shutdown mid-subwork: the session survives as process_lost and the stranded run resumes on recovery", async () => {
    const dir = tmp();
    const workDir = tmp();
    const noopWatch = (_f: string, _on: () => void) => () => {};

    // ── daemon 1 reaches awaiting_subwork with a running coding session ──
    const d1 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      router: new FakeRouter([
        { stop: "tool_use", content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: workDir, task: "go" } }], usage: { inputTokens: 5, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d1.registerAgent(agent);
    await d1.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = d1.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.stopReason).toBe("awaiting_subwork");
    const cs = d1.spine.findCodingSessionBySubwork(run.id, "tool_1")!;
    expect(cs.status).toBe("running");

    // ── CLEAN shutdown (not a crash): close() kills the PTY. The session must be
    //    recorded process_lost (revivable via --resume), not a dead-end status the
    //    recovery pass ignores — otherwise the spawning run hangs forever. ──
    d1.close();

    // ── daemon 2 on the same db: recovery must resume the stranded run ──
    const d2 = new Daemon({
      dbPath: join(dir, "reef.db"),
      workspaceDir: join(dir, "ws"),
      codingTraceDir: join(dir, "traces"),
      codingWatchHandbackFile: noopWatch,
      router: new FakeRouter([
        { stop: "completed", content: [{ type: "text", text: "the coding session was interrupted; reporting back" }], usage: { inputTokens: 4, outputTokens: 2 } },
      ]),
      policy: new AllowPolicy(),
      codingDriver: new FakeDriver(),
    });
    d2.registerAgent(agent);
    await d2.recover();

    expect(d2.spine.getCodingSession(cs.id)!.status).toBe("process_lost");
    expect(d2.spine.getRun(run.id)!.status).toBe("completed");
    const toolMsg = d2.spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    d2.close();
  });

  it("cancelCodingSession on an agent-spawned session resumes the run with an isError result instead of re-parking it", async () => {
    const { daemon, driver } = setup();

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1")!;
    expect(run.stopReason).toBe("awaiting_subwork");
    const cs = daemon.spine.findCodingSessionBySubwork(run.id, "tool_1")!;

    // Operator cancels the SESSION directly (socket coding_cancel path) — unlike
    // daemon.cancel(sessionKey), nothing pre-finalizes the spawning run, so the
    // post-kill resume must collect a `cancelled` result rather than re-park.
    const settled = whenRunSettles(daemon, run.id);
    daemon.cancelCodingSession(cs.id);
    driver.handle.die(143); // the kill exits the PTY
    await settled;

    expect(daemon.spine.getCodingSession(cs.id)!.status).toBe("cancelled");
    const after = daemon.spine.getRun(run.id)!;
    expect(after.status).toBe("completed");
    const toolMsg = daemon.spine.getMessages("s1").find((m) => m.role === "tool");
    expect(toolMsg?.content[0]).toMatchObject({ isError: true });
    daemon.close();
  });

  it("cancel propagates to a coding session spawned by a suspended run", async () => {
    const { daemon, driver } = setup();

    await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "do the work" });
    const run = daemon.listRuns({}).find((r) => r.sessionKey === "s1");
    expect(run!.stopReason).toBe("awaiting_subwork");
    const cs = daemon.spine.findCodingSessionBySubwork(run!.id, "tool_1")!;
    expect(cs.status).toBe("running");

    // The suspended run has no live aborter; cancel must still reach the session
    // AND finalize the stranded run synchronously (it emits run.completed with
    // stopReason "cancelled", mirroring the loop's abort-finalize convention).
    const settled = whenRunSettles(daemon, run!.id);
    daemon.cancel("s1");
    expect(driver.handle.killed).toBe(true);
    await settled;

    const cancelledRun = daemon.spine.getRun(run!.id)!;
    expect(cancelledRun.status).toBe("completed");
    expect(cancelledRun.stopReason).toBe("cancelled");

    // The kill exits the PTY non-zero → manager records `cancelled` and emits
    // coding.session.completed, which enqueues a resume job for the spawning run.
    // Because the run is already terminal, resumeRun is a no-op: the run must NOT
    // re-park at awaiting_subwork. Await the resume job draining (via the same
    // serial inbox, behind a marker submit) before tearing the daemon down.
    driver.handle.die(143);
    expect(daemon.spine.getCodingSession(cs.id)!.status).toBe("cancelled");
    // The marker run errors out (router is out of turns) — we only need it to
    // drain behind the resume job; its rejection is expected and swallowed.
    await daemon
      .submit({ sessionKey: "marker", agentId: "reef", message: "drain" })
      .catch(() => undefined);

    const afterKill = daemon.spine.getRun(run!.id)!;
    expect(afterKill.status).toBe("completed");
    expect(afterKill.stopReason).toBe("cancelled");
    daemon.close();
  });
});
