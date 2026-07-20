import type { ReefEvent } from "../../protocol/events.js";
import type { ContentBlock } from "../../core/types.js";

/** Concatenate the text blocks of a completed turn — the authoritative message. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// The transcript model — a pure reduction of reef's native event stream into a
// flat list of renderable items, plus run status and cumulative usage. Keeping
// this framework-free (no React) makes the streaming/tool/approval logic — the
// part most worth getting right — directly unit-testable. The Ink layer just
// renders TranscriptState and feeds it events.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type ToolStatus = "pending" | "running" | "ok" | "error";
export type ApprovalStatus = "pending" | "allowed" | "denied";

export type TranscriptItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; streaming: boolean }
  | { id: number; kind: "thinking"; text: string }
  | {
      id: number;
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      status: ToolStatus;
      output?: unknown;
      error?: string;
    }
  | {
      id: number;
      kind: "approval";
      approvalId: string;
      action: string;
      detail?: unknown;
      status: ApprovalStatus;
    }
  | { id: number; kind: "notice"; text: string }
  | { id: number; kind: "error"; text: string };

export type RunStatus = "idle" | "working" | "awaiting_approval";

export interface TranscriptState {
  items: TranscriptItem[];
  status: RunStatus;
  usage: UsageTotals;
  nextId: number;
}

export const initialState: TranscriptState = {
  items: [],
  status: "idle",
  usage: { inputTokens: 0, outputTokens: 0 },
  nextId: 1,
};

// Distributive omit so each union member keeps its own fields (a plain
// Omit<TranscriptItem, "id"> would collapse to just the shared `kind`).
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Append an item, assigning it the next id. */
function push(state: TranscriptState, item: WithoutId<TranscriptItem>): TranscriptState {
  return {
    ...state,
    items: [...state.items, { ...item, id: state.nextId } as TranscriptItem],
    nextId: state.nextId + 1,
  };
}

/** Replace the first item matching `pred` via `update`; no-op if none match. */
function patch(
  state: TranscriptState,
  pred: (i: TranscriptItem) => boolean,
  update: (i: TranscriptItem) => TranscriptItem,
): TranscriptState {
  let done = false;
  const items = state.items.map((i) => {
    if (done || !pred(i)) return i;
    done = true;
    return update(i);
  });
  return { ...state, items };
}

/** Local action: the user submitted a line (echoed before the run starts). */
export function pushUser(state: TranscriptState, text: string): TranscriptState {
  return push(state, { kind: "user", text });
}

/** Local action: an informational line (slash-command output, etc.). */
export function pushNotice(state: TranscriptState, text: string): TranscriptState {
  return push(state, { kind: "notice", text });
}

