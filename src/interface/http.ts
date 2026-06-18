import http from "node:http";
import type { Daemon } from "../daemon/Daemon.js";
import type { RunStatus, TriggerSpec } from "../core/types.js";
import { ConchProjector } from "./adapters/conch.js";

// Reef's HTTP + SSE interface — the front door consumers like conch attach to
// (the dev CLI keeps using the unix socket). Control is plain JSON over POST;
// the event stream is SSE carrying conch-projected frames. The projection lives
// here, in reef, so a consumer's backend is a thin pipe and never depends on
// reef's native protocol internals.

export interface HttpInterfaceOptions {
  port: number;
  defaultAgentId: string;
  /**
   * Host to bind. Defaults to `127.0.0.1` (loopback) — the daemon runs shell
   * commands and resolves approvals, so it must NOT be reachable from the LAN by
   * default. Binding a routable address is a separate, deliberate choice.
   */
  host?: string;
  /** If set, requests must carry `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /**
   * Origins permitted to call the daemon from a browser. A request carrying any
   * `Origin` header not in this list is rejected — part of the DNS-rebinding / CSRF
   * defense. Non-browser clients (conch's server-side SSE pipe, curl) send no Origin
   * and are unaffected. Defaults to none allowed.
   */
  allowedOrigins?: string[];
  /**
   * Host header values permitted in addition to loopback names. The daemon binds
   * loopback, so a legitimate client addresses it as `localhost`/`127.0.0.1`/`[::1]`;
   * a `Host` pointing at any other name means a DNS-rebound attacker domain resolving
   * to 127.0.0.1 — rejected. This closes the rebinding hole the Origin check misses,
   * since a same-origin no-cors GET (e.g. EventSource) carries no Origin header. Set
   * this only when deliberately binding a routable address.
   */
  allowedHosts?: string[];
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
  server.listen(opts.port, opts.host ?? "127.0.0.1");
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

  // DNS-rebinding defense: the daemon binds loopback, so a legitimate caller's Host
  // is a loopback name. A Host pointing elsewhere is an attacker domain rebound to
  // 127.0.0.1. This also covers the case the Origin check below misses — a same-origin
  // no-cors GET (EventSource/simple fetch) carries no Origin header.
  if (!isAllowedHost(req.headers.host, opts.allowedHosts)) {
    return sendJson(res, 403, { ok: false, error: "forbidden host" });
  }

  // CSRF defense: a browser always sends Origin on cross-origin (and same-origin
  // non-GET) requests; reject any Origin we didn't allow. Clients that send no Origin
  // (server-side fetch, curl) are unaffected.
  const origin = req.headers.origin;
  if (origin !== undefined && !(typeof origin === "string" && (opts.allowedOrigins ?? []).includes(origin))) {
    return sendJson(res, 403, { ok: false, error: "forbidden origin" });
  }

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

  if (path === "/v1/triggers") {
    if (method === "GET") {
      const agentId = url.searchParams.get("agentId") || undefined;
      return sendJson(res, 200, { ok: true, triggers: daemon.listTriggers(agentId) });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const spec = body.spec as TriggerSpec | undefined;
      const instruction = str(body.input);
      if (!spec || !instruction) {
        return sendJson(res, 400, { ok: false, error: "spec and input required" });
      }
      const agentId = str(body.agentId) || opts.defaultAgentId;
      try {
        const trigger = daemon.createTrigger({
          agentId,
          spec,
          input: instruction,
          catchUpPolicy: body.catchUpPolicy === "skip" ? "skip" : "fire_once",
        });
        return sendJson(res, 201, { ok: true, trigger });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err) });
      }
    }
  }

  if (method === "GET" && path === "/v1/actions") {
    const runId = url.searchParams.get("runId") || undefined;
    const agentId = url.searchParams.get("agentId") || undefined;
    return sendJson(res, 200, { ok: true, actions: daemon.listActions({ runId, agentId }) });
  }

  if (method === "GET" && path === "/v1/runs") {
    const status = url.searchParams.get("status");
    if (status === "awaiting_approval") {
      return sendJson(res, 200, { ok: true, runs: daemon.runsAwaitingApproval() });
    }
    return sendJson(res, 200, { ok: true, runs: daemon.listRuns({ status: asRunStatus(status) }) });
  }

  const triggerToggle = path.match(/^\/v1\/triggers\/([^/]+)\/(enable|disable)$/);
  if (method === "POST" && triggerToggle) {
    const id = decodeURIComponent(triggerToggle[1] ?? "");
    const ok = daemon.setTriggerEnabled(id, triggerToggle[2] === "enable");
    return sendJson(res, ok ? 200 : 404, { ok });
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
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Strip a trailing `:port` from a Host header, preserving an IPv6 `[..]` literal. */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const close = hostHeader.indexOf("]");
    return close >= 0 ? hostHeader.slice(0, close + 1) : hostHeader;
  }
  const colon = hostHeader.lastIndexOf(":");
  return colon >= 0 ? hostHeader.slice(0, colon) : hostHeader;
}

function isAllowedHost(hostHeader: string | undefined, extra: string[] = []): boolean {
  // No Host header at all (HTTP/1.0, some tools) — not a browser rebinding vector.
  if (hostHeader === undefined) return true;
  const name = hostnameOf(hostHeader).toLowerCase();
  if (LOOPBACK_HOSTS.has(name)) return true;
  return extra.some((h) => h.toLowerCase() === name || h.toLowerCase() === hostHeader.toLowerCase());
}

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

const RUN_STATUSES: readonly RunStatus[] = ["running", "suspended", "completed", "failed"];
function asRunStatus(v: string | null): RunStatus | undefined {
  return v && (RUN_STATUSES as readonly string[]).includes(v) ? (v as RunStatus) : undefined;
}
