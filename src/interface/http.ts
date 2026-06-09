import http from "node:http";
import type { Daemon } from "../daemon/Daemon.js";
import { ConchProjector } from "./adapters/conch.js";

// Reef's HTTP + SSE interface — the front door consumers like conch attach to
// (the dev CLI keeps using the unix socket). Control is plain JSON over POST;
// the event stream is SSE carrying conch-projected frames. The projection lives
// here, in reef, so a consumer's backend is a thin pipe and never depends on
// reef's native protocol internals.

export interface HttpInterfaceOptions {
  port: number;
  defaultAgentId: string;
  /** If set, requests must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

export function startHttpInterface(
  daemon: Daemon,
  opts: HttpInterfaceOptions,
): http.Server {
  const server = http.createServer((req, res) => {
    handle(daemon, opts, req, res).catch((err: unknown) => {
      sendJson(res, 500, { ok: false, error: String(err) });
    });
  });
  server.listen(opts.port);
  return server;
}

async function handle(
  daemon: Daemon,
  opts: HttpInterfaceOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true });
  }

  if (opts.apiKey && !authorized(req, opts.apiKey)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  if (method === "GET" && path === "/v1/events") {
    return streamEvents(daemon, req, res);
  }

  if (method === "POST" && path === "/v1/messages") {
    const body = await readJson(req);
    const sessionKey = str(body.sessionKey);
    const message = str(body.message);
    if (!sessionKey || !message) {
      return sendJson(res, 400, { ok: false, error: "sessionKey and message required" });
    }
    const agentId = str(body.agentId) || opts.defaultAgentId;
    // fire-and-forget: progress + errors arrive on the SSE stream
    void daemon.submit({ sessionKey, agentId, message });
    return sendJson(res, 202, { ok: true });
  }

  if (method === "POST" && path === "/v1/stop") {
    const body = await readJson(req);
    const sessionKey = str(body.sessionKey);
    const cancelled = sessionKey ? daemon.cancel(sessionKey) : false;
    return sendJson(res, 200, { ok: true, cancelled });
  }

  const approval = path.match(/^\/v1\/approvals\/([^/]+)\/resolve$/);
  if (method === "POST" && approval) {
    const body = await readJson(req);
    const id = decodeURIComponent(approval[1] ?? "");
    const decision = str(body.decision) || "deny";
    const ok = daemon.resolveApproval(id, decision);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

function streamEvents(
  daemon: Daemon,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const projector = new ConchProjector();
  const unsubscribe = daemon.subscribe((event) => {
    for (const frame of projector.project(event)) {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function authorized(req: http.IncomingMessage, apiKey: string): boolean {
  const auth = req.headers.authorization;
  return auth === `Bearer ${apiKey}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
