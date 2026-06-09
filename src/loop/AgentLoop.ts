import { newApprovalId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type {
  AgentRecord,
  ContentBlock,
  Run,
  RunStatus,
  StopReason,
} from "../core/types.js";
import type { Spine } from "../db/spine.js";
import type { ModelRouter } from "../model/router.js";
import type { EmitFn, ReefEventBody, ReefEventInit } from "../protocol/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

export interface LoopDeps {
  spine: Spine;
  router: ModelRouter;
  tools: ToolRegistry;
  toolContext: ToolContext;
  /** The daemon's sink stamps each event with seq + ts, persists, broadcasts. */
  emit: EmitFn;
  /** Per-run iteration ceiling — the non-convergence backstop (reef-docs/03). */
  maxSteps?: number;
}

export interface LoopOptions {
  /** Resume a run that was suspended awaiting approval: the model turn already
   *  exists on the pending step; execute its (now-decided) tools and continue. */
  resumeApproval?: boolean;
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

  const emit = (body: ReefEventBody): void =>
    deps.emit({ ...body, sessionKey: run.sessionKey, runId: run.id } as ReefEventInit);

  emit(options.resumeApproval ? { type: "run.resumed" } : { type: "run.started", agentId: agent.id });

  const modelTools = tools.modelTools(agent.toolAllowlist);
  let index = spine.getSteps(run.id).filter((s) => s.state === "committed").length;
  let stopReason: StopReason = "completed";

  try {
    // Resume preamble: finish the suspended turn whose tools were just decided.
    if (options.resumeApproval) {
      if (spine.pendingApprovalCount(run.id) > 0) return "awaiting_approval";
      if (await finishSuspendedTurn(run, deps, emit, index)) index++;
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

      emit({ type: "step.started", index });
      spine.beginStep(run.id, index);

      const messages = spine.getMessages(run.sessionKey);
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

      // Suspend the whole turn if any tool in it needs approval.
      const gated = toolUses.filter((c) => tools.get(c.name)?.needsApproval);
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
        toolResults = await executeTools(toolUses, run, deps, emit);
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
 * Execute a turn's tool calls. Gated calls are governed by their durable
 * approval decision: denied → a denial result fed back to the model; allowed or
 * ungated → run. An errored tool is an input to the loop, not a run failure.
 */
async function executeTools(
  toolUses: ToolUse[],
  run: Run,
  deps: LoopDeps,
  emit: (body: ReefEventBody) => void,
): Promise<ContentBlock[]> {
  const { spine, tools, toolContext } = deps;
  const approvals = new Map(
    spine.getApprovalsForRun(run.id).map((a) => [a.toolUseId, a]),
  );
  const results: ContentBlock[] = [];

  for (const call of toolUses) {
    const tool = tools.get(call.name);
    const approval = approvals.get(call.id);
    emit({
      type: "tool.requested",
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      needsApproval: tool?.needsApproval ?? false,
    });

    if (approval?.status === "denied") {
      const message = "The user denied this action.";
      emit({ type: "tool.failed", toolUseId: call.id, error: message });
      results.push({ type: "tool_result", toolUseId: call.id, output: message, isError: true });
      continue;
    }

    emit({ type: "tool.started", toolUseId: call.id });
    try {
      if (!tool) throw new Error(`unknown tool: ${call.name}`);
      const output = await tool.run(call.input, toolContext);
      emit({ type: "tool.completed", toolUseId: call.id, output });
      results.push({ type: "tool_result", toolUseId: call.id, output });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "tool.failed", toolUseId: call.id, error: message });
      results.push({ type: "tool_result", toolUseId: call.id, output: message, isError: true });
    }
  }
  return results;
}

/** Execute and commit the pending (suspended) turn after approvals resolved. */
async function finishSuspendedTurn(
  run: Run,
  deps: LoopDeps,
  emit: (body: ReefEventBody) => void,
  index: number,
): Promise<boolean> {
  const { spine } = deps;
  const pending = spine.getSteps(run.id).find((s) => s.state === "pending");
  if (!pending?.response) return false;

  const toolUses = pending.response.filter((b): b is ToolUse => b.type === "tool_use");
  const toolResults = await executeTools(toolUses, run, deps, emit);
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
