import { beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverPath = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

async function runBuild() {
  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn("npm", ["run", "build"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("error", (error) => reject(error));
    proc.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`build failed (code=${code} signal=${signal})\n${stdout}\n${stderr}`));
      }
    });
  });
}

function sendJson(stream: NodeJS.WritableStream, msg: unknown) {
  stream.write(`${JSON.stringify(msg)}\n`);
}

function createMessageReader(
  stream: NodeJS.ReadableStream,
  opts: {
    getDiagnostics: () => string;
  }
) {
  const rl = createInterface({ input: stream });
  const queue: any[] = [];
  let resolver: ((value: any) => void) | null = null;
  let rejecter: ((error: Error) => void) | null = null;
  let closed = false;

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (resolver) {
        resolver(parsed);
        resolver = null;
        rejecter = null;
      } else {
        queue.push(parsed);
      }
    } catch {
      // Ignore non-JSON lines (warnings, logs).
    }
  });

  rl.on("close", () => {
    closed = true;
    if (rejecter) {
      rejecter(new Error(`stream closed before response\n${opts.getDiagnostics()}`));
    }
  });

  rl.on("error", (error) => {
    if (rejecter) {
      rejecter(error instanceof Error ? error : new Error(String(error)));
    }
  });

  return {
    readNextJson: async (timeoutMs = 2000): Promise<any> => {
      if (queue.length > 0) return queue.shift();
      if (closed) throw new Error(`stream closed before response\n${opts.getDiagnostics()}`);
      return new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => {
          rejectPromise(new Error(`no response\n${opts.getDiagnostics()}`));
        }, timeoutMs);
        const cleanup = () => clearTimeout(timeout);
        resolver = (value) => {
          cleanup();
          resolvePromise(value);
        };
        rejecter = (error) => {
          cleanup();
          rejectPromise(error);
        };
      });
    },
    close: () => rl.close()
  };
}

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  await runBuild();
});

describe("stdio smoke", () => {
  it(
    "initializes and calls reef:status",
    async () => {
      // Run the built server, but ask Node to tell us why it exits.
      const proc = spawn(process.execPath, ["--trace-uncaught", "--trace-exit", serverPath], {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let exited = false;
      proc.on("exit", (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
      });

      proc.on("error", (err) => {
        stderr += `\n(proc error) ${String(err)}`;
      });

      const getDiagnostics = () => {
        return [
          `serverPath=${serverPath}`,
          `cwd=${projectRoot}`,
          `exited=${exited}`,
          `exitCode=${exitCode}`,
          `exitSignal=${exitSignal}`,
          stderr ? `stderr:\n${stderr}` : "stderr:(empty)"
        ].join("\n");
      };

      const { readNextJson, close } = createMessageReader(proc.stdout!, { getDiagnostics });

      // If stdout closes before we get a response, wait a tick for the exit event
      // so we capture the true exitCode/signal.
      const readNextJsonWithExitWait = async (timeoutMs = 2000) => {
        try {
          return await readNextJson(timeoutMs);
        } catch (e) {
          await delay(150);
          throw e;
        }
      };

      sendJson(proc.stdin!, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "reef-test", version: "0.0.0" }
        }
      });

      const initResponse = await readNextJsonWithExitWait(5000);
      expect(initResponse.id).toBe(1);

      sendJson(proc.stdin!, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      });

      sendJson(proc.stdin!, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "reef:status", arguments: {} }
      });

      const statusResponse = await readNextJsonWithExitWait(5000);
      expect(statusResponse.id).toBe(2);
      expect(statusResponse.result?.structuredContent?.agents).toBeDefined();

      proc.kill();
      close();
    },
    20000
  );
});
