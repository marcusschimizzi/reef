import type { z } from "zod";
import type { FsCapability } from "../fs/capability.js";

// What a tool receives at execution time. The fs capability is injected here —
// a tool reaches the filesystem only through `ctx.fs`, never via ambient paths
// (reef-docs/08). More context (approvals, memory) lands in later phases.
export interface ToolContext {
  fs: FsCapability;
  /** Absolute path of the agent's workspace — the default cwd for shell. */
  workspaceRoot: string;
  signal?: AbortSignal;
}

/**
 * A first-party tool: a typed function plus the description the model reads to
 * decide when to call it. The model-facing schema is *derived* from
 * `inputSchema`, never hand-maintained alongside it (reef-docs/08).
 */
export interface Tool<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** If true, the run suspends for approval before this tool executes. v1: not
   *  yet enforced (the loop emits the request); the gate lands in Phase 2. */
  needsApproval?: boolean;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}
