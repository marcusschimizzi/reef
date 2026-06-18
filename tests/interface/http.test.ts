import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Daemon } from "../../src/daemon/Daemon.js";
import { startHttpInterface, type HttpInterfaceOptions } from "../../src/interface/http.js";
import type { ModelRouter } from "../../src/model/router.js";

const dirs: string[] = [];
const servers: Server[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of daemons.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const router: ModelRouter = {
  async generateTurn() {
    return { stop: "completed", content: [{ type: "text", text: "ok" }], usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

async function startServer(opts: Partial<HttpInterfaceOptions> = {}): Promise<{ base: string; address: string; server: Server }> {
  const dir = mkdtempSync(join(tmpdir(), "reef-http-"));
  dirs.push(dir);
  const daemon = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router });
  daemon.registerAgent({ id: "reef", name: "Reef", systemPrompt: "x", model: "fake", toolAllowlist: [] });
  daemons.push(daemon);
  const server = startHttpInterface(daemon, { port: 0, defaultAgentId: "reef", ...opts });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, address: addr.address, server };
}

describe("http interface — network exposure hardening (RF-01)", () => {
  it("binds to loopback only, not all interfaces", async () => {
    const { address } = await startServer();
    expect(address).toBe("127.0.0.1");
  });

  it("rejects a request carrying a disallowed Origin (cross-origin browser page)", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("accepts a request with no Origin header (non-browser client like conch/curl)", async () => {
    const { base } = await startServer();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts an explicitly allowed Origin", async () => {
    const { base } = await startServer({ allowedOrigins: ["http://localhost:7878"] });
    const res = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:7878" } });
    expect(res.status).toBe(200);
  });
});
