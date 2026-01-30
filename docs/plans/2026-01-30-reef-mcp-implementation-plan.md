# Reef MCP Orchestrator Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a stdio MCP server in TypeScript/Node.js with adapters for Claude and Codex, spawn/status/send/output/kill tools, normalized events with timestamps, and thin persistence to `./.reef/state.json` (keep last 20 completed jobs).

**Architecture:** A JSON-RPC MCP server routes tool calls to an AgentManager that owns job lifecycle, event streams, and persistence snapshots. Agent-specific logic lives only in adapters, which emit normalized events. Persistence is recovery-only and marks loaded jobs as stale.

**Tech Stack:** Node.js, TypeScript, @modelcontextprotocol/sdk, Vitest.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `src/server.ts`
- Create: `src/config.ts`
- Modify: `.gitignore`

**Step 1: Create minimal package.json**

```json
{
  "name": "reef",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "reef": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests"]
}
```

**Step 3: Create config helper**

```ts
// src/config.ts
export const DEFAULT_STATE_PATH = "./.reef/state.json";
export const MAX_COMPLETED = 20;
export const MAX_EVENT_TAIL = 200;
```

**Step 4: Add .gitignore entries**

```
/dist
/.reef
/node_modules
```

**Step 5: Create src/index.ts**

```ts
import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

**Step 6: Create src/server.ts placeholder**

```ts
export async function startServer(): Promise<void> {
  // Placeholder until server wiring is implemented.
  console.log("reef: server starting");
}
```

**Step 7: Build to validate TypeScript setup**
Run: `npm run build`
Expected: success, no output errors

---

### Task 2: Core types and event model

**Files:**
- Create: `src/types.ts`
- Create: `src/events.ts`
- Test: `tests/events.test.ts`

**Step 1: Write failing test for event timestamps**

```ts
import { describe, expect, it } from "vitest";
import { nowTimestamp, makeEvent } from "../src/events.js";

