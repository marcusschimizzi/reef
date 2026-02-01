# Reef MCP Phase 2 Integration Readiness Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Reef integration-ready by adding a JSON-RPC stdio smoke test, adding a `reef:info` tool for health checks, and ensuring tests pass with TDD.

**Architecture:** Add a small info surface to the MCP tool set and add an integration test that spawns the server over stdio and exercises initialization + `tools/call`. Keep protocol framing aligned to SDK’s newline-delimited JSON.

**Tech Stack:** Node.js, TypeScript, Vitest, @modelcontextprotocol/sdk, Zod.

---

### Task 1: Add `reef:info` tool schema + test

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/server.ts`
- Modify: `tests/mcp/tools.test.ts`
- Create: `tests/mcp/info.test.ts`
- Modify: `src/adapters/registry.ts`

**Step 1: Write failing tool list test**

```ts
import { describe, expect, it } from "vitest";
import { buildTools } from "../../src/mcp/tools.js";

describe("MCP tools", () => {
  it("exposes spawn/status/send/output/kill/info", () => {
    const tools = buildTools({} as any, { version: "0.0.0", adapters: [], startedAt: 0 });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "reef:spawn",
      "reef:status",
      "reef:send",
      "reef:output",
      "reef:kill",
      "reef:info"
    ]);
  });
});
```

**Step 2: Run test to verify failure**
Run: `npm test tests/mcp/tools.test.ts`
Expected: FAIL with missing reef:info

**Step 3: Write failing info response test**

```ts
import { describe, expect, it } from "vitest";
import { buildTools } from "../../src/mcp/tools.js";

function getTool(tools: any[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error("tool not found");
  return tool;
}

describe("reef:info", () => {
  it("returns version, adapters, uptimeMs", async () => {
    const tools = buildTools({} as any, { version: "0.1.0", adapters: ["claude"], startedAt: 0 });
    const info = await getTool(tools, "reef:info").handler({});
    expect(info.structuredContent).toMatchObject({
      version: "0.1.0",
      adapters: ["claude"]
    });
    expect(typeof info.structuredContent.uptimeMs).toBe("number");
  });
});
```

**Step 4: Run test to verify failure**
Run: `npm test tests/mcp/info.test.ts`
Expected: FAIL with missing tool

**Step 5: Implement `reef:info` tool + registry adapter list**

```ts
// src/adapters/registry.ts
list(): string[] {
  return [...this.adapters.keys()];
}
```

```ts
// src/mcp/tools.ts
const infoSchema = z.object({});

export function buildTools(manager: AgentManager, info: { version: string; adapters: string[]; startedAt: number }) {
  // ... existing tools
  defineTool({
    name: "reef:info",
    description: "Return server version, adapters, and uptime.",
    inputSchema: infoSchema,
    handler: async () => {
      return wrapResult({
        version: info.version,
        adapters: info.adapters,
        uptimeMs: Date.now() - info.startedAt
      });
    }
  });
}
```

**Step 6: Wire info into server**

```ts
// src/server.ts
const startedAt = Date.now();
const info = { version: "0.1.0", adapters: registry.list(), startedAt };
const tools = buildTools(manager, info);
```

**Step 7: Run tests to verify pass**
Run: `npm test tests/mcp/tools.test.ts tests/mcp/info.test.ts`
Expected: PASS

---

### Task 2: Add stdio JSON-RPC smoke test

**Files:**
- Create: `tests/integration/stdio.test.ts`

**Step 1: Write failing smoke test**

```ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types";
import { resolve } from "node:path";

function sendJson(proc: ReturnType<typeof spawn>, msg: unknown) {
  proc.stdin?.write(JSON.stringify(msg) + "\n");
}

async function readNextJson(lines: AsyncIterable<string>): Promise<any> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    return JSON.parse(line);
  }
  throw new Error("no response");
}

describe("stdio smoke", () => {
  it("initializes and calls reef:status", async () => {
    const tsxPath = resolve("node_modules/tsx/dist/cli.mjs");
    const proc = spawn(process.execPath, [tsxPath, "src/index.ts"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const rl = createInterface({ input: proc.stdout! });
    const lines = rl[Symbol.asyncIterator]();

    sendJson(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "reef-test", version: "0.0.0" }
      }
    });

    const initResponse = await readNextJson(lines);
    expect(initResponse.id).toBe(1);

    sendJson(proc, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });

    sendJson(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "reef:status", arguments: {} }
    });

    const statusResponse = await readNextJson(lines);
    expect(statusResponse.id).toBe(2);
    expect(statusResponse.result?.structuredContent?.agents).toBeDefined();

    proc.kill();
    await once(proc, "exit");
    rl.close();
  });
});
```

**Step 2: Run test to verify failure**
Run: `npm test tests/integration/stdio.test.ts`
Expected: FAIL (server not started / tool not found / protocol mismatch)

**Step 3: Minimal fixes to make test pass**
- Ensure `src/index.ts` starts server with stdio transport (already in place).
- Update imports if needed to keep `@modelcontextprotocol/sdk/types` usable.

**Step 4: Run test to verify pass**
Run: `npm test tests/integration/stdio.test.ts`
Expected: PASS

---

### Task 3: Final verification

**Step 1: Run full test suite**
Run: `npm test`
Expected: PASS

**Step 2: Build**
Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/integration/stdio.test.ts src/mcp/tools.ts src/server.ts src/adapters/registry.ts tests/mcp/tools.test.ts tests/mcp/info.test.ts
 git commit -m "feat: add integration smoke test and info tool"
```
