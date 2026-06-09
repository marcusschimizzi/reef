import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newRunId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { AgentRecord, ApprovalStatus, Run } from "../core/types.js";
import { Spine } from "../db/spine.js";
import { BoundFs } from "../fs/capability.js";
import { runAgentLoop, type LoopOptions } from "../loop/AgentLoop.js";
import { VercelRouter, type ModelRouter } from "../model/router.js";
import type { MemoryStore } from "../memory/seam.js";
import { SqliteMemory } from "../memory/sqlite.js";
import { builtinTools } from "../tools/builtins.js";
import { fileTools } from "../tools/files.js";
import { shellTools } from "../tools/shell.js";
import { memoryTools } from "../tools/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import { EventSink } from "./sink.js";
import { Inbox } from "./inbox.js";

/** How the daemon obtains an agent's memory store — swap this to plug in a
 *  different backend (e.g. a hybrid semantic store) behind the same seam. */
export type MemoryFactory = (agentId: string) => MemoryStore;

export interface DaemonOptions {
  dbPath: string;
  workspaceDir: string;
  /** Injectable for tests; defaults to the real provider-routing layer. */
  router?: ModelRouter;
  maxSteps?: number;
  /** Memory backend factory; defaults to the SQLite/FTS5 store on the spine db. */
  memory?: MemoryFactory;
}

interface Wake {
  sessionKey: string;
  agentId: string;
  message: string;
}

// Everything the agent might wake for funnels into one serial inbox: a user
// message, or a resume after an approval resolved (reef-docs/05 — one queue).
type Job =
  | { kind: "message"; wake: Wake }
  | { kind: "resume"; runId: string };

/**
 * The always-on agent runtime. Owns the spine (state), the router (model), the
 * tool registry, and the event sink. Wakes enter the inbox and are worked one
 * at a time through the one agent loop. The database is the source of truth;
 * the daemon advances it and rebuilds from it on restart.
 */
export class Daemon {
  readonly spine: Spine;
  readonly sink: EventSink;
  private readonly router: ModelRouter;
  private readonly tools: ToolRegistry;
  private readonly inbox: Inbox<Job>;
  private readonly workspaceDir: string;
  private readonly maxSteps: number;
  private readonly memoryFactory: MemoryFactory;
  /** One memory store per agent, built lazily and reused across that agent's runs. */
  private readonly memories = new Map<string, MemoryStore>();
  /** Abort handles for in-flight runs, keyed by session — powers cancellation. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(opts: DaemonOptions) {
    this.spine = new Spine(opts.dbPath);
    this.sink = new EventSink(this.spine);
    this.router = opts.router ?? new VercelRouter();
    this.workspaceDir = opts.workspaceDir;
    this.maxSteps = opts.maxSteps ?? 20;
    // Default memory: the SQLite/FTS5 store sharing the spine's connection,
    // scoped per agent so agents never see each other's memory.
    this.memoryFactory =
      opts.memory ?? ((agentId) => new SqliteMemory(this.spine.connection, agentId));
    this.tools = new ToolRegistry();
    for (const tool of [...builtinTools, ...fileTools, ...shellTools, ...memoryTools]) {
      this.tools.register(tool);
    }
    this.inbox = new Inbox<Job>((job) => this.processJob(job));
  }

  /** The agent's memory store, built on first use and cached for reuse. */
  private memoryFor(agentId: string): MemoryStore {
    let store = this.memories.get(agentId);
    if (!store) {
      store = this.memoryFactory(agentId);
      this.memories.set(agentId, store);
    }
    return store;
  }

  registerAgent(agent: AgentRecord): void {
    this.spine.upsertAgent(agent);
  }

  subscribe(fn: Parameters<EventSink["subscribe"]>[0]): () => void {
    return this.sink.subscribe(fn);
  }

  /** Enqueue a user-message wake; resolves when its run terminates or suspends. */
  submit(wake: Wake): Promise<void> {
    return this.inbox.enqueue({ kind: "message", wake });
  }

  /**
   * Resolve a pending tool approval. Records the decision durably; once every
   * approval for the run's suspended turn is decided, re-drives the run (through
   * the same serial inbox) to execute the decided tools and continue.
   */
  resolveApproval(approvalId: string, decision: string): boolean {
    const approval = this.spine.getApproval(approvalId);
    if (!approval || approval.status !== "pending") return false;
    const status: ApprovalStatus = decision === "deny" ? "denied" : "allowed";
    this.spine.resolveApproval(approvalId, status, decision);
    this.sink.emit({
      type: "approval.resolved",
      sessionKey: approval.sessionKey,
      runId: approval.runId,
      approvalId,
      decision:
        decision === "allow-always" ? "allow-always" : decision === "deny" ? "deny" : "allow-once",
    });
    if (this.spine.pendingApprovalCount(approval.runId) === 0) {
      void this.inbox.enqueue({ kind: "resume", runId: approval.runId });
    }
    return true;
  }

  /**
   * Startup recovery (reef-docs/04): re-drive every run left mid-flight by a
   * crash. Suspended runs (awaiting approval) are intentionally parked and not
   * returned here — they resume only when their approvals resolve.
   */
  async recover(): Promise<void> {
    for (const run of this.spine.getInterruptedRuns()) {
      await this.runLoop(run);
    }
  }

  /** Cancel the in-flight run for a session (reef-docs/03 cancellation). */
  cancel(sessionKey: string): boolean {
    const aborter = this.aborters.get(sessionKey);
    if (!aborter) return false;
    aborter.abort();
    return true;
  }

  close(): void {
    this.spine.close();
  }

  private async processJob(job: Job): Promise<void> {
    if (job.kind === "message") return this.processWake(job.wake);
    return this.resumeRun(job.runId);
  }

  private async processWake(wake: Wake): Promise<void> {
    this.spine.ensureSession(wake.sessionKey, wake.agentId);
    this.spine.appendMessage(wake.sessionKey, "user", [
      { type: "text", text: wake.message },
    ]);
    const run = this.spine.createRun({
      id: newRunId(),
      agentId: wake.agentId,
      sessionKey: wake.sessionKey,
    });
    await this.runLoop(run);
  }

  private async resumeRun(runId: string): Promise<void> {
    const run = this.spine.getRun(runId);
    if (!run) return;
    this.spine.setRunStatus(runId, "running");
    await this.runLoop({ ...run, status: "running" }, { resumeApproval: true });
  }

  private async runLoop(run: Run, options: LoopOptions = {}): Promise<void> {
    const agent = this.spine.getAgent(run.agentId);
    if (!agent) {
      this.spine.setRunStatus(run.id, "failed", {
        stopReason: "error",
        endedAt: nowIso(),
      });
      return;
    }
    const root = join(this.workspaceDir, agent.id);
    await mkdir(root, { recursive: true });
    const aborter = new AbortController();
    this.aborters.set(run.sessionKey, aborter);
    try {
      await runAgentLoop(
        run,
        agent,
        {
          spine: this.spine,
          router: this.router,
          tools: this.tools,
          toolContext: {
            fs: new BoundFs(root),
            workspaceRoot: root,
            memory: this.memoryFor(agent.id),
            signal: aborter.signal,
          },
          emit: this.sink.emit,
          maxSteps: this.maxSteps,
        },
        options,
      );
    } finally {
      this.aborters.delete(run.sessionKey);
    }
  }
}
