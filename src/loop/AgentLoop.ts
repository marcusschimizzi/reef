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

/**
 * The one parameterized agent loop (reef-docs/03). Runs a single Run to a typed
 * termination: assemble context → model turn → run tools → repeat. Each
 * iteration is a durable step — the model turn and its tools are committed to
 * the spine in one boundary before the next iteration begins.
 *
 * The wake (a user message) is expected to already be on the session; the loop
 * reads the conversation from the spine and advances it.
 */
export async function runAgentLoop(
  run: Run,
  agent: AgentRecord,
  deps: LoopDeps,
): Promise<StopReason> {
  const { spine, router, tools, toolContext } = deps;
  const maxSteps = deps.maxSteps ?? 20;

  const emit = (body: ReefEventBody): void =>
    deps.emit({
      ...body,
      sessionKey: run.sessionKey,
      runId: run.id,
    } as ReefEventInit);

  emit({ type: "run.started", agentId: agent.id });

  const modelTools = tools.modelTools(agent.toolAllowlist);
  // Resume-aware: continue after any steps already committed (crash recovery).
  let index = spine
    .getSteps(run.id)
    .filter((s) => s.state === "committed").length;

  let stopReason: StopReason = "completed";

  try {
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
        (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      );

      let toolResults: ContentBlock[] | undefined;
      if (turn.stop === "tool_use" && toolUses.length > 0) {
        toolResults = [];
        for (const call of toolUses) {
          const tool = tools.get(call.name);
          emit({
            type: "tool.requested",
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            needsApproval: tool?.needsApproval ?? false,
          });
          emit({ type: "tool.started", toolUseId: call.id });
          try {
            if (!tool) throw new Error(`unknown tool: ${call.name}`);
            const output = await tool.run(call.input, toolContext);
            emit({ type: "tool.completed", toolUseId: call.id, output });
            toolResults.push({
              type: "tool_result",
              toolUseId: call.id,
              output,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emit({ type: "tool.failed", toolUseId: call.id, error: message });
            // An errored tool is an *input* to the loop, not a run failure: the
            // model sees the error and can adapt (reef-docs/03).
            toolResults.push({
              type: "tool_result",
              toolUseId: call.id,
              output: message,
              isError: true,
            });
          }
        }
        spine.appendMessage(run.sessionKey, "tool", toolResults, run.id);
      }

      // The durable boundary: one commit per iteration, after tools resolve.
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

function finalize(
  spine: Spine,
  run: Run,
  status: RunStatus,
  stopReason: StopReason,
): void {
  spine.setRunStatus(run.id, status, { stopReason, endedAt: nowIso() });
}
