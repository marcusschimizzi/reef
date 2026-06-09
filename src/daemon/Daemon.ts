import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { newRunId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { AgentRecord, Run } from "../core/types.js";
import { Spine } from "../db/spine.js";
import { BoundFs } from "../fs/capability.js";
import { runAgentLoop } from "../loop/AgentLoop.js";
import { VercelRouter, type ModelRouter } from "../model/router.js";
import { builtinTools } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/registry.js";
import { EventSink } from "./sink.js";
import { Inbox } from "./inbox.js";

export interface DaemonOptions {
  dbPath: string;
  workspaceDir: string;
  /** Injectable for tests; defaults to the real provider-routing layer. */
  router?: ModelRouter;
  maxSteps?: number;
}

interface Wake {
  sessionKey: string;
  agentId: string;
  message: string;
}

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
  private readonly inbox: Inbox<Wake>;
  private readonly workspaceDir: string;
  private readonly maxSteps: number;
  /** Abort handles for in-flight runs, keyed by session — powers cancellation. */
  private readonly aborters = new Map<string, AbortController>();

  constructor(opts: DaemonOptions) {
    this.spine = new Spine(opts.dbPath);
    this.sink = new EventSink(this.spine);
    this.router = opts.router ?? new VercelRouter();
    this.workspaceDir = opts.workspaceDir;
    this.maxSteps = opts.maxSteps ?? 20;
    this.tools = new ToolRegistry();
    for (const tool of builtinTools) this.tools.register(tool);
    this.inbox = new Inbox<Wake>((wake) => this.processWake(wake));
  }

  registerAgent(agent: AgentRecord): void {
    this.spine.upsertAgent(agent);
  }

  subscribe(fn: Parameters<EventSink["subscribe"]>[0]): () => void {
    return this.sink.subscribe(fn);
  }

  /** Enqueue a user-message wake; resolves when its run terminates. */
  submit(wake: Wake): Promise<void> {
    return this.inbox.enqueue(wake);
  }

  /**
   * Startup recovery (reef-docs/04): re-drive every run left mid-flight by a
   * crash. The loop is resume-aware — it continues after the steps already
   * committed to the spine — so this picks up exactly where the durable record
   * left off rather than restarting or guessing.
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

  private async runLoop(run: Run): Promise<void> {
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
      await runAgentLoop(run, agent, {
        spine: this.spine,
        router: this.router,
        tools: this.tools,
        toolContext: { fs: new BoundFs(root), signal: aborter.signal },
        emit: this.sink.emit,
        maxSteps: this.maxSteps,
      });
    } finally {
      this.aborters.delete(run.sessionKey);
    }
  }
}
