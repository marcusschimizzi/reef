import { z } from "zod";
import type { IntrospectionCapability } from "../introspect/capability.js";
import type { Tool, ToolContext } from "./types.js";

// Self-introspection tools — reef querying its own operational state. These let
// the agent answer "what am I doing / have I done / will I do?" from the inside,
// rather than a human reading the TUI. Read-only and ungated; they reach state
// only through ctx.introspection (agent-scoped), like memory and scheduling.

function requireIntrospection(ctx: ToolContext): IntrospectionCapability {
  if (!ctx.introspection) {
    throw new Error("introspection tool called without an introspection capability in context");
  }
  return ctx.introspection;
}

export const listRunsTool: Tool<{ status?: "running" | "suspended" | "completed" | "failed" }> = {
  name: "list_runs",
  description:
    "List your recent runs (work episodes), newest first — id, status, stop reason, " +
    "session, and when each started. Optionally filter by status; use status " +
    "'suspended' to find runs parked awaiting approval.",
  inputSchema: z.object({
    status: z
      .enum(["running", "suspended", "completed", "failed"])
      .optional()
      .describe("Only runs in this state"),
  }),
  async run({ status }, ctx) {
    const runs = requireIntrospection(ctx).runs({ status, limit: 30 });
    return {
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        stopReason: r.stopReason,
        sessionKey: r.sessionKey,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
    };
  },
};

export const listSessionsTool: Tool<Record<string, never>> = {
  name: "list_sessions",
  description:
    "List your sessions (conversations), most recently active first — each with its " +
    "status, a title, the latest line, and any pending approvals. Use this to see " +
    "the shape of your ongoing and past work.",
  inputSchema: z.object({}),
  async run(_input, ctx) {
    const sessions = requireIntrospection(ctx).sessions();
    return {
      sessions: sessions.map((s) => ({
        sessionKey: s.sessionKey,
        status: s.status,
        title: s.title,
        preview: s.preview,
        pendingApprovals: s.pendingApprovals,
        lastActivityAt: s.lastActivityAt,
      })),
    };
  },
};

export const currentModelTool: Tool<Record<string, never>> = {
  name: "current_model",
  description:
    "Report which model you (this run) are using — useful if you need to know your " +
    "own capabilities or tell the user. The model is pinned per session.",
  inputSchema: z.object({}),
  async run(_input, ctx) {
    return { model: ctx.model ?? "(unknown)" };
  },
};

export const listTriggersTool: Tool<Record<string, never>> = {
  name: "list_triggers",
  description:
    "List your triggers (scheduled wakes, heartbeats, and self-scheduled tasks) — " +
    "each with its type, schedule, instruction, whether it's enabled, and when it next " +
    "fires. A fuller view than list_schedules, which shows only your own self-scheduled ones.",
  inputSchema: z.object({}),
  async run(_input, ctx) {
    const triggers = requireIntrospection(ctx).triggers();
    return {
      triggers: triggers.map((t) => ({
        id: t.id,
        type: t.type,
        spec: t.spec,
        input: t.input,
        enabled: t.enabled,
        createdBy: t.createdBy,
        nextFireAt: t.nextFireAt,
        lastFiredAt: t.lastFiredAt,
      })),
    };
  },
};

export const introspectTools: Tool[] = [
  listRunsTool,
  listSessionsTool,
  listTriggersTool,
  currentModelTool,
];
