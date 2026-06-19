// Context compaction (Phase 3c). When a session's assembled context crosses a
// token threshold, the loop folds the oldest messages into a durable summary so
// the conversation stays under the model's context window.
//
// Design (chosen over the provider's server-side compaction beta): keep it
// reef-side and provider-agnostic. Summarizing is "just another turn" through
// the vendored router, so it works for any provider; the checkpoint is durable
// in the spine, so recovery-as-query restores the compacted view after a crash;
// and it is observable — the loop emits `context.compacted` into the native
// protocol. Compaction is a *view* over the immutable message log (see
// Spine.getContext), never a rewrite, so the full history stays auditable and
// re-compactable.

import type { AgentRecord, ContentBlock, Message, Run } from "../core/types.js";
import type { Spine } from "../db/spine.js";
import type { ModelRouter } from "../model/router.js";
import type { ReefEventBody } from "../protocol/events.js";

export interface CompactionPolicy {
  /** Fold when the most recent turn's measured inputTokens reaches this.
   *  Uses the provider's own token count — no local estimation. */
  triggerTokens: number;
  /** Messages kept verbatim after a fold — the recent working context. */
  keepRecentMessages: number;
}

/** Trigger well inside a large window; keep a generous verbatim tail. Tunable. */
export const DEFAULT_COMPACTION: CompactionPolicy = {
  triggerTokens: 150_000,
  keepRecentMessages: 8,
};

interface CompactArgs {
  spine: Spine;
  router: ModelRouter;
  run: Run;
  agent: AgentRecord;
  emit: (body: ReefEventBody) => void;
  policy?: CompactionPolicy;
  signal?: AbortSignal;
}

/**
 * Fold older messages into a summary if the last turn's context crossed the
 * threshold and there is a meaningful amount to fold. Returns whether it
 * compacted. A no-op (and cheap — no model call) when not triggered, so it is
 * safe to call at the top of every loop iteration.
 */
export async function maybeCompact(args: CompactArgs): Promise<boolean> {
  const { spine, router, run, agent, emit, signal } = args;
  const policy = args.policy ?? DEFAULT_COMPACTION;

  // 1. Trigger on the size the provider actually measured last turn — the most recent
  //    committed step's inputTokens IS the assembled-context size. Read it at the
  //    SESSION level (not just this run): a single-step chat run commits its one step
  //    only when it ends, so checking the current run alone never fires for chat.
  const lastUsage = spine.getLatestSessionStepUsage(run.sessionKey);
  if (!lastUsage || lastUsage.inputTokens < policy.triggerTokens) return false;

  // 2. Decide the cut: fold everything before a verbatim recent tail, with the
  //    boundary snapped back off any leading `tool` message so a tool_use/
  //    tool_result pair is never split across the summary line.
  const comp = spine.getLatestCompaction(run.sessionKey);
  const through = comp?.throughSeq ?? 0;
  const entries = spine.getMessageEntries(run.sessionKey, through);

  let cut = entries.length - policy.keepRecentMessages;
  while (cut > 0 && entries[cut]?.role === "tool") cut--;
  if (cut <= 0) return false; // not enough new history beyond the tail to fold

  const foldable = entries.slice(0, cut);
  const throughSeq = foldable[foldable.length - 1]!.seq;

  // 3. Summarize through the router — provider-agnostic, just another turn.
  const summary = await summarize(
    router,
    agent.model,
    comp?.summary,
    foldable,
    signal,
  );
  if (!summary) return false;

  spine.appendCompaction({ sessionKey: run.sessionKey, throughSeq, summary });
  emit({ type: "context.compacted", throughSeq, foldedMessages: foldable.length });
  return true;
}

const SUMMARIZER_SYSTEM =
  "You are compacting a conversation so it fits within a context window. " +
  "Write a dense, faithful note to your future self that lets you continue the " +
  "work with no loss of important detail. Preserve: the user's goals and " +
  "constraints, decisions made and why, facts and results learned, file paths " +
  "and identifiers, the current state of any task, open questions, and anything " +
  "still pending or promised. Drop only redundancy and small talk. Use compact " +
  "prose or bullets. Do not address the user — this is an internal record.";

/** One model call that condenses the foldable region (and any prior summary). */
async function summarize(
  router: ModelRouter,
  model: string,
  prior: string | undefined,
  foldable: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = renderTranscript(foldable);
  const prompt = prior
    ? `Summary of the conversation so far:\n\n${prior}\n\n---\n\n` +
      `Additional conversation since that summary:\n\n${transcript}\n\n---\n\n` +
      `Produce one updated summary that fully incorporates both.`
    : `Conversation to summarize:\n\n${transcript}`;

  const turn = await router.generateTurn({
    model,
    system: SUMMARIZER_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    signal,
  });

  return turn.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Render messages to a readable transcript for the summarizer to condense. */
function renderTranscript(messages: Message[]): string {
  return messages.map(renderMessage).join("\n\n");
}

function renderMessage(m: Message): string {
  const body = m.content.map(renderBlock).filter(Boolean).join("\n");
  return `### ${m.role}\n${body}`;
}

function renderBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "thinking":
      return ""; // already excluded from replayed history
    case "tool_use":
      return `[calls ${b.name}(${safeJson(b.input)})]`;
    case "tool_result":
      return `[tool ${b.isError ? "error" : "result"}: ${safeJson(b.output)}]`;
  }
}

function safeJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(v);
  }
}
