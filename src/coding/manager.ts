// src/coding/manager.ts
//
// Wires a coding-agent driver to reef's substrate: mints ids, records the trace,
// emits coding.* events, and tracks status in coding_sessions. Step 1 routes a
// detected prompt to status `awaiting_decision` and leaves answering to the
// operator via send() (policy-driven auto-answer is a later step). Driver is
// injected so the whole thing is unit-testable without a real PTY.

import { randomUUID } from "node:crypto";
import { join, basename, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, watch as fsWatch } from "node:fs";
import type { Spine } from "../db/spine.js";
import type { EmitFn } from "../protocol/events.js";
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
import { HANDBACK_INSTRUCTION, containsHandback } from "./handback.js";
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
  /** Latch: once handed back (sentinel or idle), never act again. */
  handedBack: boolean;
  /** Disposer for the Stop-hook sentinel-file watcher; cleared on teardown. */
  disposeWatch?: () => void;
}

export class CodingSessionManager {
  private readonly live = new Map<string, Live>();
  /** Sessions whose exit was requested — so the exit handler records `cancelled`
   *  rather than `failed` (a kill exits the PTY with a non-zero code). */
  private readonly cancelling = new Set<string>();
  /** Sessions killed as a deliberate handback — so `onExit` doesn't re-emit a
   *  completion or override the `paused` status set in handback(). */
  private readonly handingBack = new Set<string>();
  /** Idle-handback window (ms). Bad env → NaN → falsy → 8000. */
  private readonly idleMs: number;
  constructor(private readonly deps: CodingSessionManagerDeps) {
    this.idleMs = deps.idleMs ?? (Number(process.env.REEF_CODING_IDLE_MS) || 8000);
  }

  start(opts: StartCodingSession): string {
    const externalSessionId = randomUUID();
    const id = `cs_${externalSessionId}`;
    const tracePath = join(this.deps.traceDir, `${id}.jsonl`);

    this.deps.spine.createCodingSession({
      id,
      spawningRunId: opts.spawningRunId ?? null,
      spawningToolUseId: opts.spawningToolUseId ?? null,
      agentKind: opts.agentKind,
      externalSessionId,
      directory: opts.directory,
      status: "running",
      task: opts.task,
      tracePath,
    });

    const trace = new TraceWriter(tracePath);
    trace.write({ type: "lifecycle", event: "spawn" });
    const processor = new CodingStreamProcessor();

    // Reef-owned settings + sentinel files live under traceDir (never the user's
    // repo or ~/.claude). The settings carry a Stop hook that touches the sentinel
    // when the agent finishes a turn; reef watches it → deterministic handback.
    const handbackFile = join(this.deps.traceDir, `${id}.handback`);
    const settingsFile = join(this.deps.traceDir, `${id}.settings.json`);
    mkdirSync(this.deps.traceDir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(buildHandbackSettings(handbackFile)));

    const handle = this.deps.driver.start({
      directory: opts.directory,
      sessionId: externalSessionId,
      task: opts.task,
      appendSystemPrompt: [HANDBACK_INSTRUCTION, this.deps.appendSystemPrompt].filter(Boolean).join("\n\n"),
      model: opts.model ?? process.env.REEF_CODING_MODEL,
      settingsPath: settingsFile,
    });
    this.live.set(id, { handle, processor, trace, source: opts.source ?? { kind: "message" }, handedBack: false });

    // Arm the Stop-hook watcher: the sentinel appearing → handback("stop-hook").
    const watch = this.deps.watchHandbackFile ?? defaultWatchHandbackFile;
    const dispose = watch(handbackFile, () => this.handback(id, "stop-hook"));
    const l0 = this.live.get(id);
    if (l0) l0.disposeWatch = dispose;

    this.emitCoding(id, { type: "coding.session.started", codingSessionId: id, agentKind: opts.agentKind, directory: opts.directory });

    handle.onData((chunk) => {
      trace.write({ type: "pty.raw", bytes: Buffer.from(chunk, "utf8").toString("base64") });
      for (const ev of processor.push(chunk)) this.onDriverEvent(id, ev);
    });
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
      if (this.handingBack.delete(id)) {
        // Deliberate handback teardown — status/event already set in handback().
        this.disarmIdle(id);
        this.clearWatch(id);
        trace.close();
        this.live.delete(id);
        return;
      }
      this.disarmIdle(id);
      this.clearWatch(id);
      // A requested cancel exits non-zero (the kill) — record it as cancelled,
      // not failed. `delete` both checks membership and consumes the flag.
      const cancelled = this.cancelling.delete(id);
      const status = cancelled ? "cancelled" : code === 0 || code === null ? "completed" : "failed";
      const result = this.readResult(id);
      this.deps.spine.setCodingSessionStatus(id, status, result);
      if (status === "failed") {
        this.emitCoding(id, { type: "coding.session.failed", codingSessionId: id, error: `exited with code ${code}` });
      } else {
        this.emitCoding(id, { type: "coding.session.completed", codingSessionId: id, result });
      }
      trace.close();
      this.live.delete(id);
    });

    return id;
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
      this.emitCoding(id, { type: "coding.output", codingSessionId: id, text: ev.text });
      if (containsHandback(ev.text)) { this.handback(id, "sentinel"); return; }
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
    if (l?.idleTimer) { clearTimeout(l.idleTimer); l.idleTimer = undefined; }
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
  private handback(id: string, reason: "sentinel" | "idle" | "stop-hook"): void {
    const l = this.live.get(id);
    if (!l || l.handedBack) return;       // latch — once per session
    l.handedBack = true;
    this.disarmIdle(id);
    this.clearWatch(id);                  // a late Stop touch can't re-enter
    l.trace.write({ type: "lifecycle", event: "handback", reason });
    const result = this.readResult(id);
    this.deps.spine.setCodingSessionStatus(id, "paused", result);
    this.emitCoding(id, { type: "coding.session.paused", codingSessionId: id, result });
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
  resolveCodingApproval(approvalId: string, decision: string): void {
    const appr = this.deps.spine.getCodingApproval(approvalId);
    if (!appr || appr.status !== "pending") return;
    this.deps.spine.resolveCodingApproval(approvalId, decision === "deny" ? "denied" : "allowed", decision);
    const id = appr.codingSessionId;
    const cs = this.deps.spine.getCodingSession(id);
    const dec: Decision =
      decision === "deny" ? "deny" : decision === "allow-always" ? "allow-always" : "allow-once";
    this.injectAnswer(
      id,
      appr.options,
      dec,
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
      if (entries[i]!.text && entries[i]!.role === "assistant") return entries[i]!.text;
    }
    return renderTranscript(entries) || undefined;
  }

  private emitCoding(id: string, body: { type: string } & Record<string, unknown>): void {
    this.deps.emit({ ...body, sessionKey: `coding:${id}`, runId: "" } as Parameters<EmitFn>[0]);
  }
}

/** Default handback-file watcher: fs.watch the containing dir for the file
 *  appearing. Best-effort — the idle timer is the ultimate fallback. */
function defaultWatchHandbackFile(file: string, onSignal: () => void): () => void {
  const dir = dirname(file);
  const base = basename(file);
  let fired = false;
  let watcher: ReturnType<typeof fsWatch> | undefined;
  try {
    watcher = fsWatch(dir, (_event, fname) => {
      if (fired) return;
      if ((fname === base || fname === null) && existsSync(file)) { fired = true; onSignal(); }
    });
  } catch {
    // dir not watchable — rely on idle fallback.
  }
  return () => { try { watcher?.close(); } catch { /* already closed */ } };
}
