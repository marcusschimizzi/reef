import net from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Daemon } from "./Daemon.js";

// Newline-delimited JSON over a Unix domain socket. Clients (the dev CLI now;
// the conch adapter later) connect, subscribe to the native event stream, and
// send control requests. The same daemon interface backs every consumer.

/** Client → daemon control messages over the socket. */
export type ControlRequest =
  | { kind: "send"; sessionKey: string; agentId?: string; message: string }
  | { kind: "resolve"; approvalId: string; decision: string }
  | { kind: "stop"; sessionKey: string }
  // retarget a session to a different model (the TUI `/model` picker).
  | { kind: "set_model"; sessionKey: string; model: string }
  // sessions view (Phase 4c TUI): snapshot the session list, or replay one
  // session's event history to rebuild its transcript on open.
  | { kind: "list_sessions" }
  | { kind: "history"; sessionKey: string }
  | { kind: "coding_start"; directory: string; task: string; agentKind?: string }
  | { kind: "coding_send"; codingSessionId: string; data: string }
  | { kind: "coding_cancel"; codingSessionId: string };

export function startSocketServer(
  daemon: Daemon,
  socketPath: string,
  defaultAgentId: string,
): net.Server {
  mkdirSync(dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true }); // clear a stale socket from a prior run

  const server = net.createServer((sock) => {
    // every client receives the full native event stream (one session in v1)
    const unsubscribe = daemon.subscribe((event) => {
      sock.write(`${JSON.stringify(event)}\n`);
    });

    let buffer = "";
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        handleLine(daemon, sock, line, defaultAgentId);
      }
    });

    const cleanup = () => unsubscribe();
    sock.on("close", cleanup);
    sock.on("error", cleanup);
  });

  server.listen(socketPath);
  return server;
}

function handleLine(
  daemon: Daemon,
  sock: net.Socket,
  line: string,
  defaultAgentId: string,
): void {
  let req: ControlRequest;
  try {
    req = JSON.parse(line) as ControlRequest;
  } catch {
    sock.write(`${JSON.stringify({ kind: "error", error: "invalid JSON" })}\n`);
    return;
  }
  switch (req.kind) {
    case "send":
      daemon
        .submit({
          sessionKey: req.sessionKey,
          agentId: req.agentId ?? defaultAgentId,
          message: req.message,
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          sock.write(`${JSON.stringify({ kind: "error", error })}\n`);
        });
      break;
    case "resolve":
      daemon.resolveApproval(req.approvalId, req.decision);
      break;
    case "stop":
      daemon.cancel(req.sessionKey);
      break;
    case "set_model": {
      const error = daemon.setSessionModel(req.sessionKey, defaultAgentId, req.model);
      if (error) sock.write(`${JSON.stringify({ kind: "error", error })}\n`);
      break;
    }
    case "list_sessions":
      sock.write(`${JSON.stringify({ kind: "sessions", sessions: daemon.listSessions() })}\n`);
      break;
    case "history":
      sock.write(
        `${JSON.stringify({ kind: "history", sessionKey: req.sessionKey, events: daemon.getHistory(req.sessionKey) })}\n`,
      );
      break;
    case "coding_start": {
      const id = daemon.startCodingSession({ agentKind: req.agentKind ?? "claude-code", directory: req.directory, task: req.task });
      sock.write(`${JSON.stringify({ kind: "coding_started", codingSessionId: id })}\n`);
      break;
    }
    case "coding_send":
      daemon.sendToCodingSession(req.codingSessionId, req.data);
      break;
    case "coding_cancel":
      daemon.cancelCodingSession(req.codingSessionId);
      break;
  }
}
