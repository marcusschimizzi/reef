import net from "node:net";
import readline from "node:readline";
import { join, resolve } from "node:path";
import { nowMs } from "../core/time.js";
import type { ReefEvent } from "../protocol/events.js";

// A throwaway dev client: connect to the daemon, type messages, watch the
// native event stream render. It speaks the same daemon interface the real UI
// (conch) adapter will — nothing here is a one-off protocol.

const SOCKET_PATH = join(resolve(".reef"), "reef.sock");
const sessionKey = `cli:${nowMs()}`;

const sock = net.connect(SOCKET_PATH);

sock.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
    process.stderr.write(
      `Could not reach the reef daemon at ${SOCKET_PATH}.\n` +
        `Start it first with:  npm run daemon\n`,
    );
  } else {
    process.stderr.write(`socket error: ${err.message}\n`);
  }
  process.exit(1);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

sock.on("connect", () => {
  process.stdout.write("Connected to reef. Type a message (Ctrl-C to quit).\n\n");
  rl.setPrompt("> ");
  rl.prompt();
});

// ── render the native event stream ──────────────────────────────────────────
let buffer = "";
sock.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) render(line);
  }
});

function render(line: string): void {
  let event: ReefEvent | { kind: "error"; error: string };
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if ("kind" in event && event.kind === "error") {
    process.stdout.write(`\n[error] ${event.error}\n`);
    rl.prompt();
    return;
  }
  const e = event as ReefEvent;
  if (e.sessionKey !== sessionKey) return; // ignore other sessions

  switch (e.type) {
    case "message.delta":
      process.stdout.write(e.text);
      break;
    case "tool.requested":
      process.stdout.write(`\n  ⚙ ${e.name}(${JSON.stringify(e.input)})\n`);
      break;
    case "tool.completed":
      process.stdout.write(`  ✓ ${JSON.stringify(e.output)}\n`);
      break;
    case "tool.failed":
      process.stdout.write(`  ✗ ${e.error}\n`);
      break;
    case "run.completed":
      process.stdout.write("\n\n");
      rl.prompt();
      break;
    case "run.failed":
      process.stdout.write(`\n[run failed] ${e.error}\n`);
      rl.prompt();
      break;
    default:
      break;
  }
}

rl.on("line", (input: string) => {
  const message = input.trim();
  if (!message) {
    rl.prompt();
    return;
  }
  sock.write(`${JSON.stringify({ kind: "send", sessionKey, message })}\n`);
  // prompt re-appears on run.completed / run.failed
});

rl.on("close", () => {
  sock.end();
  process.exit(0);
});
