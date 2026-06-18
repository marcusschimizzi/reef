// src/coding/manager.ts
//
// Wires a coding-agent driver to reef's substrate: mints ids, records the trace,
// emits coding.* events, and tracks status in coding_sessions. Step 1 routes a
// detected prompt to status `awaiting_decision` and leaves answering to the
// operator via send() (policy-driven auto-answer is a later step). Driver is
// injected so the whole thing is unit-testable without a real PTY.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import type { Spine } from "../db/spine.js";
import type { EmitFn } from "../protocol/events.js";
import { parseApprovalDecision } from "../protocol/events.js";
import { newActionId, newApprovalId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { RunSource } from "../core/types.js";
import type { ApprovalPolicy } from "../policy/policy.js";
import { CodingStreamProcessor, type DriverEvent } from "./processor.js";
import type { CodingAgentDriver, CodingDriverHandle } from "./driver.js";
import { answerFor, classifyPrompt, promptAction, type Decision } from "./prompts.js";
import {
  findClaudeTranscript,
  latestToolUse,
  parseClaudeTranscript,
  renderTranscript,
} from "./transcript.js";
import { TraceWriter } from "./trace.js";
import { HANDBACK_INSTRUCTION, stripHandback } from "./handback.js";
import { buildHandbackSettings } from "./claudeSettings.js";

export interface CodingSessionManagerDeps {
  spine: Spine;
  emit: EmitFn;
  driver: CodingAgentDriver;
  traceDir: string;
  policy: ApprovalPolicy;
  appendSystemPrompt?: string;
  /** Idle window (ms) after the last output before the session hands back. */
  idleMs?: number;
  /** Startup window (ms): if the spawned agent produces NO output within this
   *  window it's treated as a failed start (stuck auth, hung spawn) and killed —
   *  the idle timer only arms on output, so a zero-output hang needs this guard. */
  startupMs?: number;
  /** Watch a handback sentinel file for creation; returns a disposer. Injected in
   *  tests to trigger the signal deterministically. Defaults to an fs watcher. */
  watchHandbackFile?: (file: string, onSignal: () => void) => () => void;
}

export interface StartCodingSession {
  agentKind: string;
  directory: string;
  task: string;
  spawningRunId?: string | null;
  spawningToolUseId?: string | null;
  source?: RunSource;
  /** Model for the coding agent (e.g. "haiku"). Falls back to the REEF_CODING_MODEL
   *  env var, else the agent's own default. */
  model?: string;
}

interface Live {
  handle: CodingDriverHandle;
  processor: CodingStreamProcessor;
  trace: TraceWriter;
  source: RunSource;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Liveness timer armed at launch; a zero-output spawn that never arms idle is
   *  killed when this fires. Cleared on first output. */
  startupTimer?: ReturnType<typeof setTimeout>;
  /** Latch: once handed back (sentinel or idle), never act again. */
  handedBack: boolean;
  /** Disposer for the Stop-hook sentinel-file watcher; cleared on teardown. */
  disposeWatch?: () => void;
  /** Whether the session ever produced output — distinguishes a startup failure
   *  (zero output) from a mid-task error when the PTY exits non-zero. */
  sawOutput?: boolean;
}

export class CodingSessionManager {
  private readonly live = new Map<string, Live>();
  /** Sessions whose exit was requested — so the exit handler records `cancelled`
   *  rather than `failed` (a kill exits the PTY with a non-zero code). */
  private readonly cancelling = new Set<string>();
  /** Sessions killed as a deliberate handback — so `onExit` doesn't re-emit a
   *  completion or override the `paused` status set in handback(). */
  private readonly handingBack = new Set<string>();
  /** Idle-handback window (ms): a BACKSTOP for a genuinely-stuck session, not a
   *  "done" signal (the Stop hook is that, and fires on real completion). Long by
   *  default so legitimate gaps — model thinking, a slow build, a big grep — don't
   *  prematurely kill an active session. Bad env → NaN → falsy → default. */
  private readonly idleMs: number;
  private readonly startupMs: number;
  constructor(private readonly deps: CodingSessionManagerDeps) {
    this.idleMs = deps.idleMs ?? (Number(process.env.REEF_CODING_IDLE_MS) || 300_000);
    this.startupMs = deps.startupMs ?? (Number(process.env.REEF_CODING_STARTUP_MS) || 60_000);
  }

  start(opts: StartCodingSession): string {
    const externalSessionId = randomUUID();
    const id = `cs_${externalSessionId}`;
    const tracePath = join(this.deps.traceDir, `${id}.jsonl`);
    const model = opts.model ?? process.env.REEF_CODING_MODEL;
    // Expand `~` and resolve to an absolute path: node-pty's cwd is NOT shell-
    // expanded, so a literal "~/x" or a relative path makes the spawn fail at
    // startup (exit 1, zero output). Agents routinely pass "~/...".
    const directory = resolveCodingDirectory(opts.directory);

    this.deps.spine.createCodingSession({
      id,
      spawningRunId: opts.spawningRunId ?? null,
      spawningToolUseId: opts.spawningToolUseId ?? null,
      agentKind: opts.agentKind,
      externalSessionId,
      directory,
      status: "running",
      task: opts.task,
      model,
      tracePath,
    });

    this.launch({
      id,
      externalSessionId,
      directory,
      task: opts.task,
      model,
      source: opts.source ?? { kind: "message" },
      resume: false,
      tracePath,
    });

    // Emitted only for a fresh start (resume revives an already-started session).
    this.emitCoding(id, { type: "coding.session.started", codingSessionId: id, agentKind: opts.agentKind, directory: opts.directory });

    return id;
  }

  /** Revive a paused coding session with a follow-up increment (claude --resume).
   *  Re-links the session to the reviving run+tool so the new result routes back.
   *  Throws if the session isn't a resumable `paused` one (→ a graceful error
   *  tool_result via the loop's subwork-failure path). */
  resume(sessionId: string, text: string, opts: { spawningRunId?: string | null; spawningToolUseId?: string | null; source?: RunSource } = {}): void {
    const cs = this.deps.spine.getCodingSession(sessionId);
    // `paused` = handed back; `process_lost` = interrupted by a crash. Both are
    // revivable via `claude --resume <uuid>` (the session JSONL survives on disk).
    if (!cs || (cs.status !== "paused" && cs.status !== "process_lost")) {
      throw new Error(`coding session ${sessionId} is not resumable (status: ${cs?.status ?? "not found"})`);
    }
    this.deps.spine.relinkCodingSessionSubwork(sessionId, opts.spawningRunId ?? null, opts.spawningToolUseId ?? null);
    this.deps.spine.setCodingSessionStatus(sessionId, "running");
    this.launch({
      id: cs.id,
      externalSessionId: cs.externalSessionId,
      directory: cs.directory,
      task: text,
      model: cs.model,
      // Govern the revived increment under the REVIVING run's source: a proactive
      // (trigger/heartbeat) send_feedback must run under proactive policy so an inner
      // prompt auto-denies instead of gating with no human to answer.
      source: opts.source ?? { kind: "message" },
      resume: true,
      tracePath: cs.tracePath,
    });
  }

  /** Wire up the live session: trace, processor, driver handle, Stop-hook watcher,
   *  and the data/exit handlers. Shared by start() (new) and resume() (revive).
   *  The TraceWriter appends, so a revive continues the prior increment's trace. */
  private launch(opts: {
    id: string;
    externalSessionId: string;
    directory: string;
    task: string;
    model?: string;
    source: RunSource;
    resume: boolean;
    tracePath: string;
  }): void {
    const { id } = opts;
    const trace = new TraceWriter(opts.tracePath);
    trace.write({ type: "lifecycle", event: opts.resume ? "resume" : "spawn" });
    const processor = new CodingStreamProcessor();

    // Reef-owned settings + sentinel files live under traceDir (never the user's
    // repo or ~/.claude). The settings carry a Stop hook that touches the sentinel
    // when the agent finishes a turn; reef watches it → deterministic handback.
    // Re-passed on resume so the hook + sentinel work on the revived turn too.
    const handbackFile = join(this.deps.traceDir, `${id}.handback`);
    const settingsFile = join(this.deps.traceDir, `${id}.settings.json`);
    mkdirSync(this.deps.traceDir, { recursive: true });
    // Clear any sentinel left by a prior increment so this turn's handback is a
    // clean file-creation (a revive reuses the same handbackFile path).
    rmSync(handbackFile, { force: true });
    writeFileSync(settingsFile, JSON.stringify(buildHandbackSettings(handbackFile)));

    const handle = this.deps.driver.start({
      directory: opts.directory,
      sessionId: opts.externalSessionId,
      task: opts.task,
      resume: opts.resume,
      appendSystemPrompt: [HANDBACK_INSTRUCTION, this.deps.appendSystemPrompt].filter(Boolean).join("\n\n"),
      model: opts.model,
      settingsPath: settingsFile,
    });
    this.live.set(id, { handle, processor, trace, source: opts.source, handedBack: false });

    // Arm the Stop-hook watcher: the sentinel appearing → handback("stop-hook").
    const watch = this.deps.watchHandbackFile ?? defaultWatchHandbackFile;
    const dispose = watch(handbackFile, () => this.handback(id, "stop-hook"));
    const l0 = this.live.get(id);
    if (l0) {
      l0.disposeWatch = dispose;
      // Arm the startup liveness timer: a spawn that produces NO output (the idle
      // timer arms only on output) — e.g. a stuck auth prompt or hung binary —
      // would otherwise leave the session running and its spawning run parked
      // forever. First output disarms it.
      l0.startupTimer = setTimeout(() => this.onStartupTimeout(id), this.startupMs);
    }

    handle.onData((chunk) => {
      trace.write({ type: "pty.raw", bytes: Buffer.from(chunk, "utf8").toString("base64") });
      for (const ev of processor.push(chunk)) this.onDriverEvent(id, ev);
    });
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
      if (this.handingBack.delete(id)) {
        // Deliberate handback: the PTY has now exited and the transcript is flushed,
        // so capture the increment result here and park the session `paused`
        // (resumable). The non-zero exit code from the kill is expected — ignore it.
        this.disarmIdle(id);
        this.clearWatch(id);
        const result = this.readResult(id);
        this.deps.spine.setCodingSessionStatus(id, "paused", result);
        trace.close();
        // Tear this increment's live entry down BEFORE emitting — `emit` is
        // synchronous, and a listener may revive the session (send_feedback) inline,
        // which calls live.set(); deleting after the emit would clobber that entry.
        this.live.delete(id);
        this.emitCoding(id, { type: "coding.session.paused", codingSessionId: id, result });
        return;
      }
      this.disarmIdle(id);
      this.clearWatch(id);
      // A requested cancel exits non-zero (the kill) — record it as cancelled,
      // not failed. `delete` both checks membership and consumes the flag.
      const cancelled = this.cancelling.delete(id);
      const status = cancelled ? "cancelled" : code === 0 || code === null ? "completed" : "failed";
      if (status === "failed") {
        // A failed session usually has no transcript to summarize — give the manager
        // a diagnostic so it (and the user) can tell a startup failure (zero output)
        // from a mid-task error, instead of an opaque "session failed".
        const sawOutput = this.live.get(id)?.sawOutput ?? false;
        const error =
          this.readResult(id) ??
          (sawOutput
            ? `The coding agent exited with code ${code} mid-task (it produced output but no final result).`
            : `The coding agent exited with code ${code} and produced no output — it likely failed to start (check the directory, the agent's authentication, or the plan/usage limit).`);
        this.deps.spine.setCodingSessionStatus(id, "failed", error);
        this.emitCoding(id, { type: "coding.session.failed", codingSessionId: id, error });
      } else {
        const result = this.readResult(id);
        this.deps.spine.setCodingSessionStatus(id, status, result);
        this.emitCoding(id, { type: "coding.session.completed", codingSessionId: id, result });
      }
      trace.close();
      this.live.delete(id);
    });
  }

  /** Inject raw keystrokes (operator answering a prompt by hand in Step 1). */
  send(id: string, data: string): void {
    const l = this.live.get(id);
    if (!l) return;
    l.trace.write({ type: "inject", data, reason: "operator" });
    l.handle.write(data);
  }

  cancel(id: string): void {
    if (!this.live.has(id)) return;
    this.disarmIdle(id);
    this.clearWatch(id);
    this.cancelling.add(id);
    this.live.get(id)!.handle.kill();
  }

  /** Shut down: kill every live session, mark it cancelled, and close its trace.
   *  Called on daemon shutdown so no PTY or trace fd is leaked. Idempotent trace
   *  close means the async exit handler firing afterward is harmless. */
  close(): void {
    for (const [id, l] of this.live) {
      this.disarmIdle(id);
      this.clearWatch(id);
      this.cancelling.add(id);
      this.deps.spine.setCodingSessionStatus(id, "cancelled");
      l.handle.kill();
      l.trace.close();
    }
    this.live.clear();
  }

  private onDriverEvent(id: string, ev: DriverEvent): void {
    const l = this.live.get(id);
    l?.trace.write({ type: "event", event: ev });
    if (ev.type === "output") {
      // First output → the spawn is alive; disarm the startup liveness timer.
      if (l?.startupTimer) { clearTimeout(l.startupTimer); l.startupTimer = undefined; }
      if (l) l.sawOutput = true;
      this.emitCoding(id, { type: "coding.output", codingSessionId: id, text: ev.text });
      // Handback is detected by the Stop hook (post-turn-completion) + idle, both of
      // which fire AFTER Claude Code flushes the turn to its transcript. We do NOT
      // detect the rendered marker here: it appears pre-flush, so killing on it would
      // race the transcript write and capture a stale/empty result.
      this.armIdle(id);
    } else if (ev.type === "prompt-pending") {
      this.handlePrompt(id, ev);
    }
  }

  /** (Re)arm the idle-handback timer for a running session. */
  private armIdle(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.idleTimer) clearTimeout(l.idleTimer);
    l.idleTimer = setTimeout(() => this.handback(id, "idle"), this.idleMs);
  }
  private disarmIdle(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    if (l.idleTimer) { clearTimeout(l.idleTimer); l.idleTimer = undefined; }
    if (l.startupTimer) { clearTimeout(l.startupTimer); l.startupTimer = undefined; }
  }

  /** Startup liveness timer fired: the agent produced no output in the window, so
   *  the spawn is stuck (hung auth / bad binary). Kill it WITHOUT a handback/cancel
   *  flag → onExit's failed branch records the zero-output "likely failed to start"
   *  diagnostic and resumes the spawning run, instead of hanging awaiting_subwork. */
  private onStartupTimeout(id: string): void {
    const l = this.live.get(id);
    // disarmIdle (called on every teardown path) already clears this timer before
    // cancelling/handingBack are set, so this is belt-and-suspenders: never kill a
    // session that's already producing output, handed back, cancelling, or torn down.
    if (!l || l.sawOutput || l.handedBack || this.cancelling.has(id) || this.handingBack.has(id)) return;
    l.startupTimer = undefined;
    l.trace.write({ type: "lifecycle", event: "startup-timeout" });
    l.handle.kill();
  }

  /** Dispose the Stop-hook sentinel watcher so no fs.watch leaks and a late Stop
   *  touch can't re-enter handback after teardown. */
  private clearWatch(id: string): void {
    const l = this.live.get(id);
    if (l?.disposeWatch) { l.disposeWatch(); l.disposeWatch = undefined; }
  }

  /** The agent finished this increment (sentinel) or went quiet (idle): capture the
   *  result, park the session `paused` (resumable via --resume), resume the manager
   *  run, and tear down the PTY as a deliberate handback (not a crash/cancel). */
  private handback(id: string, reason: "idle" | "stop-hook"): void {
    const l = this.live.get(id);
    if (!l || l.handedBack) return;       // latch — once per session
    l.handedBack = true;
    this.disarmIdle(id);
    this.clearWatch(id);                  // a late Stop touch can't re-enter
    l.trace.write({ type: "lifecycle", event: "handback", reason });
    // Tear down the PTY; the result is captured + `paused` emitted in onExit, once
    // the process has exited and Claude Code has flushed the final assistant message
    // to its transcript (a fast sentinel/stop-hook fires a beat before that flush).
    this.handingBack.add(id);
    l.handle.kill();
  }

  /** A detected prompt → policy decision → inject (allow/deny) or gate (Task 4). */
  private handlePrompt(id: string, ev: { promptText: string; options: { index: number; label: string }[] }): void {
    const l = this.live.get(id);
    if (!l) return;
    const ctx = this.promptContext(id, ev.promptText, l.source);

    // A gated prompt is idle but NOT done — don't let the human deciding trip idle.
    this.disarmIdle(id);
    this.deps.spine.setCodingSessionStatus(id, "awaiting_decision");
    this.emitCoding(id, {
      type: "coding.prompt.detected",
      codingSessionId: id,
      promptText: ev.promptText,
      options: ev.options,
    });

    const decision = this.deps.policy.decide(ctx);
    if (decision.action === "gate") {
      this.gate(id, ev, ctx);
      return;
    }
    const dec: Decision = decision.action === "deny" ? "deny" : "allow-once";
    const cs = this.deps.spine.getCodingSession(id);
    this.injectAnswer(id, ev.options, dec, ctx, decision.action === "deny" ? "deny" : "allow", cs?.spawningRunId);
  }

  /** Build the policy context, preferring the transcript's reliable tool-use over
   *  the scraped prompt text. */
  private promptContext(id: string, promptText: string, source: RunSource) {
    const cs = this.deps.spine.getCodingSession(id)!;
    const path = findClaudeTranscript(cs.externalSessionId, { cwd: cs.directory });
    const tool = path ? latestToolUse(parseClaudeTranscript(path)) : undefined;
    const action = promptAction(promptText);
    return {
      agentId: cs.agentKind,
      toolName: `claude-code:${tool?.name ?? classifyPrompt(promptText)}`,
      needsApproval: true,
      input: tool?.input ?? action ?? promptText,
      source,
      sessionKey: `coding:${id}`,
    };
  }

  /** Map a decision to an option digit and inject it; audit; back to running. */
  private injectAnswer(
    id: string,
    options: { index: number; label: string }[],
    dec: Decision,
    ctx: { toolName: string; input: unknown; sessionKey: string },
    policyAction: "allow" | "deny",
    spawningRunId?: string | null,
  ): void {
    const l = this.live.get(id);
    if (!l) return;
    const n = answerFor(options, dec);
    if (n === undefined) {
      // No mappable option — leave the prompt for the operator's manual send().
      l.trace.write({ type: "inject", data: "", reason: `policy:${policyAction}:unmapped` });
      return;
    }
    l.trace.write({ type: "inject", data: `${n}\r`, reason: `policy:${policyAction}` });
    l.handle.write(`${n}\r`);
    this.recordAction(id, ctx, policyAction, policyAction === "deny" ? "denied" : "ok", spawningRunId);
    this.deps.spine.setCodingSessionStatus(id, "running");
    this.armIdle(id);
  }

  /** One audit row per coding-session decision (reuses the actions log). */
  private recordAction(
    id: string,
    ctx: { toolName: string; input: unknown },
    decision: "allow" | "deny",
    outcome: "ok" | "denied",
    spawningRunId?: string | null,
  ): void {
    this.deps.spine.recordAction({
      id: newActionId(),
      runId: spawningRunId ?? id,
      sessionKey: `coding:${id}`,
      agentId: "claude-code",
      toolName: ctx.toolName,
      input: ctx.input,
      decision,
      outcome,
      createdAt: nowIso(),
    });
  }

  /** Policy gated this prompt: record it durably, surface it, and wait for a human
   *  resolve (which injects via resolveCodingApproval). */
  private gate(
    id: string,
    ev: { promptText: string; options: { index: number; label: string }[] },
    ctx: { toolName: string; input: unknown },
  ): void {
    const approvalId = newApprovalId();
    this.deps.spine.createCodingApproval({
      id: approvalId,
      codingSessionId: id,
      promptText: ev.promptText,
      options: ev.options,
      toolName: ctx.toolName,
      input: ctx.input,
    });
    this.deps.emit({
      type: "approval.requested",
      approvalId,
      action: ctx.toolName,
      detail: ctx.input,
      sessionKey: `coding:${id}`,
      runId: "",
    } as Parameters<EmitFn>[0]);
  }

  /** Resolve a gated coding prompt: inject the mapped digit, audit, resume. Called
   *  by the daemon's resolveApproval fork (Task 10) — and directly in tests. The
   *  daemon also flips the row first; the pending guard makes the double-write a
   *  harmless no-op. */
  resolveCodingApproval(approvalId: string, rawDecision: string): void {
    const appr = this.deps.spine.getCodingApproval(approvalId);
    if (!appr || appr.status !== "pending") return;
    // Whitelist the decision (defense-in-depth: the daemon already normalizes, but a
    // direct caller must not be able to turn garbage into an injected "Yes"). Anything
    // outside the canonical vocabulary → deny.
    const decision: Decision = parseApprovalDecision(rawDecision);
    this.deps.spine.resolveCodingApproval(approvalId, decision === "deny" ? "denied" : "allowed", decision);
    const id = appr.codingSessionId;
    const cs = this.deps.spine.getCodingSession(id);
    this.injectAnswer(
      id,
      appr.options,
      decision,
      { toolName: appr.toolName, input: appr.input, sessionKey: `coding:${id}` },
      decision === "deny" ? "deny" : "allow",
      cs?.spawningRunId,
    );
  }

  /** The session's final assistant message, from Claude Code's own transcript —
   *  the reliable "result" summary. undefined when the transcript is absent. */
  private readResult(id: string): string | undefined {
    const cs = this.deps.spine.getCodingSession(id);
    if (!cs) return undefined;
    const path = findClaudeTranscript(cs.externalSessionId, { cwd: cs.directory });
    if (!path) return undefined;
    const entries = parseClaudeTranscript(path);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.role === "assistant" && entries[i]!.text) {
        const t = stripHandback(entries[i]!.text!);
        if (t) return t; // skip a message that was only the marker
      }
    }
    return stripHandback(renderTranscript(entries)) || undefined;
  }

  private emitCoding(id: string, body: { type: string } & Record<string, unknown>): void {
    this.deps.emit({ ...body, sessionKey: `coding:${id}`, runId: "" } as Parameters<EmitFn>[0]);
  }
}

/** Expand a leading `~`/`~/` to the home dir and resolve to an absolute path.
 *  node-pty's cwd is not shell-expanded, so a literal "~/x" (which agents pass
 *  routinely) or a relative path makes the spawn fail at startup. */
function resolveCodingDirectory(dir: string): string {
  const expanded = dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
  return resolve(expanded);
}

/** Default handback-file watcher: POLL the sentinel's stat (fs.watchFile). Polling
 *  is reliable across platforms — fs.watch/FSEvents miss file-creation events on
 *  macOS, which is why the deterministic Stop-hook path never fired live. The Stop
 *  hook `touch`ing the file flips it into existence; the poll catches it within the
 *  interval. The idle timer remains the ultimate fallback. */
function defaultWatchHandbackFile(file: string, onSignal: () => void): () => void {
  let fired = false;
  watchFile(file, { interval: 200 }, () => {
    if (fired || !existsSync(file)) return;
    fired = true;
    onSignal();
  });
  return () => { try { unwatchFile(file); } catch { /* not watched */ } };
}
