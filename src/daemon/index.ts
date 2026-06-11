import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "../core/env.js";
import type { AgentRecord } from "../core/types.js";
import { startHttpInterface } from "../interface/http.js";
import { Daemon } from "./Daemon.js";
import { attachRunLogger } from "./log.js";
import { startSocketServer } from "./socket.js";

loadEnv();

const STATE_DIR = resolve(".reef");
const SOCKET_PATH = join(STATE_DIR, "reef.sock");
const HTTP_PORT = Number(process.env.REEF_HTTP_PORT ?? 9876);
const HTTP_API_KEY = process.env.REEF_API_KEY || undefined;
// Self-maintenance heartbeat cadence; 0 / unset = no heartbeat (opt-in).
const HEARTBEAT_MINUTES = Number(process.env.REEF_HEARTBEAT_MINUTES ?? 0);
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
    "You can schedule your own future wakes with schedule (a one-shot like 'check " +
    "back tomorrow at 9am' or a recurring routine), review them with list_schedules, " +
    "and drop one with cancel_schedule. " +
    "You can inspect your own operational state with list_runs, list_sessions, and " +
    "list_triggers. " +
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
    "schedule",
    "list_schedules",
    "cancel_schedule",
    "list_runs",
    "list_sessions",
    "list_triggers",
  ],
};

const daemon = new Daemon({
  dbPath: join(STATE_DIR, "reef.db"),
  workspaceDir: join(STATE_DIR, "workspaces"),
});
daemon.registerAgent(DEFAULT_AGENT);

// Structured run-lifecycle logging to stderr (set REEF_LOG=off to silence) — so
// background/proactive runs are observable, not just rows in SQLite.
if (process.env.REEF_LOG !== "off") attachRunLogger(daemon);

await daemon.recover();
daemon.start(); // begin firing scheduled triggers
if (HEARTBEAT_MINUTES > 0) {
  daemon.ensureHeartbeat({
    agentId: DEFAULT_AGENT.id,
    intervalSeconds: HEARTBEAT_MINUTES * 60,
  });
}

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
