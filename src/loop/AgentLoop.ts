import { newActionId, newApprovalId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type {
  AgentRecord,
  ContentBlock,
  Run,
  RunSource,
  RunStatus,
  StopReason,
} from "../core/types.js";
import type { Spine } from "../db/spine.js";
import type { ModelRouter } from "../model/router.js";
import { DefaultPolicy, type ApprovalPolicy, type PolicyDecision } from "../policy/policy.js";
import type { EmitFn, ReefEventBody, ReefEventInit } from "../protocol/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { maybeCompact, type CompactionPolicy } from "./compaction.js";

export interface LoopDeps {
  spine: Spine;
  router: ModelRouter;
  tools: ToolRegistry;
  toolContext: ToolContext;
  /** The daemon's sink stamps each event with seq + ts, persists, broadcasts. */
  emit: EmitFn;
  /** Per-run iteration ceiling — the non-convergence backstop (reef-docs/03). */
  maxSteps?: number;
  /** Context-compaction policy (Phase 3c); omit for the competent default. */
  compaction?: CompactionPolicy;
  /** Approval policy governing tool calls; omit for the behavior-preserving default. */
  policy?: ApprovalPolicy;
}

export interface LoopOptions {
  /** Resume a run that was suspended awaiting approval: the model turn already
   *  exists on the pending step; execute its (now-decided) tools and continue. */
  resumeApproval?: boolean;
  /** Why this run started — carried on run.started so consumers can tell a
   *  proactive (trigger) run from a reply. Defaults to interactive. */
  source?: RunSource;
}

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

/**
 * The one parameterized agent loop (reef-docs/03). Assemble context → model turn
 * → run tools → repeat, to a typed termination, one durable step per iteration.
 *
 * Gated tools (needsApproval) suspend the run: the loop emits approval.requested,
 * persists the pending approval + the model turn, and returns `awaiting_approval`
 * with the step left pending. A later resolve re-drives the run in resumeApproval
 * mode, which executes the decided tools and continues — suspension is just a
 * stop-reason plus the ordinary durable-record path, not a paused process.
 */
export async function runAgentLoop(
  run: Run,
  agent: AgentRecord,
  deps: LoopDeps,
  options: LoopOptions = {},
): Promise<StopReason> {
  const { spine, router, tools, toolContext } = deps;
  const maxSteps = deps.maxSteps ?? 20;
  const policy = deps.policy ?? new DefaultPolicy();
  // How this run started feeds the policy: an interactive run can suspend for a
  // human, a proactive (trigger) run has no approver so the default policy denies
  // a gated tool rather than deadlocking. See reef-proactive-approval.
  const source: RunSource = options.source ?? { kind: "message" };
  const decide = (call: ToolUse): PolicyDecision =>
    policy.decide({
      agentId: agent.id,
      toolName: call.name,
      needsApproval: tools.get(call.name)?.needsApproval ?? false,
      input: call.input,
      source,
      sessionKey: run.sessionKey,
    });

  const emit = (body: ReefEventBody): void =>
    deps.emit({ ...body, sessionKey: run.sessionKey, runId: run.id } as ReefEventInit);

  emit(
    options.resumeApproval
      ? { type: "run.resumed" }
      : { type: "run.started", agentId: agent.id, model: agent.model, source: options.source },
  );

  const modelTools = tools.modelTools(agent.toolAllowlist);
  let index = spine.getSteps(run.id).filter((s) => s.state === "committed").length;
  let stopReason: StopReason = "completed";

  try {
    // Resume preamble: finish the suspended turn whose tools were just decided.
    if (options.resumeApproval) {
      if (spine.pendingApprovalCount(run.id) > 0) return "awaiting_approval";
      if (await finishSuspendedTurn(run, deps, emit, index, source, policy)) index++;
    }

    while (true) {
      if (toolContext.signal?.aborted) {
        stopReason = "cancelled";
        break;
      }
      if (index >= maxSteps) {
        stopReason = "max_steps";
        break;
      }

      // Between steps: fold older history into a durable summary if the last
      // turn's context crossed the threshold. A no-op (no model call) otherwise.
      await maybeCompact({
        spine,
        router,
        run,
        agent,
        emit,
        policy: deps.compaction,
        signal: toolContext.signal,
      });

      emit({ type: "step.started", index });
      spine.beginStep(run.id, index);

      const messages = spine.getContext(run.sessionKey);
      const turn = await router.generateTurn({
        model: agent.model,
        system: agent.systemPrompt,
        messages,
        tools: modelTools,
        signal: toolContext.signal,
        onTextDelta: (text) => emit({ type: "message.delta", text }),
        onThinkingDelta: (text) => emit({ type: "thinking.delta", text }),
      });

      spine.appendMessage(run.sessionKey, "assistant", turn.content, run.id);
      emit({ type: "message.completed", content: turn.content });

      const toolUses = turn.content.filter(
        (b): b is ToolUse => b.type === "tool_use",
      );

      // Suspend the whole turn if the policy gates any tool in it. (A policy that
      // denies — e.g. for a proactive run — yields no gated calls here; those are
      // refused in executeTools and the run continues rather than deadlocking.)
      const gated = toolUses.filter((c) => decide(c).action === "gate");
      if (gated.length > 0) {
        spine.updateStepOutput(run.id, index, {
          response: turn.content,
          usage: turn.usage,
        });
        for (const call of gated) {
          const approvalId = newApprovalId();
          spine.createApproval({
            id: approvalId,
            runId: run.id,
            sessionKey: run.sessionKey,
            toolUseId: call.id,
            toolName: call.name,
            input: call.input,
          });
          emit({
            type: "approval.requested",
            approvalId,
            action: describeAction(call),
            detail: call.input,
          });
        }
        spine.setRunStatus(run.id, "suspended", { stopReason: "awaiting_approval" });
        emit({ type: "run.suspended", stopReason: "awaiting_approval" });
        return "awaiting_approval";
      }

      let toolResults: ContentBlock[] | undefined;
      if (turn.stop === "tool_use" && toolUses.length > 0) {
        toolResults = await executeTools(toolUses, run, deps, emit, source, policy);
        spine.appendMessage(run.sessionKey, "tool", toolResults, run.id);
      }

      spine.commitStep(run.id, index, {
        response: turn.content,
        toolResults,
        usage: turn.usage,
      });
      emit({ type: "step.committed", index, usage: turn.usage });
      index++;

      if (turn.stop !== "tool_use") {
        stopReason = "completed";
        break;
      }
    }
  } catch (err) {
    if (toolContext.signal?.aborted) {
      stopReason = "cancelled";
    } else {
      const message = err instanceof Error ? err.message : String(err);
      finalize(spine, run, "failed", "error");
      emit({ type: "run.failed", error: message });
      return "error";
    }
  }

  finalize(spine, run, "completed", stopReason);
  emit({ type: "run.completed", stopReason });
  return stopReason;
}

/**
 * Execute a turn's tool calls under the approval policy, recording each to the
 * audit log. A `gate` call honors its durable human approval (allowed → run,
 * denied/undecided → denial); a `deny` call (e.g. a proactive run) is refused
 * with a model-readable reason; `allow` runs. An errored tool is an input to the
 * loop, not a run failure.
 */
async function executeTools(
  toolUses: ToolUse[],
  run: Run,
  deps: LoopDeps,
  emit: (body: ReefEventBody) => void,
  source: RunSource,
  policy: ApprovalPolicy,
): Promise<ContentBlock[]> {
  const { spine, tools, toolContext } = deps;
  const approvals = new Map(
    spine.getApprovalsForRun(run.id).map((a) => [a.toolUseId, a]),
  );
  const results: ContentBlock[] = [];

  const denial = (call: ToolUse, message: string, decision: PolicyDecision): void => {
    emit({ type: "tool.failed", toolUseId: call.id, error: message });
    results.push({ type: "tool_result", toolUseId: call.id, output: message, isError: true });
    record(spine, run, call, decision.action, "denied", message);
  };

  for (const call of toolUses) {
    const tool = tools.get(call.name);
    const decision = policy.decide({
      agentId: run.agentId,
      toolName: call.name,
      needsApproval: tool?.needsApproval ?? false,
      input: call.input,
      source,
      sessionKey: run.sessionKey,
    });
    emit({
      type: "tool.requested",
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      needsApproval: tool?.needsApproval ?? false,
    });

    if (decision.action === "deny") {
      denial(call, decision.reason ?? "This action was denied by policy.", decision);
      continue;
    }
    if (decision.action === "gate") {
      // Resolved by the durable human approval recorded while suspended.
      const approval = approvals.get(call.id);
      if (approval?.status !== "allowed") {
        denial(call, "The user denied this action.", decision);
        continue;
      }
    }

    emit({ type: "tool.started", toolUseId: call.id });
    try {
      if (!tool) throw new Error(`unknown tool: ${call.name}`);
      const output = await tool.run(call.input, toolContext);
      emit({ type: "tool.completed", toolUseId: call.id, output });
      results.push({ type: "tool_result", toolUseId: call.id, output });
      record(spine, run, call, decision.action, "ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "tool.failed", toolUseId: call.id, error: message });
      results.push({ type: "tool_result", toolUseId: call.id, output: message, isError: true });
      record(spine, run, call, decision.action, "error", message);
    }
  }
  return results;
}

/** Write one audit row for a tool-execution attempt. */
function record(
  spine: Spine,
  run: Run,
  call: ToolUse,
  decision: PolicyDecision["action"],
  outcome: "ok" | "error" | "denied",
  reason?: string,
): void {
  spine.recordAction({
    id: newActionId(),
    runId: run.id,
    sessionKey: run.sessionKey,
    agentId: run.agentId,
    toolName: call.name,
    input: call.input,
    decision,
    reason,
    outcome,
    createdAt: nowIso(),
  });
}

/** Execute and commit the pending (suspended) turn after approvals resolved. */
async function finishSuspendedTurn(
  run: Run,
  deps: LoopDeps,
  emit: (body: ReefEventBody) => void,
  index: number,
  source: RunSource,
  policy: ApprovalPolicy,
): Promise<boolean> {
  const { spine } = deps;
  const pending = spine.getSteps(run.id).find((s) => s.state === "pending");
  if (!pending?.response) return false;

  const toolUses = pending.response.filter((b): b is ToolUse => b.type === "tool_use");
  const toolResults = await executeTools(toolUses, run, deps, emit, source, policy);
  spine.appendMessage(run.sessionKey, "tool", toolResults, run.id);
  spine.commitStep(run.id, pending.index, {
    response: pending.response,
    toolResults,
    usage: pending.usage,
  });
  emit({ type: "step.committed", index: pending.index, usage: pending.usage });
  return true;
}

function describeAction(call: ToolUse): string {
  const input = JSON.stringify(call.input);
  const shown = input.length > 300 ? `${input.slice(0, 300)}…` : input;
  return `${call.name}(${shown})`;
}

function finalize(
  spine: Spine,
  run: Run,
  status: RunStatus,
  stopReason: StopReason,
): void {
  spine.setRunStatus(run.id, status, { stopReason, endedAt: nowIso() });
}
