import type { ReefEvent } from "../../protocol/events.js";

// Projects reef's native agentic event stream onto conch's frame model
// (reef-docs decision: conch is the first consumer, a floor to extend not a
// ceiling to conform to). This is the *down-projection* — it maps onto conch's
// EXISTING `AgentPayload`/`exec.approval.requested` contract and deliberately
// drops what conch has no slot for yet (step.committed, usage, budget, memory).
// Phase 2b will extend conch's protocol to carry those; until then they're
// dropped here, in one legible place, rather than silently lost across the wire.

/** A conch event frame: the (eventType, data) pair conch's eventSink expects. */
export interface ConchFrame {
  eventType: string;
  data: unknown;
}

const BACKEND_ID = "reef";

/** conch AgentPayload shape (mirrored locally — reef does not import from conch). */
interface AgentPayload {
  runId: string;
  sessionKey: string;
  stream: "assistant" | "thinking" | "tool" | "tool_result" | "lifecycle" | "error";
  seq: number;
  ts: number;
  data?: Record<string, unknown>;
}

/**
 * Stateful per consumer (one per SSE connection): reef emits assistant text as
 * per-chunk deltas, but conch's `assistant` stream wants both the delta and the
 * cumulative text, so the projector accumulates per run.
 */
interface RunState {
  text: string;
  thinking: string;
  inputTokens: number;
  outputTokens: number;
}

const freshState = (): RunState => ({
  text: "",
  thinking: "",
  inputTokens: 0,
  outputTokens: 0,
});

export class ConchProjector {
  private readonly cumulative = new Map<string, RunState>();

  project(event: ReefEvent): ConchFrame[] {
    switch (event.type) {
      case "run.started":
        this.cumulative.set(event.runId, freshState());
        return [this.typing(event, "start")];

      case "message.delta": {
        const state = this.acc(event.runId);
        state.text += event.text;
        return [this.agent(event, "assistant", { delta: event.text, text: state.text })];
      }

      case "thinking.delta": {
        const state = this.acc(event.runId);
        state.thinking += event.text;
        return [this.agent(event, "thinking", { delta: event.text, text: state.thinking })];
      }

      case "tool.requested":
        return [
          this.agent(event, "tool", {
            name: event.name,
            input: event.input,
            toolUseId: event.toolUseId,
          }),
        ];

      case "tool.completed":
        return [
          this.agent(event, "tool_result", {
            toolUseId: event.toolUseId,
            output: event.output,
          }),
        ];

      case "tool.failed":
        return [
          this.agent(event, "tool_result", {
            toolUseId: event.toolUseId,
            output: event.error,
            error: true,
          }),
        ];

      case "approval.requested":
        return [
          {
            eventType: "exec.approval.requested",
            data: {
              id: event.approvalId,
              sessionKey: event.sessionKey,
              agentId: BACKEND_ID,
              backendId: BACKEND_ID,
              command: event.action,
              cwd: "",
              host: BACKEND_ID,
              detail: event.detail,
            },
          },
        ];

      case "run.resumed":
        return [this.typing(event, "start")];

      // Not forwarded as its own frame, but harvested: per-step usage
      // accumulates into the run total that rides the lifecycle frame, so
      // conch's dormant cost columns get populated (Phase 2b).
      case "step.committed": {
        const state = this.acc(event.runId);
        if (event.usage) {
          state.inputTokens += event.usage.inputTokens;
          state.outputTokens += event.usage.outputTokens;
        }
        return [];
      }

      case "run.completed": {
        const usage = this.usageOf(event.runId);
        this.cumulative.delete(event.runId);
        return [
          this.agent(event, "lifecycle", {
            status: "completed",
            stopReason: event.stopReason,
            usage,
          }),
          this.typing(event, "stop"),
        ];
      }

      case "run.failed": {
        const usage = this.usageOf(event.runId);
        this.cumulative.delete(event.runId);
        return [
          this.agent(event, "error", { error: event.error, usage }),
          this.typing(event, "stop"),
        ];
      }

      case "run.suspended":
        // approval.requested (if any) already fired; the UI is no longer "typing"
        return [this.typing(event, "stop")];

      // Dropped in the down-projection — conch has no slot yet (or renders it
      // itself): message.received (conch shows the user's own input),
      // step.started, message.completed, tool.started, approval.resolved,
      // context.compacted, memory.recalled, memory.recorded, budget.warning.
      // (context.compacted is first-class in the native stream and shown by the
      // dev CLI; surfacing it in conch is a deliberate Phase-2b-style extension.)
      default:
        return [];
    }
  }

  private acc(runId: string): RunState {
    let state = this.cumulative.get(runId);
    if (!state) {
      state = freshState();
      this.cumulative.set(runId, state);
    }
    return state;
  }

  private usageOf(runId: string): { inputTokens: number; outputTokens: number } {
    const state = this.acc(runId);
    return { inputTokens: state.inputTokens, outputTokens: state.outputTokens };
  }

  private agent(
    event: ReefEvent,
    stream: AgentPayload["stream"],
    data: Record<string, unknown>,
  ): ConchFrame {
    const payload: AgentPayload = {
      runId: event.runId,
      sessionKey: event.sessionKey,
      stream,
      seq: event.seq,
      ts: event.ts / 1000, // conch timestamps are epoch seconds
      data,
    };
    return { eventType: "agent", data: payload };
  }

  private typing(event: ReefEvent, phase: "start" | "stop"): ConchFrame {
    return {
      eventType: `typing:${phase}`,
      data: { sessionKey: event.sessionKey, backendId: BACKEND_ID, runId: event.runId },
    };
  }
}