/** Fold one native reef event into the transcript. */
export function reduceEvent(state: TranscriptState, event: ReefEvent): TranscriptState {
  switch (event.type) {
    case "run.started":
      return {
        ...(event.source?.kind === "trigger"
          ? push(state, { kind: "notice", text: "⏰ triggered run" })
          : state),
        status: "working",
      };

    case "run.resumed":
      return { ...state, status: "working" };

    case "message.received":
      // The turn that started the run (user message or trigger instruction) —
      // the single source of the user line, live and on history replay.
      return push(state, { kind: "user", text: event.text });

    case "message.queued":
      // A send while the session's run was parked: parked durably, delivered as
      // its own run later (whose message.received renders the real user line).
      // Show it as a notice now so the send doesn't look dropped.
      return push(state, {
        kind: "notice",
        text: `⧗ queued: ${event.text} (delivers when the session is free)`,
      });

    case "thinking.delta": {
      const last = state.items.at(-1);
      if (last?.kind === "thinking") {
        return patch(state, (i) => i.id === last.id, (i) => ({
          ...(i as Extract<TranscriptItem, { kind: "thinking" }>),
          text: (i as Extract<TranscriptItem, { kind: "thinking" }>).text + event.text,
        }));
      }
      return push(state, { kind: "thinking", text: event.text });
    }

    case "message.delta": {
      const last = state.items.at(-1);
      if (last?.kind === "assistant" && last.streaming) {
        return patch(state, (i) => i.id === last.id, (i) => ({
          ...(i as Extract<TranscriptItem, { kind: "assistant" }>),
          text: (i as Extract<TranscriptItem, { kind: "assistant" }>).text + event.text,
        }));
      }
      return push(state, { kind: "assistant", text: event.text, streaming: true });
    }

    case "message.completed": {
      // Finalize the in-flight assistant stream, replacing its text with the
      // turn's authoritative full content (deltas can drop the tail — that was
      // the "response cut off before the end" bug).
      const full = textOf(event.content);
      if (state.items.some((i) => i.kind === "assistant" && i.streaming)) {
        return patch(
          state,
          (i) => i.kind === "assistant" && i.streaming,
          (i) => {
            const a = i as Extract<TranscriptItem, { kind: "assistant" }>;
            return { ...a, text: full || a.text, streaming: false };
          },
        );
      }
      // Text arrived only on completion (no deltas streamed) — add it.
      return full ? push(state, { kind: "assistant", text: full, streaming: false }) : state;
    }

    case "tool.requested":
      return push(state, {
        kind: "tool",
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
        status: "pending",
      });

    case "tool.started":
      return patchTool(state, event.toolUseId, (t) => ({ ...t, status: "running" }));

    case "tool.completed":
      return patchTool(state, event.toolUseId, (t) => ({ ...t, status: "ok", output: event.output }));

    case "tool.failed":
      return patchTool(state, event.toolUseId, (t) => ({ ...t, status: "error", error: event.error }));

    case "approval.requested":
      return push(state, {
        kind: "approval",
        approvalId: event.approvalId,
        action: event.action,
        detail: event.detail,
        status: "pending",
      });

    case "approval.resolved":
      return patch(
        state,
        (i) => i.kind === "approval" && i.approvalId === event.approvalId,
        (i) => ({
          ...(i as Extract<TranscriptItem, { kind: "approval" }>),
          status: event.decision === "deny" ? "denied" : "allowed",
        }),
      );

    case "run.suspended":
      return { ...state, status: "awaiting_approval" };

    case "step.committed":
      return event.usage
        ? {
            ...state,
            usage: {
              inputTokens: state.usage.inputTokens + event.usage.inputTokens,
              outputTokens: state.usage.outputTokens + event.usage.outputTokens,
            },
          }
        : state;

    case "context.compacted":
      return push(state, {
        kind: "notice",
        text: `compacted ${event.foldedMessages} earlier message(s) into a summary`,
      });

    case "run.completed":
      return { ...finalizeStream(state), status: "idle" };

    case "run.failed":
      return { ...push(state, { kind: "error", text: event.error }), status: "idle" };

    case "coding.output":
      return pushNotice(state, event.text);

    case "coding.prompt.detected":
      return pushNotice(
        state,
        `coding agent needs a decision:\n${event.promptText}\n${event.options
          .map((o) => `  ${o.index}. ${o.label}`)
          .join("\n")}`,
      );

    default:
      return state;
  }
}

function patchTool(
  state: TranscriptState,
  toolUseId: string,
  update: (t: Extract<TranscriptItem, { kind: "tool" }>) => Extract<TranscriptItem, { kind: "tool" }>,
): TranscriptState {
  return patch(
    state,
    (i) => i.kind === "tool" && i.toolUseId === toolUseId,
    (i) => update(i as Extract<TranscriptItem, { kind: "tool" }>),
  );
}

function finalizeStream(state: TranscriptState): TranscriptState {
  return patch(
    state,
    (i) => i.kind === "assistant" && i.streaming,
    (i) => ({ ...(i as Extract<TranscriptItem, { kind: "assistant" }>), streaming: false }),
  );
}

/**
 * A "live" item is still mutating (a streaming reply, a running tool, a pending
 * approval); everything else is final. Because the loop runs sequentially, live
 * items are always a trailing suffix — so the transcript splits cleanly into a
 * finalized prefix (safe to commit to Ink's <Static> scrollback) and a live
 * tail (re-rendered each frame).
 */
export function isLive(item: TranscriptItem): boolean {
  if (item.kind === "assistant") return item.streaming;
  if (item.kind === "tool") return item.status === "pending" || item.status === "running";
  if (item.kind === "approval") return item.status === "pending";
  return false;
}

export function splitTranscript(items: TranscriptItem[]): {
  done: TranscriptItem[];
  live: TranscriptItem[];
} {
  if (items.length === 0) return { done: [], live: [] };
  const firstLive = items.findIndex(isLive);
  // Keep at least the final item in the live (re-rendered) region. Ink's <Static>
  // can clip the last line of a tall committed item at the Static→live boundary,
  // so the bottom-most turn must never be committed until a newer item is below it.
  const cut = firstLive === -1 ? items.length - 1 : firstLive;
  return { done: items.slice(0, cut), live: items.slice(cut) };
}

/** Approvals still awaiting a decision — drives the TUI's input focus. */
export function pendingApprovals(
  state: TranscriptState,
): Array<Extract<TranscriptItem, { kind: "approval" }>> {
  return state.items.filter(
    (i): i is Extract<TranscriptItem, { kind: "approval" }> =>
      i.kind === "approval" && i.status === "pending",
  );
}
