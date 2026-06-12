// src/coding/manager.ts
//
// Wires a coding-agent driver to reef's substrate: mints ids, records the trace,
// emits coding.* events, and tracks status in coding_sessions. Step 1 routes a
// detected prompt to status `awaiting_decision` and leaves answering to the
// operator via send() (policy-driven auto-answer is a later step). Driver is
// injected so the whole thing is unit-testable without a real PTY.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
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

export interface CodingSessionManagerDeps {
  spine: Spine;
  emit: EmitFn;
  driver: CodingAgentDriver;
  traceDir: string;
  policy: ApprovalPolicy;
  appendSystemPrompt?: string;
}

export interface StartCodingSession {
  agentKind: string;
  directory: string;
  task: string;
  spawningRunId?: string | null;
  spawningToolUseId?: string | null;
  source?: RunSource;
}

interface Live {
  handle: CodingDriverHandle;
  processor: CodingStreamProcessor;
  trace: TraceWriter;
  source: RunSource;
}

export class CodingSessionManager {
  private readonly live = new Map<string, Live>();
  /** Sessions whose exit was requested — so the exit handler records `cancelled`
   *  rather than `failed` (a kill exits the PTY with a non-zero code). */
  private readonly cancelling = new Set<string>();
  constructor(private readonly deps: CodingSessionManagerDeps) {}

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
    const handle = this.deps.driver.start({
      directory: opts.directory,
      sessionId: externalSessionId,
      task: opts.task,
      appendSystemPrompt: this.deps.appendSystemPrompt,
    });
    this.live.set(id, { handle, processor, trace, source: opts.source ?? { kind: "message" } });

    this.emitCoding(id, { type: "coding.session.started", codingSessionId: id, agentKind: opts.agentKind, directory: opts.directory });

    handle.onData((chunk) => {
      trace.write({ type: "pty.raw", bytes: Buffer.from(chunk, "utf8").toString("base64") });
      for (const ev of processor.push(chunk)) this.onDriverEvent(id, ev);
    });
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
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
    this.cancelling.add(id);
    this.live.get(id)!.handle.kill();
  }

  /** Shut down: kill every live session, mark it cancelled, and close its trace.
   *  Called on daemon shutdown so no PTY or trace fd is leaked. Idempotent trace
   *  close means the async exit handler firing afterward is harmless. */
  close(): void {
    for (const [id, l] of this.live) {
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
    } else if (ev.type === "prompt-pending") {
      this.handlePrompt(id, ev);
    }
  }

  /** A detected prompt → policy decision → inject (allow/deny) or gate (Task 4). */
  private handlePrompt(id: string, ev: { promptText: string; options: { index: number; label: string }[] }): void {
    const l = this.live.get(id);
    if (!l) return;
    const ctx = this.promptContext(id, ev.promptText, l.source);

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
