import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "../core/env.js";
import type { AgentRecord } from "../core/types.js";
import { startHttpInterface } from "../interface/http.js";
import { Daemon } from "./Daemon.js";
import { startSocketServer } from "./socket.js";

loadEnv();

const STATE_DIR = resolve(".reef");
const SOCKET_PATH = join(STATE_DIR, "reef.sock");
const HTTP_PORT = Number(process.env.REEF_HTTP_PORT ?? 9876);
const HTTP_API_KEY = process.env.REEF_API_KEY || undefined;
mkdirSync(STATE_DIR, { recursive: true });

// The one v1 agent. "Add an agent" later is another record, not new code.
const DEFAULT_AGENT: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt:
    "You are Reef, an always-on personal agent. Be concise and direct. " +
    "You have a workspace you can read and write files in (read_file, write_file, " +
    "edit_file, list_files) — those paths are relative to that workspace. You can " +
    "also run shell commands (shell), which require human approval before each run. " +
    "You have a durable cross-session memory: use record_memory to save lasting " +
    "facts, preferences, and decisions, and recall_memory to look them up before " +
    "answering when prior context would help. " +
    "Use the available tools when they help accomplish the task.",
  model: "claude-opus-4-8",
  toolAllowlist: [
    "echo",
    "get_time",
    "read_file",
    "write_file",
    "edit_file",
    "list_files",
    "shell",
    "recall_memory",
    "record_memory",
  ],
};

const daemon = new Daemon({
  dbPath: join(STATE_DIR, "reef.db"),
  workspaceDir: join(STATE_DIR, "workspaces"),
});
daemon.registerAgent(DEFAULT_AGENT);

await daemon.recover();

const server = startSocketServer(daemon, SOCKET_PATH, DEFAULT_AGENT.id);
const httpServer = startHttpInterface(daemon, {
  port: HTTP_PORT,
  defaultAgentId: DEFAULT_AGENT.id,
  apiKey: HTTP_API_KEY,
});
process.stderr.write(
  `reef daemon listening on ${SOCKET_PATH} and http://127.0.0.1:${HTTP_PORT}\n`,
);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("\nreef daemon shutting down\n");
  server.close();
  httpServer.close();
  daemon.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
