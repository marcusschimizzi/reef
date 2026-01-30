import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentManager } from "./agent/AgentManager.js";
import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { buildTools } from "./mcp/tools.js";

export async function startServer(): Promise<void> {
  const registry = new AdapterRegistry();
  registry.register("claude", new ClaudeAdapter());
  registry.register("codex", new CodexAdapter());
  const manager = new AgentManager(registry);
  await manager.loadSnapshot();

  const server = new McpServer({ name: "reef", version: "0.1.0" });
  const tools = buildTools(manager);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      tool.handler
    );
  }

  const transport = new StdioServerTransport();
  server.connect(transport);
}
