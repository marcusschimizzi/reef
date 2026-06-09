import { z } from "zod";
import type { Tool, ToolContext } from "./types.js";
import type { MemoryStore } from "../memory/seam.js";

// Memory tools — reef's cross-session knowledge, mechanism A (reef-docs/07):
// the model decides when to look something up and when to save one. They reach
// memory only through `ctx.memory` (injected like `ctx.fs`), and they are
// ungated — recall is a read, record writes only to the agent's own memory, so
// neither needs human approval. Because they are ordinary tools, they already
// surface through the tool.requested/tool.completed events; the dedicated
// memory.* protocol events stay reserved for the future automatic path.

function requireMemory(ctx: ToolContext): MemoryStore {
  if (!ctx.memory) {
    throw new Error("memory tool called without a memory store in context");
  }
  return ctx.memory;
}

export const recallMemoryTool: Tool<{
  query: string;
  limit?: number;
  tags?: string[];
}> = {
  name: "recall_memory",
  description:
    "Search your durable cross-session memory with a free-text query and get back " +
    "the most relevant saved memories, best match first. Use this before answering " +
    "when prior context (the user's preferences, facts you saved, earlier decisions) " +
    "might help.",
  inputSchema: z.object({
    query: z.string().describe("What to look for, in natural language"),
    limit: z.number().int().positive().optional().describe("Max results (default 8)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("If set, only memories carrying all of these tags are returned"),
  }),
  async run({ query, limit, tags }, ctx) {
    const memory = requireMemory(ctx);
    const results = await memory.recall(query, { limit, tags });
    return {
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        kind: r.kind,
        tags: r.tags,
        createdAt: r.createdAt,
        score: r.score,
      })),
    };
  },
};

export const recordMemoryTool: Tool<{
  content: string;
  kind?: string;
  tags?: string[];
}> = {
  name: "record_memory",
  description:
    "Save a durable memory that should persist across conversations — a user " +
    "preference, a stable fact, a decision and its rationale. Write a single " +
    "self-contained statement. Do not save transient details that only matter to " +
    "the current task.",
  inputSchema: z.object({
    content: z.string().describe("The memory to save, as one self-contained statement"),
    kind: z
      .string()
      .optional()
      .describe('Optional category, e.g. "preference" | "fact" | "decision"'),
    tags: z.array(z.string()).optional().describe("Optional labels for later filtering"),
  }),
  async run({ content, kind, tags }, ctx) {
    const memory = requireMemory(ctx);
    const { id } = await memory.record({ content, kind, tags });
    return { id };
  },
};

export const memoryTools: Tool[] = [recallMemoryTool, recordMemoryTool];
