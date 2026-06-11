import net from "node:net";
import type { ReefEvent } from "../../protocol/events.js";
import type { SessionSummary } from "../../core/types.js";
import type { ControlRequest } from "../../daemon/socket.js";

// The TUI's link to the daemon: newline-JSON over the unix socket — the same
// native event stream and control surface every consumer uses. Non-React on
// purpose; App subscribes via the handler callbacks.

export type ConnStatus = "connecting" | "connected" | "disconnected";

export interface ConnectionHandlers {
  onEvent: (event: ReefEvent) => void;
  onError: (message: string) => void;
  onStatus: (status: ConnStatus) => void;
  /** Snapshot of all sessions (response to listSessions). */
  onSessions?: (sessions: SessionSummary[]) => void;
  /** A session's replayed event history (response to history). */
  onHistory?: (sessionKey: string, events: ReefEvent[]) => void;
}

export class Connection {
  private readonly sock: net.Socket;
  private buffer = "";

  constructor(socketPath: string, private readonly handlers: ConnectionHandlers) {
    this.sock = net.connect(socketPath);
    this.sock.on("connect", () => handlers.onStatus("connected"));
    this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
    this.sock.on("error", (err: NodeJS.ErrnoException) => {
      handlers.onStatus("disconnected");
      handlers.onError(
        err.code === "ENOENT" || err.code === "ECONNREFUSED"
          ? "daemon not running — start it with `npm run daemon`"
          : err.message,
      );
    });
    this.sock.on("close", () => handlers.onStatus("disconnected"));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      // Server → client messages carry a `kind`; live native events do not.
      const tagged = parsed as { kind?: string; error?: string };
      switch (tagged.kind) {
        case "error":
          this.handlers.onError(String(tagged.error ?? "unknown error"));
          continue;
        case "sessions":
          this.handlers.onSessions?.((parsed as { sessions: SessionSummary[] }).sessions);
          continue;
        case "history": {
          const h = parsed as { sessionKey: string; events: ReefEvent[] };
          this.handlers.onHistory?.(h.sessionKey, h.events);
          continue;
        }
        default:
          this.handlers.onEvent(parsed as ReefEvent);
      }
    }
  }

  private write(req: ControlRequest): void {
    this.sock.write(`${JSON.stringify(req)}\n`);
  }

  send(sessionKey: string, message: string): void {
    this.write({ kind: "send", sessionKey, message });
  }
  resolve(approvalId: string, decision: string): void {
    this.write({ kind: "resolve", approvalId, decision });
  }
  stop(sessionKey: string): void {
    this.write({ kind: "stop", sessionKey });
  }
  setModel(sessionKey: string, model: string): void {
    this.write({ kind: "set_model", sessionKey, model });
  }
  listSessions(): void {
    this.write({ kind: "list_sessions" });
  }
  history(sessionKey: string): void {
    this.write({ kind: "history", sessionKey });
  }
  close(): void {
    this.sock.end();
  }
}
