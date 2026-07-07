// The model router — reef's thin seam over the vendored provider layer
// (Vercel AI SDK). The loop depends on the `ModelRouter` *interface*; nothing
// above this file imports an `ai`-package type. Provider-specific shape
// (tool-result output kinds, usage field names, the tool-call part format) is
// quarantined here; provider *selection* lives in the ProviderRegistry. Adding a
// provider is config, not a code change (reef-docs/09: own the loop, vendor the
// routing).

import {
  streamText,
  tool,
  type JSONValue,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import type { ContentBlock, Message, Usage } from "../core/types.js";
import { ProviderRegistry, type ProviderConfig } from "./providers.js";
import type { SecretStore } from "../secrets/store.js";

/** A tool as the *model* needs to see it — name, description, input schema.
 *  (Execution is the loop's job, via the full Tool + its context.) */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
}

/** Why the model stopped this turn — reef's normalization of finishReason. */
export type TurnStop = "completed" | "tool_use" | "max_tokens" | "other";

export interface ModelTurnInput {
  model: string;
  system: string;
  messages: Message[];
  tools?: ModelTool[];
  maxOutputTokens?: number;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ModelTurn {
  /** Assistant output for this turn — text blocks plus any tool_use blocks. */
  content: ContentBlock[];
  stop: TurnStop;
  usage: Usage;
}

/** The seam the loop calls. Implementations map to/from a concrete provider. */
export interface ModelRouter {
  generateTurn(input: ModelTurnInput): Promise<ModelTurn>;
  /** Validate that a model id resolves (its provider is known/configured),
   *  throwing otherwise. Optional so test doubles need not implement it; used by
   *  `/model` to reject an unknown provider before it becomes a mid-run 401. */
  assertResolvable?(modelId: string): void;
}

export class VercelRouter implements ModelRouter {
  private readonly registry: ProviderRegistry;

  /** Pass user-configured providers (custom endpoints) and the secret store
   *  (the primary source for API keys) to extend the built-ins. `registry`
   *  overrides both — the offline-test seam for injecting a mock model. */
  constructor(providers: ProviderConfig[] = [], secrets?: SecretStore, registry?: ProviderRegistry) {
    this.registry = registry ?? new ProviderRegistry(providers, secrets);
  }

  /** Build (and cache) the provider for `modelId`, throwing if its provider is
   *  unknown or misconfigured — purely offline, no network call. */
  assertResolvable(modelId: string): void {
    this.registry.resolve(modelId);
  }

  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    // Capture stream-level failures (RF-10). streamText does NOT reject on a
    // provider error — it emits an `error` chunk and resolves; without capturing
    // it here an overloaded/401/429 response comes back as an EMPTY successful
    // turn, indistinguishable from the model choosing to say nothing. Rethrowing
    // the original error is what makes a 3am failure diagnosable in run.failed.
    let streamError: unknown;
    const result = streamText({
      model: this.registry.resolve(input.model),
      system: input.system,
      messages: toModelMessages(input.messages),
      tools: input.tools ? toAiTools(input.tools) : undefined,
      maxOutputTokens: input.maxOutputTokens ?? 8192,
      abortSignal: input.signal,
      onError: ({ error }) => {
        streamError ??= error;
      },
    });

    // Drain the stream so deltas reach the consumer; the promises below resolve
    // once it completes.
    for await (const chunk of result.fullStream) {
      if (chunk.type === "text-delta") input.onTextDelta?.(chunk.text);
      else if (chunk.type === "reasoning-delta")
        input.onThinkingDelta?.(chunk.text);
      else if (chunk.type === "error") streamError ??= chunk.error;
    }
    if (streamError !== undefined) {
      throw streamError instanceof Error ? streamError : new Error(stringifyError(streamError));
    }

    const [finishReason, toolCalls, text, usage] = await Promise.all([
      result.finishReason,
      result.toolCalls,
      result.text,
      result.usage,
    ]);

    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const tc of toolCalls) {
      content.push({
        type: "tool_use",
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.input,
      });
    }

    return { content, stop: toTurnStop(finishReason), usage: toUsage(usage) };
  }
}

// ── mapping at the boundary ──────────────────────────────────────────────────

/** A non-Error stream error rendered diagnosably — String() on a provider's plain
 *  error object yields "[object Object]", hiding the status/message it carries. */
function stringifyError(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function toTurnStop(reason: string): TurnStop {
  switch (reason) {
    case "tool-calls":
      return "tool_use";
    case "stop":
      return "completed";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

function toUsage(u: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}): Usage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cachedInputTokens,
  };
}

function toAiTools(tools: ModelTool[]): ToolSet {
  const rec: ToolSet = {};
  for (const t of tools) {
    rec[t.name] = tool({ description: t.description, inputSchema: t.inputSchema });
  }
  return rec;
}

function toToolOutput(output: unknown, isError?: boolean) {
  if (isError) {
    return typeof output === "string"
      ? ({ type: "error-text", value: output } as const)
      : ({ type: "error-json", value: output as JSONValue } as const);
  }
  return typeof output === "string"
    ? ({ type: "text", value: output } as const)
    : ({ type: "json", value: output as JSONValue } as const);
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  // tool_result blocks carry only the tool_use id; the AI SDK tool-result part
  // also wants the tool name. Resolve it from the matching tool_use across the
  // whole history.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") toolNameById.set(b.id, b.name);
    }
  }

  const out: ModelMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system": {
        const text = m.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        out.push({ role: "system", content: text });
        break;
      }
      case "user": {
        out.push({
          role: "user",
          content: m.content
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => ({ type: "text" as const, text: b.text })),
        });
        break;
      }
      case "assistant": {
        const parts: Array<
          | { type: "text"; text: string }
          | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
        > = [];
        for (const b of m.content) {
          if (b.type === "text") parts.push({ type: "text", text: b.text });
          else if (b.type === "tool_use")
            parts.push({
              type: "tool-call",
              toolCallId: b.id,
              toolName: b.name,
              input: b.input,
            });
          // thinking blocks are dropped from replayed history
        }
        out.push({ role: "assistant", content: parts });
        break;
      }
      case "tool": {
        out.push({
          role: "tool",
          content: m.content
            .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
            .map((b) => ({
              type: "tool-result" as const,
              toolCallId: b.toolUseId,
              toolName: toolNameById.get(b.toolUseId) ?? "unknown",
              output: toToolOutput(b.output, b.isError),
            })),
        });
        break;
      }
    }
  }
  return out;
}
