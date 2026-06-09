import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnv } from "../core/env.js";
import type { AgentRecord } from "../core/types.js";
import { Daemon } from "./Daemon.js";
import { startSocketServer } from "./socket.js";

loadEnv();

const STATE_DIR = resolve(".reef");
const SOCKET_PATH = join(STATE_DIR, "reef.sock");
mkdirSync(STATE_DIR, { recursive: true });

// The one v1 agent. "Add an agent" later is another record, not new code.
const DEFAULT_AGENT: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt:
    "You are Reef, an always-on personal agent. Be concise and direct. " +
    "Use the available tools when they help answer the user.",
  model: "claude-opus-4-8",
  toolAllowlist: ["echo", "get_time"],
};

const daemon = new Daemon({
  dbPath: join(STATE_DIR, "reef.db"),
  workspaceDir: join(STATE_DIR, "workspaces"),
});
daemon.registerAgent(DEFAULT_AGENT);

await daemon.recover();

const server = startSocketServer(daemon, SOCKET_PATH, DEFAULT_AGENT.id);
process.stderr.write(`reef daemon listening on ${SOCKET_PATH}\n`);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("\nreef daemon shutting down\n");
  server.close();
  daemon.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
