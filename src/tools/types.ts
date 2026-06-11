import type { z } from "zod";
import type { FsCapability } from "../fs/capability.js";
import type { MemoryStore } from "../memory/seam.js";
import type { SchedulerCapability } from "../triggers/capability.js";
import type { IntrospectionCapability } from "../introspect/capability.js";

// What a tool receives at execution time. The fs capability is injected here —
// a tool reaches the filesystem only through `ctx.fs`, never via ambient paths
// (reef-docs/08). The memory store is injected the same way (reef-docs/07).
export interface ToolContext {
  fs: FsCapability;
  /** Absolute path of the agent's workspace — the default cwd for shell. */
  workspaceRoot: string;
  /** The effective model id for this run (session pin, else agent default). */
  model?: string;
  /** The agent's bound memory store. Present whenever the daemon runs a tool;
   *  optional so lightweight/no-memory execution contexts (and tool tests that
   *  don't touch memory) need not supply one. Memory tools assert it. */
  memory?: MemoryStore;
  /** The agent's self-scheduling capability (Phase 4c). Present whenever the
   *  daemon runs a tool; optional so no-scheduler contexts (and tool tests that
   *  don't schedule) need not supply one. The schedule tools assert it. */
  scheduler?: SchedulerCapability;
  /** Read-only self-introspection (Phase: recorded-authority). Present whenever
   *  the daemon runs a tool; the introspection tools assert it. */
  introspection?: IntrospectionCapability;
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