describe("events", () => {
  it("creates ISO timestamps", () => {
    const ts = nowTimestamp();
    expect(ts).toMatch(/T/);
  });

  it("stamps events", () => {
    const event = makeEvent("started", "job-1", { task: "x" });
    expect(event.timestamp).toBeDefined();
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL with missing module/export

**Step 3: Implement core types**

```ts
// src/types.ts
export type AgentType = "claude" | "codex";
export type SpawnMode = "headless" | "headful";

export type JobStatus =
  | "running"
  | "awaiting_input"
  | "completed"
  | "error"
  | "stale";

export interface Job {
  id: string;
  agent: AgentType;
  mode: SpawnMode;
  task: string;
  cwd: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
}

export type EventType =
  | "started"
  | "progress"
  | "tool_call"
  | "file_edit"
  | "needs_input"
  | "input_sent"
  | "error"
  | "completed";

export interface AgentEvent {
  timestamp: string;
  type: EventType;
  agentId: string;
  payload: Record<string, unknown>;
}
```

**Step 4: Implement event helpers**

```ts
// src/events.ts
import type { AgentEvent, EventType } from "./types.js";

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export function makeEvent(
  type: EventType,
  agentId: string,
  payload: Record<string, unknown>
): AgentEvent {
  return { timestamp: nowTimestamp(), type, agentId, payload };
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 3: Persistence hook

**Files:**
- Create: `src/persistence/fileStore.ts`
- Create: `src/persistence/types.ts`
- Test: `tests/persistence.test.ts`

**Step 1: Write failing test for save/load**

```ts
import { describe, expect, it } from "vitest";
import { FileStore } from "../src/persistence/fileStore.js";

describe("FileStore", () => {
  it("round-trips snapshot", async () => {
    const store = new FileStore("./.reef/test-state.json");
    const snapshot = { jobs: [], completed: [], eventTails: {} };
    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded).toEqual(snapshot);
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL with missing module/export

**Step 3: Implement snapshot types**

```ts
// src/persistence/types.ts
import type { AgentEvent, Job } from "../types.js";

export interface StateSnapshot {
  jobs: Job[];
  completed: Job[];
  eventTails: Record<string, AgentEvent[]>;
}
```

**Step 4: Implement FileStore**

```ts
// src/persistence/fileStore.ts
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { StateSnapshot } from "./types.js";

export class FileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StateSnapshot | null> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      return JSON.parse(raw) as StateSnapshot;
    } catch {
      return null;
    }
  }

  async save(snapshot: StateSnapshot): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 4: Adapter contract and registry

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/registry.ts`
- Test: `tests/adapters/registry.test.ts`

**Step 1: Write failing registry test**

```ts
import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";

describe("AdapterRegistry", () => {
  it("returns registered adapter", () => {
    const registry = new AdapterRegistry();
    registry.register("claude", { name: "claude" } as any);
    expect(registry.get("claude")?.name).toBe("claude");
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL

**Step 3: Implement adapter types**

```ts
// src/adapters/types.ts
import type { ChildProcess } from "node:child_process";
import type { AgentEvent } from "../types.js";

export interface AdapterSpawnOptions {
  task: string;
  cwd: string;
  mode: "headless" | "headful";
}

export interface AgentAdapter {
  name: string;
  spawn(options: AdapterSpawnOptions): ChildProcess;
  parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent>;
  sendInput(proc: ChildProcess, message: string): void;
}
```

**Step 4: Implement AdapterRegistry**

```ts
// src/adapters/registry.ts
import type { AgentAdapter } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(name: string, adapter: AgentAdapter): void {
    this.adapters.set(name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 5: AgentManager, process tracking, and event store

**Files:**
- Create: `src/agent/AgentManager.ts`
- Create: `src/agent/EventStore.ts`
- Create: `src/agent/ids.ts`
- Modify: `src/config.ts`
- Test: `tests/agent/manager.test.ts`

**Step 1: Write failing manager tests**

```ts
import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agent/AgentManager.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

const fakeAdapter = {
  name: "fake",
  spawn: () => ({ stdout: null, stdin: null } as any),
  parseOutput: async function* () {
    yield { timestamp: new Date().toISOString(), type: "needs_input", agentId: "", payload: { question: "Q", options: ["A"] } };
  },
  sendInput: () => {}
};

describe("AgentManager", () => {
  it("marks awaiting_input and clears on send", async () => {
    const registry = new AdapterRegistry();
    registry.register("claude", fakeAdapter as any);
    const manager = new AgentManager(registry);
    const job = manager.createJob("claude", "headless", "task", ".");
    manager.markAwaitingInput(job.id, "Question", ["A", "B"]);
    expect(manager.getJob(job.id)?.status).toBe("awaiting_input");
    manager.clearAwaitingInput(job.id, "hello");
    expect(manager.getJob(job.id)?.status).toBe("running");
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL

**Step 3: Implement id helper and event store**

```ts
// src/agent/ids.ts
let counter = 0;
export function nextId(): string {
  counter += 1;
  return `job-${counter}`;
}
```

```ts
// src/agent/EventStore.ts
import type { AgentEvent } from "../types.js";
import { MAX_EVENT_TAIL } from "../config.js";

export class EventStore {
  private readonly tails = new Map<string, AgentEvent[]>();

  append(jobId: string, event: AgentEvent): void {
    const list = this.tails.get(jobId) ?? [];
    list.push(event);
    if (list.length > MAX_EVENT_TAIL) list.shift();
    this.tails.set(jobId, list);
  }

  getSince(jobId: string, since?: string): AgentEvent[] {
    const list = this.tails.get(jobId) ?? [];
    if (!since) return list;
    return list.filter((event) => event.timestamp > since);
  }

  snapshot(): Record<string, AgentEvent[]> {
    return Object.fromEntries(this.tails.entries());
  }
}
```

**Step 4: Implement AgentManager with process tracking**

```ts
// src/agent/AgentManager.ts
import type { AgentType, Job } from "../types.js";
import { makeEvent } from "../events.js";
import { DEFAULT_STATE_PATH, MAX_COMPLETED } from "../config.js";
import { EventStore } from "./EventStore.js";
import { nextId } from "./ids.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ChildProcess } from "node:child_process";
import { FileStore } from "../persistence/fileStore.js";

export class AgentManager {
  private readonly jobs = new Map<string, Job>();
  private readonly completed: Job[] = [];
  private readonly events = new EventStore();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly store: FileStore;

  constructor(private readonly adapters: AdapterRegistry, store?: FileStore) {
    this.store = store ?? new FileStore(DEFAULT_STATE_PATH);
  }

  createJob(agent: AgentType, mode: "headless" | "headful", task: string, cwd: string): Job {
    const id = nextId();
    const job: Job = {
      id,
      agent,
      mode,
      task,
      cwd,
      status: "running",
      startedAt: new Date().toISOString()
    };
    this.jobs.set(id, job);
    this.events.append(id, makeEvent("started", id, { task, agent }));
    this.saveSnapshot();
    return job;
  }

  listJobs(): Job[] {
    return [...this.jobs.values(), ...this.completed];
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id) ?? this.completed.find((job) => job.id === id);
  }

  markAwaitingInput(id: string, question: string, options?: string[]): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "awaiting_input";
    this.events.append(id, makeEvent("needs_input", id, { question, options }));
    this.saveSnapshot();
  }

  clearAwaitingInput(id: string, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "running";
    this.events.append(id, makeEvent("input_sent", id, { message }));
    this.saveSnapshot();
  }

  attachProcess(id: string, proc: ChildProcess): void {
    this.processes.set(id, proc);
  }

  async consumeEvents(id: string, iterable: AsyncIterable<any>): Promise<void> {
    for await (const event of iterable) {
      const normalized = { ...event, agentId: id, timestamp: event.timestamp ?? new Date().toISOString() };
      if (normalized.type === "needs_input") {
        this.markAwaitingInput(id, normalized.payload.question as string, normalized.payload.options as string[] | undefined);
      } else {
        this.events.append(id, normalized);
      }
    }
  }

  completeJob(id: string, status: "completed" | "error", payload: Record<string, unknown>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = status;
    job.completedAt = new Date().toISOString();
    this.events.append(id, makeEvent(status, id, payload));
    this.jobs.delete(id);
    this.completed.unshift(job);
    if (this.completed.length > MAX_COMPLETED) this.completed.pop();
    this.processes.delete(id);
    this.saveSnapshot();
  }
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 6: Claude and Codex adapters

**Files:**
- Create: `src/adapters/ClaudeAdapter.ts`
- Create: `src/adapters/CodexAdapter.ts`
- Create: `tests/fixtures/claude-stream.jsonl`
- Create: `tests/fixtures/codex.jsonl`
- Test: `tests/adapters/claude.test.ts`
- Test: `tests/adapters/codex.test.ts`

**Step 1: Write failing adapter tests**

```ts
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/ClaudeAdapter.js";

describe("ClaudeAdapter", () => {
  it("parses events and emits needs_input with options", async () => {
    const adapter = new ClaudeAdapter();
    const events = [];
    for await (const event of adapter.parseOutput(readFixture("claude-stream.jsonl"))) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "needs_input")).toBe(true);
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL

**Step 3: Implement ClaudeAdapter**

```ts
// src/adapters/ClaudeAdapter.ts
import { spawn } from "node:child_process";
import { makeEvent } from "../events.js";
import type { AgentAdapter, AdapterSpawnOptions } from "./types.js";
import type { AgentEvent } from "../types.js";

export class ClaudeAdapter implements AgentAdapter {
  name = "claude";

  spawn(options: AdapterSpawnOptions) {
    const args = ["-p", options.task, "-y", "--output-format", "stream-json"];
    return spawn("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  }

  async *parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent> {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const payload = JSON.parse(line) as Record<string, unknown>;
          const type = (payload.type ?? "progress") as any;
          yield makeEvent(type, "", payload);
        }
        index = buffer.indexOf("\n");
      }
    }
  }

  sendInput(proc: any, message: string): void {
    proc.stdin?.write(message + "\n");
  }
}
```

**Step 4: Implement CodexAdapter**

```ts
// src/adapters/CodexAdapter.ts
import { spawn } from "node:child_process";
import { makeEvent } from "../events.js";
import type { AgentAdapter, AdapterSpawnOptions } from "./types.js";
import type { AgentEvent } from "../types.js";

export class CodexAdapter implements AgentAdapter {
  name = "codex";

  spawn(options: AdapterSpawnOptions) {
    const args = ["exec", "--json", "--full-auto", options.task];
    return spawn("codex", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  }

  async *parseOutput(stream: NodeJS.ReadableStream): AsyncIterable<AgentEvent> {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const payload = JSON.parse(line) as Record<string, unknown>;
          const type = (payload.type ?? "progress") as any;
          yield makeEvent(type, "", payload);
        }
        index = buffer.indexOf("\n");
      }
    }
  }

  sendInput(proc: any, message: string): void {
    proc.stdin?.write(message + "\n");
  }
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 7: MCP server wiring

**Files:**
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Create: `src/mcp/tools.ts`
- Test: `tests/mcp/tools.test.ts`

**Step 1: Write failing MCP tool test**

```ts
import { describe, expect, it } from "vitest";
import { buildTools } from "../../src/mcp/tools.js";

describe("MCP tools", () => {
  it("exposes spawn/status/send/output/kill", () => {
    const tools = buildTools({} as any);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["reef:spawn", "reef:status", "reef:send", "reef:output", "reef:kill"]);
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL

**Step 3: Implement tool builders**

```ts
// src/mcp/tools.ts
import type { AgentManager } from "../agent/AgentManager.js";

export function buildTools(manager: AgentManager) {
  return [
    { name: "reef:spawn", handler: async () => ({}) },
    { name: "reef:status", handler: async () => ({}) },
    { name: "reef:send", handler: async () => ({}) },
    { name: "reef:output", handler: async () => ({}) },
    { name: "reef:kill", handler: async () => ({}) }
  ];
}
```

**Step 4: Wire MCP server**

```ts
// src/server.ts
import { StdioServerTransport, McpServer } from "@modelcontextprotocol/sdk";
import { AgentManager } from "./agent/AgentManager.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { ClaudeAdapter } from "./adapters/ClaudeAdapter.js";
import { CodexAdapter } from "./adapters/CodexAdapter.js";
import { buildTools } from "./mcp/tools.js";

export async function startServer(): Promise<void> {
  const registry = new AdapterRegistry();
  registry.register("claude", new ClaudeAdapter());
  registry.register("codex", new CodexAdapter());
  const manager = new AgentManager(registry);
  await manager.loadSnapshot();

  const server = new McpServer({ name: "reef", version: "0.1.0" });
  const tools = buildTools(manager);
  for (const tool of tools) server.tool(tool.name, tool.handler);

  const transport = new StdioServerTransport();
  server.connect(transport);
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 8: Implement tool handlers and persistence integration

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/agent/AgentManager.ts`
- Modify: `src/persistence/fileStore.ts`
- Test: `tests/agent/manager.test.ts`
- Test: `tests/mcp/tools.test.ts`

**Step 1: Write failing tests for awaiting_input and output slicing**

```ts
import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agent/AgentManager.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

describe("AgentManager events", () => {
  it("returns events after timestamp", () => {
    const manager = new AgentManager(new AdapterRegistry());
    const job = manager.createJob("claude", "headless", "task", ".");
    const all = manager.getEvents(job.id);
    const since = all[0].timestamp;
    const after = manager.getEvents(job.id, since);
    expect(after.length).toBe(0);
  });
});
```

**Step 2: Run tests to verify failure**
Run: `npm test`
Expected: FAIL

**Step 3: Implement manager methods used by tools and persistence**

```ts
// Add to src/agent/AgentManager.ts
getEvents(id: string, since?: string) {
  return this.events.getSince(id, since);
}

async spawn(agent: AgentType, mode: "headless" | "headful", task: string, cwd: string): Promise<Job> {
  const adapter = this.adapters.get(agent);
  if (!adapter) throw new Error(`Unknown agent: ${agent}`);
  const job = this.createJob(agent, mode, task, cwd);
  const proc = adapter.spawn({ task, cwd, mode });
  this.attachProcess(job.id, proc);
  if (proc.stdout) {
    void this.consumeEvents(job.id, adapter.parseOutput(proc.stdout));
  }
  proc.on("exit", (code) => {
    const status = code === 0 ? "completed" : "error";
    this.completeJob(job.id, status, { exitCode: code });
  });
  return job;
}

send(agentId: string, message: string): void {
  const job = this.jobs.get(agentId);
  if (!job) return;
  const adapter = this.adapters.get(job.agent);
  const proc = this.processes.get(agentId);
  if (!adapter || !proc) return;
  adapter.sendInput(proc, message);
  this.clearAwaitingInput(agentId, message);
}

kill(agentId: string): void {
  const proc = this.processes.get(agentId);
  if (proc) proc.kill();
  this.completeJob(agentId, "completed", { reason: "killed" });
}

async loadSnapshot(): Promise<void> {
  const snapshot = await this.store.load();
  if (!snapshot) return;
  for (const job of snapshot.jobs) {
    this.jobs.set(job.id, { ...job, status: "stale" });
  }
  for (const job of snapshot.completed) {
    this.completed.push(job);
  }
  for (const [id, events] of Object.entries(snapshot.eventTails)) {
    for (const event of events) this.events.append(id, event);
  }
}

private saveSnapshot(): void {
  void this.store.save({
    jobs: [...this.jobs.values()],
    completed: this.completed.slice(0, MAX_COMPLETED),
    eventTails: this.events.snapshot()
  });
}
```

**Step 4: Implement tool handlers**

```ts
// src/mcp/tools.ts
export function buildTools(manager: AgentManager) {
  return [
    {
      name: "reef:spawn",
      handler: async (args: any) => {
        const job = await manager.spawn(args.agent, args.mode ?? "headless", args.task, args.cwd ?? ".");
        return { agentId: job.id, status: job.status };
      }
    },
    {
      name: "reef:status",
      handler: async (args: any) => {
        if (args?.agentId) return { agents: [manager.getJob(args.agentId)] };
        return { agents: manager.listJobs() };
      }
    },
    {
      name: "reef:send",
      handler: async (args: any) => {
        manager.send(args.agentId, args.message);
        return { ok: true };
      }
    },
    {
      name: "reef:output",
      handler: async (args: any) => {
        return { events: manager.getEvents(args.agentId, args.since) };
      }
    },
    {
      name: "reef:kill",
      handler: async (args: any) => {
        manager.kill(args.agentId);
        return { ok: true };
      }
    }
  ];
}
```

**Step 5: Run tests to verify pass**
Run: `npm test`
Expected: PASS

---

### Task 9: Documentation

**Files:**
- Create: `README.md`

**Step 1: Add README with usage**

```md
# Reef MCP Server

Run locally:

```

npm install
npm run dev

```

Configure MCP client to execute `node dist/index.js` after build.
```

**Step 2: No tests**

---

### Task 10: Final verification

**Step 1: Install dependencies**
Run: `npm install`
Expected: success

**Step 2: Run tests**
Run: `npm test`
Expected: PASS

**Step 3: Build**
Run: `npm run build`
Expected: PASS
