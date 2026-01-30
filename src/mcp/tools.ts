import { z } from "zod";
import type { AgentManager } from "../agent/AgentManager.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

const spawnSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  task: z.string(),
  cwd: z.string().optional(),
  mode: z.enum(["headless", "headful"]).optional()
});

const statusSchema = z.object({
  agentId: z.string().optional()
});

const sendSchema = z.object({
  agentId: z.string(),
  message: z.string()
});

const outputSchema = z.object({
  agentId: z.string(),
  since: z.string().optional()
});

const killSchema = z.object({
  agentId: z.string()
});

type ToolDefinition<T extends z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: T;
  handler: ToolCallback<T>;
};

const defineTool = <T extends z.ZodTypeAny>(tool: ToolDefinition<T>) => tool;

export function buildTools(manager: AgentManager) {
  const wrapResult = (data: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data
  });

  const tools = [
    defineTool({
      name: "reef:spawn",
      description: "Spawn a new agent job.",
      inputSchema: spawnSchema,
      handler: async (args: z.infer<typeof spawnSchema>) => {
        const job = await manager.spawn(args.agent, args.mode ?? "headless", args.task, args.cwd ?? ".");
        return wrapResult({ agentId: job.id, status: job.status });
      }
    }),
    defineTool({
      name: "reef:status",
      description: "Get status for a specific agent or all agents.",
      inputSchema: statusSchema,
      handler: async (args: z.infer<typeof statusSchema>) => {
        if (args.agentId) return wrapResult({ agents: [manager.getJob(args.agentId)] });
        return wrapResult({ agents: manager.listJobs() });
      }
    }),
    defineTool({
      name: "reef:send",
      description: "Send a message to a running agent.",
      inputSchema: sendSchema,
      handler: async (args: z.infer<typeof sendSchema>) => {
        manager.send(args.agentId, args.message);
        return wrapResult({ ok: true });
      }
    }),
    defineTool({
      name: "reef:output",
      description: "Fetch events for an agent since a timestamp cursor.",
      inputSchema: outputSchema,
      handler: async (args: z.infer<typeof outputSchema>) => {
        return wrapResult({ events: manager.getEvents(args.agentId, args.since) });
      }
    }),
    defineTool({
      name: "reef:kill",
      description: "Kill a running agent job.",
      inputSchema: killSchema,
      handler: async (args: z.infer<typeof killSchema>) => {
        manager.kill(args.agentId);
        return wrapResult({ ok: true });
      }
    })
  ];

  return tools;
}
