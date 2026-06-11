import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/Daemon.js";
import { startSocketServer } from "../src/daemon/socket.js";
import type { ModelRouter, ModelTurn } from "../src/model/router.js";

const dir = mkdtempSync(join(tmpdir(), "reef-smoke-"));
const noop: ModelRouter = { async generateTurn(): Promise<ModelTurn> { return { stop: "completed", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 } }; } };
const daemon = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router: noop });
daemon.registerAgent({ id: "reef", name: "Reef", systemPrompt: "x", model: "fake", toolAllowlist: [] });
const sockPath = join(dir, "reef.sock");
startSocketServer(daemon, sockPath, "reef");

// seed one session by processing a wake (no tools, completes in one turn)
await daemon.submit({ sessionKey: "cli:smoke", agentId: "reef", message: "hello reef" });

await new Promise((r) => setTimeout(r, 100));
const sock = net.connect(sockPath);
let buf = "";
const got: any[] = [];
sock.on("data", (c) => {
  buf += c.toString();
  let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (l.trim()) got.push(JSON.parse(l)); }
});
sock.on("connect", () => { sock.write(JSON.stringify({ kind: "list_sessions" }) + "\n"); sock.write(JSON.stringify({ kind: "history", sessionKey: "cli:smoke" }) + "\n"); });
await new Promise((r) => setTimeout(r, 200));

const sessions = got.find((m) => m.kind === "sessions");
const history = got.find((m) => m.kind === "history");
console.log("sessions reply:", JSON.stringify(sessions?.sessions?.map((s: any) => ({ key: s.sessionKey, title: s.title, status: s.status, preview: s.preview })), null, 0));
console.log("history event types:", history?.events?.map((e: any) => e.type).join(", "));
sock.end(); daemon.close(); process.exit(0);
