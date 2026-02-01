import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentManager } from "./agent/AgentManager.js";
import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { OpenCodeAdapter } from "./adapters/OpenCodeAdapter.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { buildTools } from "./mcp/tools.js";

type ServerIo = {
  stdin?: Readable;
  stdout?: Writable;
};

export async function createServer(io: ServerIo = {}) {
  const registry = new AdapterRegistry();
  registry.register("claude", new ClaudeAdapter());
  registry.register("codex", new CodexAdapter());
  registry.register("opencode", new OpenCodeAdapter());
  const manager = new AgentManager(registry);
  await manager.loadSnapshot();
  const startedAt = Date.now();

  const server = new McpServer({ name: "reef", version: "0.1.0" });
  const tools = buildTools(manager, {
    version: "0.1.0",
    adapters: registry.list(),
    startedAt
  });
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

  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  if (stdin === process.stdin) {
    process.stdin.resume();
  }

  return { server, transport };
}

export async function startServer(): Promise<void> {
  await createServer();

  const stdin = process.stdin;
  stdin.resume();

  // Keep the process alive while stdin is open. In some environments, merely
  // attaching listeners/resuming stdin is not sufficient to prevent an early exit.
  const keepalive = setInterval(() => {
    // no-op
  }, 60_000);

  await new Promise<void>((resolve) => {
    const done = () => {
      clearInterval(keepalive);
      resolve();
    };
    stdin.once("end", done);
    stdin.once("close", done);
  });
}
