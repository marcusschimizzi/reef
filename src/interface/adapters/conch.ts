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
export class ConchProjector {
  private readonly cumulative = new Map<string, { text: string; thinking: string }>();

  project(event: ReefEvent): ConchFrame[] {
    switch (event.type) {
      case "run.started":
        this.cumulative.set(event.runId, { text: "", thinking: "" });
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

      case "run.completed": {
        this.cumulative.delete(event.runId);
        return [
          this.agent(event, "lifecycle", { status: "completed", stopReason: event.stopReason }),
          this.typing(event, "stop"),
        ];
      }

      case "run.failed": {
        this.cumulative.delete(event.runId);
        return [
          this.agent(event, "error", { error: event.error }),
          this.typing(event, "stop"),
        ];
      }

      case "run.suspended":
        // approval.requested (if any) already fired; the UI is no longer "typing"
        return [this.typing(event, "stop")];

      // Dropped in the down-projection — conch has no slot yet (Phase 2b):
      // step.started, step.committed, message.completed, tool.started,
      // approval.resolved, memory.recalled, memory.recorded, budget.warning.
      default:
        return [];
    }
  }

  private acc(runId: string): { text: string; thinking: string } {
    let state = this.cumulative.get(runId);
    if (!state) {
      state = { text: "", thinking: "" };
      this.cumulative.set(runId, state);
    }
    return state;
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
