# Coding-Agent Control — Step 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the coding-agent control loop — reef's `ApprovalPolicy` auto-answers/gates Claude Code's interactive prompts, and a reef agent can spawn a Claude Code session via a `start_coding_session` tool whose run suspends (`awaiting_subwork`) until the session completes.

**Architecture:** Three concerns layered on Steps 1–2. **(A)** `CodingSessionManager` runs detected prompts through `policy.decide` → allow/deny inject a digit immediately; gate writes a durable `coding_approvals` row + emits `approval.requested` and waits for a human resolve that injects the digit. **(B)** The agent loop gains `awaiting_subwork` suspend/resume, mirroring `b7786ed`'s suspend-for-approval: a `suspendsForSubwork` tool starts a session and suspends the run; the session's completion enqueues a resume that produces the tool_result from the session's result. The resume **preamble disambiguates approval-resume from subwork-resume by inspecting the pending step** — no new loop mode or job kind. **(C)** A `start_coding_session` tool wires the agent path to the manager via two `LoopDeps` hooks (`startSubwork`/`collectSubwork`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3 spine, vitest, zod tool schemas, node-pty driver (faked in tests).

---

## File Structure

- **`src/db/schema.ts`** (modify) — add the `coding_approvals` table to the DDL; add `coding_sessions.spawning_tool_use_id` to the DDL + a `migrate()` step.
- **`src/db/spine.ts`** (modify) — `CodingApprovalRecord` interface; `createCodingApproval` / `getCodingApproval` / `resolveCodingApproval`; `findCodingSessionBySubwork`; extend `CodingSessionRecord` + `createCodingSession` + `rowToCodingSession` with `spawningToolUseId`.
- **`src/coding/manager.ts`** (modify) — `policy` dep; `source` + `spawningToolUseId` on start opts; the prompt-pending policy flow; `resolveCodingApproval`; a `recordAction` helper; set `result` on completion from the transcript.
- **`src/tools/types.ts`** (modify) — add `suspendsForSubwork?: boolean` to `Tool`.
- **`src/tools/coding.ts`** (create) — the `start_coding_session` tool + `codingTools` export.
- **`src/loop/AgentLoop.ts`** (modify) — `startSubwork` / `collectSubwork` on `LoopDeps`; the main-loop subwork-suspend block; the resume-preamble subwork branch.
- **`src/daemon/Daemon.ts`** (modify) — register `codingTools`; wire `startSubwork` / `collectSubwork`; pass `source`/`spawningToolUseId` through; `resolveApproval` fork to coding approvals; `onSinkEvent` completion→resume enqueue.
- **Tests:** `tests/db/codingApprovals.test.ts`, `tests/coding/manager.test.ts` (extend), `tests/loop/subwork.test.ts`, `tests/coding/startCodingSessionTool.test.ts`, `tests/coding/daemonCoding.test.ts` (extend).

Run the whole suite with `npm test`; a single file with `npx vitest run <path>`.

---

## Task 1: `coding_sessions.spawning_tool_use_id` column

Links a coding session back to the exact tool_use that spawned it, so `collectSubwork(runId, toolUseId)` can find it on resume.

**Files:**
- Modify: `src/db/schema.ts` (DDL `coding_sessions` block + `migrate()`)
- Modify: `src/db/spine.ts` (`CodingSessionRecord`, `createCodingSession`, `rowToCodingSession`, new `findCodingSessionBySubwork`)
- Test: `tests/db/codingApprovals.test.ts` (new file; this task adds the first test)

- [ ] **Step 1: Write the failing test**

Create `tests/db/codingApprovals.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-ca-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const spine = () => new Spine(join(tmp(), "reef.db"));

function makeSession(s: Spine, over: Partial<Parameters<Spine["createCodingSession"]>[0]> = {}) {
  const id = `cs_${Math.random().toString(16).slice(2)}`;
  s.createCodingSession({
    id, spawningRunId: null, spawningToolUseId: null, agentKind: "claude-code",
    externalSessionId: "ext", directory: "/tmp/x", status: "running", task: "t",
    tracePath: "/tmp/x.jsonl", ...over,
  });
  return id;
}

describe("coding_sessions subwork link", () => {
  it("round-trips spawning_tool_use_id and finds by (run, toolUse)", () => {
    const s = spine();
    const id = makeSession(s, { spawningRunId: "run_1", spawningToolUseId: "tool_9" });
    expect(s.getCodingSession(id)!.spawningToolUseId).toBe("tool_9");
    expect(s.findCodingSessionBySubwork("run_1", "tool_9")!.id).toBe(id);
    expect(s.findCodingSessionBySubwork("run_1", "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/codingApprovals.test.ts`
Expected: FAIL — `createCodingSession` rejects the unknown `spawningToolUseId` property / `findCodingSessionBySubwork` is not a function.

- [ ] **Step 3: Add the column to the DDL and a migration**

In `src/db/schema.ts`, change the `coding_sessions` DDL to add the column after `spawning_run_id`:

```sql
CREATE TABLE IF NOT EXISTS coding_sessions (
  id           TEXT PRIMARY KEY,
  spawning_run_id      TEXT,
  spawning_tool_use_id TEXT,
  agent_kind   TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  directory    TEXT NOT NULL,
  status       TEXT NOT NULL,
  task         TEXT NOT NULL,
  result       TEXT,
  trace_path   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  ended_at     TEXT
);
```

And add a `migrate()` step (after the existing ones):

```ts
  addColumnIfMissing(db, "coding_sessions", "spawning_tool_use_id", "TEXT");
```

- [ ] **Step 4: Extend the spine record + CRUD**

In `src/db/spine.ts`, add `spawningToolUseId` to `CodingSessionRecord` (after `spawningRunId`):

```ts
export interface CodingSessionRecord {
  id: string;
  spawningRunId: string | null;
  spawningToolUseId: string | null;
  agentKind: string;
  externalSessionId: string;
  directory: string;
  status: string;
  task: string;
  result?: string;
  tracePath: string;
  createdAt: string;
  endedAt?: string;
}
```

Update `createCodingSession` to insert it:

```ts
  createCodingSession(rec: Omit<CodingSessionRecord, "createdAt" | "result" | "endedAt">): void {
    this.db
      .prepare(
        `INSERT INTO coding_sessions
           (id, spawning_run_id, spawning_tool_use_id, agent_kind, external_session_id, directory, status, task, trace_path, created_at)
         VALUES (@id, @spawningRunId, @spawningToolUseId, @agentKind, @externalSessionId, @directory, @status, @task, @tracePath, @createdAt)`,
      )
      .run({ ...rec, createdAt: nowIso() });
  }
```

Add the lookup next to `getCodingSession`:

```ts
  findCodingSessionBySubwork(runId: string, toolUseId: string): CodingSessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM coding_sessions WHERE spawning_run_id = ? AND spawning_tool_use_id = ?`)
      .get(runId, toolUseId) as Record<string, unknown> | undefined;
    return row ? rowToCodingSession(row) : undefined;
  }
```

Update `rowToCodingSession` to read it (after `spawningRunId`):

```ts
    spawningToolUseId: (row.spawning_tool_use_id as string | null) ?? null,
```

- [ ] **Step 5: Update existing `createCodingSession` callers**

`src/coding/manager.ts` `start()` builds the record. Add `spawningToolUseId: opts.spawningToolUseId ?? null` to its `createCodingSession({...})` call (the `StartCodingSession` field is added in Task 3; for now pass `null` literally to keep this task self-contained):

```ts
    this.deps.spine.createCodingSession({
      id,
      spawningRunId: opts.spawningRunId ?? null,
      spawningToolUseId: null,
      agentKind: opts.agentKind,
      externalSessionId,
      directory: opts.directory,
      status: "running",
      task: opts.task,
      tracePath,
    });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/db/codingApprovals.test.ts tests/coding/manager.test.ts`
Expected: PASS (the new round-trip test and the existing manager tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/spine.ts src/coding/manager.ts tests/db/codingApprovals.test.ts
git commit -m "feat: coding_sessions.spawning_tool_use_id + findCodingSessionBySubwork (Step 3 subwork link)"
```

---

## Task 2: `coding_approvals` table + spine CRUD

The durable record a human resolves against when policy gates a coding-session prompt. FKs to `coding_sessions` (never `runs`), so it can never collide with the run-resume machinery.

**Files:**
- Modify: `src/db/schema.ts` (DDL)
- Modify: `src/db/spine.ts` (`CodingApprovalRecord`, 3 methods, a `rowToCodingApproval`)
- Test: `tests/db/codingApprovals.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/db/codingApprovals.test.ts`:

```ts
describe("coding_approvals", () => {
  it("creates pending, reads back, and resolves", () => {
    const s = spine();
    const cs = makeSession(s);
    s.createCodingApproval({
      id: "apr_1", codingSessionId: cs, promptText: "Do you want to edit a.ts?",
      options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }],
      toolName: "claude-code:Edit", input: { path: "a.ts" },
    });
    const a = s.getCodingApproval("apr_1")!;
    expect(a).toMatchObject({ codingSessionId: cs, status: "pending", toolName: "claude-code:Edit" });
    expect(a.options).toEqual([{ index: 1, label: "Yes" }, { index: 2, label: "No" }]);

    s.resolveCodingApproval("apr_1", "allowed", "allow-once");
    const r = s.getCodingApproval("apr_1")!;
    expect(r.status).toBe("allowed");
    expect(r.decision).toBe("allow-once");
    expect(r.decidedAt).toBeTruthy();
  });

  it("getCodingApproval returns undefined for an unknown id", () => {
    expect(spine().getCodingApproval("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/codingApprovals.test.ts`
Expected: FAIL — `createCodingApproval` is not a function.

- [ ] **Step 3: Add the DDL**

In `src/db/schema.ts`, add after the `coding_sessions` table (inside the `DDL` template literal):

```sql
-- Durable approvals for a coding session's interactive prompts (Step 3). Separate
-- from `approvals` on purpose: these belong to an external PTY session, not a reef
-- run, so resolving one injects a keystroke into the session rather than re-driving
-- a run. FKs to coding_sessions, never runs.
CREATE TABLE IF NOT EXISTS coding_approvals (
  id                TEXT PRIMARY KEY,
  coding_session_id TEXT NOT NULL,
  prompt_text       TEXT NOT NULL,
  options           TEXT NOT NULL,   -- JSON [{index,label}]
  tool_name         TEXT NOT NULL,
  input             TEXT NOT NULL,   -- JSON
  status            TEXT NOT NULL,   -- pending | allowed | denied
  decision          TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT,
  expires_at        TEXT,
  FOREIGN KEY (coding_session_id) REFERENCES coding_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_coding_approvals_session ON coding_approvals(coding_session_id);
```

- [ ] **Step 4: Add the record type + CRUD to the spine**

In `src/db/spine.ts`, add the interface near `CodingSessionRecord`:

```ts
export interface CodingApprovalRecord {
  id: string;
  codingSessionId: string;
  promptText: string;
  options: { index: number; label: string }[];
  toolName: string;
  input: unknown;
  status: "pending" | "allowed" | "denied";
  decision?: string;
  createdAt: string;
  decidedAt?: string;
}
```

Add the three methods (next to the coding-session methods):

```ts
  createCodingApproval(rec: {
    id: string;
    codingSessionId: string;
    promptText: string;
    options: { index: number; label: string }[];
    toolName: string;
    input: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO coding_approvals
           (id, coding_session_id, prompt_text, options, tool_name, input, status, created_at)
         VALUES (@id, @codingSessionId, @promptText, @options, @toolName, @input, 'pending', @createdAt)`,
      )
      .run({
        id: rec.id,
        codingSessionId: rec.codingSessionId,
        promptText: rec.promptText,
        options: JSON.stringify(rec.options),
        toolName: rec.toolName,
        input: JSON.stringify(rec.input ?? null),
        createdAt: nowIso(),
      });
  }

  getCodingApproval(id: string): CodingApprovalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM coding_approvals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCodingApproval(row) : undefined;
  }

  resolveCodingApproval(id: string, status: "allowed" | "denied", decision: string): void {
    this.db
      .prepare(
        `UPDATE coding_approvals SET status = ?, decision = ?, decided_at = ? WHERE id = ?`,
      )
      .run(status, decision, nowIso(), id);
  }
```

Add the row mapper near `rowToCodingSession`:

```ts
function rowToCodingApproval(row: Record<string, unknown>): CodingApprovalRecord {
  return {
    id: row.id as string,
    codingSessionId: row.coding_session_id as string,
    promptText: row.prompt_text as string,
    options: JSON.parse(row.options as string) as { index: number; label: string }[],
    toolName: row.tool_name as string,
    input: JSON.parse(row.input as string),
    status: row.status as "pending" | "allowed" | "denied",
    decision: (row.decision as string | null) ?? undefined,
    createdAt: row.created_at as string,
    decidedAt: (row.decided_at as string | null) ?? undefined,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db/codingApprovals.test.ts`
Expected: PASS (all four tests in the file).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/spine.ts tests/db/codingApprovals.test.ts
git commit -m "feat: coding_approvals table + spine CRUD (Step 3 durable gate record)"
```

---

## Task 3: Manager policy flow — allow / deny auto-answer

On a detected prompt, build the policy context from the (reliable) transcript tool-use, decide, and for allow/deny inject the mapped digit immediately and write an audit row. (Gate comes in Task 4.)

**Files:**
- Modify: `src/coding/manager.ts`
- Test: `tests/coding/manager.test.ts` (extend; add a fake policy)

- [ ] **Step 1: Write the failing test**

In `tests/coding/manager.test.ts`, add imports and a fake policy at the top (after the existing imports):

```ts
import type { ApprovalPolicy, PolicyContext, PolicyDecision } from "../../src/policy/policy.js";

class FakePolicy implements ApprovalPolicy {
  constructor(private readonly fn: (ctx: PolicyContext) => PolicyDecision) {}
  last?: PolicyContext;
  decide(ctx: PolicyContext): PolicyDecision { this.last = ctx; return this.fn(ctx); }
}
```

Change `setup()` to accept an optional policy and pass it to the manager:

```ts
function setup(policy: ApprovalPolicy = new FakePolicy(() => ({ action: "gate" }))) {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  const driver = new FakeDriver();
  const mgr = new CodingSessionManager({ spine, emit, driver, traceDir: join(dir, "traces"), policy });
  return { spine, events, driver, mgr, dir };
}
```

Add the new tests inside the `describe`:

```ts
  it("policy 'allow' injects the mapped digit + audits + returns to running", () => {
    const policy = new FakePolicy(() => ({ action: "allow" }));
    const { spine, driver, mgr } = setup(policy);
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toContain("1\r");
    expect(spine.getCodingSession(id)!.status).toBe("running");
    expect(policy.last).toMatchObject({ needsApproval: true, sessionKey: `coding:${id}` });
  });

  it("policy 'deny' injects the No option", () => {
    const policy = new FakePolicy(() => ({ action: "deny" }));
    const { driver, mgr } = setup(policy);
    mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toContain("2\r");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: FAIL — `CodingSessionManagerDeps` has no `policy`; the manager still only sets `awaiting_decision` without injecting.

- [ ] **Step 3: Wire the policy dep + imports**

In `src/coding/manager.ts`, add imports:

```ts
import { newActionId, newApprovalId } from "../core/ids.js";
import { nowIso } from "../core/time.js";
import type { RunSource } from "../core/types.js";
import type { ApprovalPolicy } from "../policy/policy.js";
import { answerFor, classifyPrompt, promptAction, type Decision } from "./prompts.js";
import { findClaudeTranscript, latestToolUse, parseClaudeTranscript } from "./transcript.js";
```

Add `policy` to `CodingSessionManagerDeps`:

```ts
export interface CodingSessionManagerDeps {
  spine: Spine;
  emit: EmitFn;
  driver: CodingAgentDriver;
  traceDir: string;
  appendSystemPrompt?: string;
  policy: ApprovalPolicy;
}
```

Add `source` to `StartCodingSession` and the `Live` record:

```ts
export interface StartCodingSession {
  agentKind: string;
  directory: string;
  task: string;
  spawningRunId?: string | null;
  spawningToolUseId?: string | null;
  source?: RunSource;
}

interface Live {
  handle: CodingDriverHandle;
  processor: CodingStreamProcessor;
  trace: TraceWriter;
  source: RunSource;
}
```

In `start()`, set `spawningToolUseId` from opts (replacing the literal `null` from Task 1) and store `source` on the live record:

```ts
      spawningToolUseId: opts.spawningToolUseId ?? null,
```

```ts
    this.live.set(id, { handle, processor, trace, source: opts.source ?? { kind: "message" } });
```

- [ ] **Step 4: Implement the prompt-pending policy flow**

In `src/coding/manager.ts`, replace the `prompt-pending` branch of `onDriverEvent` with a call to a new `handlePrompt`:

```ts
  private onDriverEvent(id: string, ev: DriverEvent): void {
    const l = this.live.get(id);
    l?.trace.write({ type: "event", event: ev });
    if (ev.type === "output") {
      this.emitCoding(id, { type: "coding.output", codingSessionId: id, text: ev.text });
    } else if (ev.type === "prompt-pending") {
      this.handlePrompt(id, ev);
    }
  }
```

Add `handlePrompt`, `promptContext`, `injectAnswer`, and `recordAction` methods:

```ts
  /** A detected prompt → policy decision → inject (allow/deny) or gate (Task 4). */
  private handlePrompt(id: string, ev: { promptText: string; options: { index: number; label: string }[] }): void {
    const l = this.live.get(id);
    if (!l) return;
    const ctx = this.promptContext(id, ev.promptText, l.source);

    this.deps.spine.setCodingSessionStatus(id, "awaiting_decision");
    this.emitCoding(id, {
      type: "coding.prompt.detected",
      codingSessionId: id,
      promptText: ev.promptText,
      options: ev.options,
    });

    const decision = this.deps.policy.decide(ctx);
    if (decision.action === "gate") {
      this.gate(id, ev, ctx); // Task 4
      return;
    }
    const dec: Decision = decision.action === "deny" ? "deny" : "allow-once";
    this.injectAnswer(id, ev.options, dec, ctx, decision.action === "deny" ? "deny" : "allow");
  }

  /** Build the policy context, preferring the transcript's reliable tool-use over
   *  the scraped prompt text. */
  private promptContext(id: string, promptText: string, source: RunSource) {
    const cs = this.deps.spine.getCodingSession(id)!;
    const path = findClaudeTranscript(cs.externalSessionId, { cwd: cs.directory });
    const tool = path ? latestToolUse(parseClaudeTranscript(path)) : undefined;
    const action = promptAction(promptText);
    return {
      agentId: cs.agentKind,
      toolName: `claude-code:${tool?.name ?? classifyPrompt(promptText)}`,
      needsApproval: true,
      input: tool?.input ?? action ?? promptText,
      source,
      sessionKey: `coding:${id}`,
    };
  }

  /** Map a decision to an option digit and inject it; audit; back to running. */
  private injectAnswer(
    id: string,
    options: { index: number; label: string }[],
    dec: Decision,
    ctx: { toolName: string; input: unknown; sessionKey: string },
    policyAction: "allow" | "deny",
    spawningRunId?: string | null,
  ): void {
    const l = this.live.get(id);
    if (!l) return;
    const n = answerFor(options, dec);
    if (n === undefined) {
      // No mappable option — leave the prompt for the operator's manual send().
      l.trace.write({ type: "inject", data: "", reason: `policy:${policyAction}:unmapped` });
      return;
    }
    l.trace.write({ type: "inject", data: `${n}\r`, reason: `policy:${policyAction}` });
    l.handle.write(`${n}\r`);
    this.recordAction(id, ctx, policyAction, policyAction === "deny" ? "denied" : "ok", spawningRunId);
    this.deps.spine.setCodingSessionStatus(id, "running");
  }

  /** One audit row per coding-session decision (reuses the actions log). */
  private recordAction(
    id: string,
    ctx: { toolName: string; input: unknown },
    decision: "allow" | "deny",
    outcome: "ok" | "denied",
    spawningRunId?: string | null,
  ): void {
    this.deps.spine.recordAction({
      id: newActionId(),
      runId: spawningRunId ?? id,
      sessionKey: `coding:${id}`,
      agentId: "claude-code",
      toolName: ctx.toolName,
      input: ctx.input,
      decision,
      outcome,
      createdAt: nowIso(),
    });
  }
```

> Note: `gate()` is referenced here but implemented in Task 4. To keep this task green on its own, add a temporary stub that falls back to the old behavior:
> ```ts
>   private gate(id: string, _ev: { promptText: string; options: { index: number; label: string }[] }, _ctx: unknown): void {
>     // Task 4 replaces this with the coding_approvals + approval.requested flow.
>   }
> ```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: PASS — the allow/deny tests inject `1\r`/`2\r`; the existing "flags a detected prompt" test still passes because the default `setup()` policy returns `gate` (the stub leaves status `awaiting_decision`).

- [ ] **Step 6: Update the daemon construction (compile fix)**

`CodingSessionManagerDeps.policy` is now required. In `src/daemon/Daemon.ts`, pass the daemon's policy into the manager:

```ts
    this.coding = new CodingSessionManager({
      spine: this.spine,
      emit: this.sink.emit,
      driver: opts.codingDriver ?? new PtyClaudeDriver(),
      traceDir: opts.codingTraceDir ?? join(opts.workspaceDir, "..", "coding-sessions"),
      policy: this.policy,
    });
```

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (the `daemonCoding.test.ts` constructs the daemon, which now supplies `policy`).

- [ ] **Step 8: Commit**

```bash
git add src/coding/manager.ts src/daemon/Daemon.ts tests/coding/manager.test.ts
git commit -m "feat: coding manager runs prompts through ApprovalPolicy (allow/deny auto-answer + audit)"
```

---

## Task 4: Manager gate flow + `resolveCodingApproval`

Gate writes a `coding_approvals` row + emits `approval.requested` and waits; a human resolve injects the mapped digit.

**Files:**
- Modify: `src/coding/manager.ts` (replace the `gate` stub; add `resolveCodingApproval`)
- Test: `tests/coding/manager.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/coding/manager.test.ts`:

```ts
  it("policy 'gate' writes a coding_approvals row + approval.requested, then waits", () => {
    const { spine, events, driver, mgr } = setup(); // default policy gates
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n");
    expect(driver.handle.written).toEqual([]); // nothing injected — waiting
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string } | undefined;
    expect(req).toBeTruthy();
    expect(spine.getCodingApproval(req!.approvalId)!.status).toBe("pending");
    expect(spine.getCodingSession(id)!.status).toBe("awaiting_decision");
  });

  it("resolveCodingApproval('allow-once') injects Yes and resolves the row", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("Do you want to edit a.ts?\n❯ 1. Yes\n  2. No\n");
    const req = events.find((e) => e.type === "approval.requested") as { approvalId: string };
    mgr.resolveCodingApproval(req.approvalId, "allow-once");
    expect(driver.handle.written).toContain("1\r");
    expect(spine.getCodingApproval(req.approvalId)!.status).toBe("allowed");
    expect(spine.getCodingSession(id)!.status).toBe("running");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: FAIL — the `gate` stub writes nothing; `resolveCodingApproval` is not a function.

- [ ] **Step 3: Implement `gate` + `resolveCodingApproval`**

In `src/coding/manager.ts`, replace the `gate` stub with:

```ts
  /** Policy gated this prompt: record it durably, surface it, and wait for a human
   *  resolve (which injects via resolveCodingApproval). */
  private gate(
    id: string,
    ev: { promptText: string; options: { index: number; label: string }[] },
    ctx: { toolName: string; input: unknown },
  ): void {
    const approvalId = newApprovalId();
    this.deps.spine.createCodingApproval({
      id: approvalId,
      codingSessionId: id,
      promptText: ev.promptText,
      options: ev.options,
      toolName: ctx.toolName,
      input: ctx.input,
    });
    this.emit({
      type: "approval.requested",
      approvalId,
      action: ctx.toolName,
      detail: ctx.input,
      sessionKey: `coding:${id}`,
      runId: "",
    } as Parameters<EmitFn>[0]);
  }
```

Add the public resolve method (called by the daemon when a coding approval resolves):

```ts
  /** Resolve a gated coding prompt: inject the mapped digit, audit, resume. Called
   *  by the daemon's resolveApproval fork. The `coding_approvals` row is updated by
   *  the daemon before this runs. */
  resolveCodingApproval(approvalId: string, decision: string): void {
    const appr = this.deps.spine.getCodingApproval(approvalId);
    if (!appr) return;
    const id = appr.codingSessionId;
    const dec: Decision =
      decision === "deny" ? "deny" : decision === "allow-always" ? "allow-always" : "allow-once";
    this.injectAnswer(
      id,
      appr.options,
      dec,
      { toolName: appr.toolName, input: appr.input, sessionKey: `coding:${id}` },
      decision === "deny" ? "deny" : "allow",
    );
  }
```

> Note: in this manager-level test we call `mgr.resolveCodingApproval` directly, so it must update the row status itself for the assertion. Add a `this.deps.spine.resolveCodingApproval(approvalId, decision === "deny" ? "denied" : "allowed", decision);` line at the **start** of `resolveCodingApproval` (after the `if (!appr) return;`). In production the daemon also calls `spine.resolveCodingApproval` first; calling it twice is idempotent (it just re-stamps `decided_at`), which is acceptable. To avoid the double write, guard on `appr.status === "pending"`:
> ```ts
>     if (appr.status !== "pending") return;
>     this.deps.spine.resolveCodingApproval(approvalId, decision === "deny" ? "denied" : "allowed", decision);
> ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: PASS (gate writes the row + event and injects nothing; resolve injects `1\r` and flips status).

- [ ] **Step 5: Commit**

```bash
git add src/coding/manager.ts tests/coding/manager.test.ts
git commit -m "feat: coding manager gate flow — coding_approvals + approval.requested + resolveCodingApproval"
```

---

## Task 5: Manager sets `result` from the transcript on completion

The subwork tool_result needs a real summary. On exit, read the transcript's final assistant text into `coding_sessions.result`.

**Files:**
- Modify: `src/coding/manager.ts` (`onExit` handler)
- Test: `tests/coding/manager.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add a helper + test to `tests/coding/manager.test.ts`. It writes a fake Claude transcript at the path the manager will compute, then exits the session:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeProjectPath } from "../../src/coding/transcript.js";

  it("on completion, stores the transcript's final assistant text as result", () => {
    const { spine, driver, mgr, dir } = setup(new FakePolicy(() => ({ action: "allow" })));
    const root = join(dir, "claude-projects");
    const workdir = join(dir, "work");
    mkdirSync(workdir, { recursive: true });
    const id = mgr.start({ agentKind: "claude-code", directory: workdir, task: "t" });
    const ext = spine.getCodingSession(id)!.externalSessionId;
    const tdir = join(root, encodeProjectPath(workdir));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(
      join(tdir, `${ext}.jsonl`),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: created a.ts" }] } }) + "\n",
    );
    // Point the manager's transcript lookup at our temp root.
    process.env.REEF_CLAUDE_PROJECTS = root;
    driver.handle.die(0);
    delete process.env.REEF_CLAUDE_PROJECTS;
    expect(spine.getCodingSession(id)!.result).toBe("Done: created a.ts");
  });
```

> Design choice this test forces: `findClaudeTranscript` must honor a `root` override. `transcript.ts` already accepts `{ root }`; expose it to the manager via the `REEF_CLAUDE_PROJECTS` env var so tests (and a future config) can redirect the lookup without a real `~/.claude`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/coding/manager.test.ts -t "final assistant text"`
Expected: FAIL — `result` is `undefined` (the manager never sets it).

- [ ] **Step 3: Add a transcript-root helper + read it on exit**

In `src/coding/transcript.ts`, make `claudeProjectsDir()` honor the override (keep the default):

```ts
export function claudeProjectsDir(): string {
  return process.env.REEF_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
}
```

In `src/coding/manager.ts`, add `renderTranscript` to the transcript import and compute the result in `onExit` before `setCodingSessionStatus`:

```ts
import {
  findClaudeTranscript,
  latestToolUse,
  parseClaudeTranscript,
  renderTranscript,
} from "./transcript.js";
```

```ts
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
      const cancelled = this.cancelling.delete(id);
      const status = cancelled ? "cancelled" : code === 0 || code === null ? "completed" : "failed";
      const result = this.readResult(id);
      this.deps.spine.setCodingSessionStatus(id, status, result);
      if (status === "failed") {
        this.emitCoding(id, { type: "coding.session.failed", codingSessionId: id, error: `exited with code ${code}` });
      } else {
        this.emitCoding(id, { type: "coding.session.completed", codingSessionId: id, result });
      }
      trace.close();
      this.live.delete(id);
    });
```

Add `readResult` (the last assistant line; `undefined` when no transcript):

```ts
  /** The session's final assistant message, from Claude Code's own transcript —
   *  the reliable "result" summary. undefined when the transcript is absent. */
  private readResult(id: string): string | undefined {
    const cs = this.deps.spine.getCodingSession(id);
    if (!cs) return undefined;
    const path = findClaudeTranscript(cs.externalSessionId, { cwd: cs.directory });
    if (!path) return undefined;
    const entries = parseClaudeTranscript(path);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]!.text && entries[i]!.role === "assistant") return entries[i]!.text;
    }
    return renderTranscript(entries) || undefined;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: PASS (result is `"Done: created a.ts"`; the existing exit tests still pass — no transcript → `result` undefined → `setCodingSessionStatus(id, status, undefined)` leaves it null).

- [ ] **Step 5: Commit**

```bash
git add src/coding/manager.ts src/coding/transcript.ts tests/coding/manager.test.ts
git commit -m "feat: coding manager stores transcript final assistant text as session result"
```

---

## Task 6: `Tool.suspendsForSubwork` + `LoopDeps` hooks

Type-level seams for the subwork suspend/resume. No behavior yet.

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/loop/AgentLoop.ts` (`LoopDeps` only)

- [ ] **Step 1: Add the tool flag**

In `src/tools/types.ts`, extend `Tool`:

```ts
export interface Tool<I = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  needsApproval?: boolean;
  /** If true, running this tool starts external subwork (a coding session) and
   *  suspends the run (`awaiting_subwork`) until it completes; the result becomes
   *  the tool_result on resume. The loop's startSubwork/collectSubwork hooks do the
   *  work — the tool's own run() is never executed for effect. */
  suspendsForSubwork?: boolean;
  run(input: I, ctx: ToolContext): Promise<unknown>;
}
```

- [ ] **Step 2: Add the loop hooks**

In `src/loop/AgentLoop.ts`, extend `LoopDeps` (after `policy`):

```ts
  /** Start external subwork for a suspendsForSubwork tool; returns the coding
   *  session id. Omit to disable subwork (the tool then runs normally). */
  startSubwork?: (run: Run, call: ToolUse, source: RunSource) => Promise<string>;
  /** Read a completed subwork's result for (runId, toolUseId); undefined until it
   *  exists and has finished. */
  collectSubwork?: (runId: string, toolUseId: string) => { result: string } | undefined;
```

> `ToolUse` is already a type alias in this file (`type ToolUse = Extract<ContentBlock, { type: "tool_use" }>`). `RunSource` is already imported.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (additive optional fields; no caller changes required).

- [ ] **Step 4: Commit**

```bash
git add src/tools/types.ts src/loop/AgentLoop.ts
git commit -m "feat: Tool.suspendsForSubwork + LoopDeps startSubwork/collectSubwork seams"
```

---

## Task 7: Loop suspends for subwork (main-turn path)

When a turn calls a `suspendsForSubwork` tool (and it isn't gated), start the subwork and suspend `awaiting_subwork`.

**Files:**
- Modify: `src/loop/AgentLoop.ts` (main `while` loop, after the gate block)
- Test: `tests/loop/subwork.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/loop/subwork.test.ts`. It uses a stub router that emits a single `start_coding_session` tool_use, a stub subwork tool, and fake hooks:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Spine } from "../../src/db/spine.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { runAgentLoop } from "../../src/loop/AgentLoop.js";
import type { ModelRouter } from "../../src/model/router.js";
import type { ReefEvent, ReefEventInit } from "../../src/protocol/events.js";
import type { AgentRecord, Run } from "../../src/core/types.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-sw-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TOOL_USE = { type: "tool_use" as const, id: "tool_1", name: "start_coding_session", input: { directory: "/tmp/x", task: "go" } };

function fakeRouter(turns: Array<{ content: any[]; stop: string }>): ModelRouter {
  let i = 0;
  return { generateTurn: async () => ({ ...turns[Math.min(i++, turns.length - 1)], usage: { inputTokens: 1, outputTokens: 1 } }) } as unknown as ModelRouter;
}

function harness(over: { startSubwork?: any; collectSubwork?: any } = {}) {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  spine.upsertAgent({ id: "agent_1", name: "a", model: "m", systemPrompt: "s", toolAllowlist: ["start_coding_session"] } as AgentRecord);
  spine.ensureSession("s1", "agent_1");
  const run = spine.createRun({ id: "run_1", agentId: "agent_1", sessionKey: "s1" });
  const tools = new ToolRegistry();
  tools.register({
    name: "start_coding_session", description: "d", inputSchema: z.object({ directory: z.string(), task: z.string() }),
    suspendsForSubwork: true, needsApproval: false, run: async () => { throw new Error("should not run"); },
  });
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  return { dir, spine, run, tools, events, emit };
}
```

> Confirm the exact spine setup calls (`upsertAgent`, `createRun`, `ensureSession`) against `src/db/spine.ts` while implementing — adjust names to match (the surrounding test files in `tests/loop/` show the real helpers; reuse them if present).

Add the test:

```ts
describe("awaiting_subwork suspend", () => {
  it("a suspendsForSubwork tool starts subwork and suspends instead of running", async () => {
    const { spine, run, tools, events, emit } = harness();
    let started: string | undefined;
    const stop = await runAgentLoop(
      run as Run,
      spine.getAgent("agent_1")!,
      {
        spine, router: fakeRouter([{ content: [TOOL_USE], stop: "tool_use" }]),
        tools, toolContext: { fs: {} as any, workspaceRoot: "/tmp" }, emit,
        startSubwork: async (_r, call) => { started = call.id; return "cs_1"; },
        collectSubwork: () => undefined,
      },
    );
    expect(stop).toBe("awaiting_subwork");
    expect(started).toBe("tool_1");
    expect(spine.getRun("run_1")!.status).toBe("suspended");
    expect(spine.getRun("run_1")!.stopReason).toBe("awaiting_subwork");
    expect(events.some((e) => e.type === "run.suspended")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loop/subwork.test.ts`
Expected: FAIL — the loop runs the tool (throws "should not run") instead of suspending.

- [ ] **Step 3: Add the subwork-suspend block to the main loop**

In `src/loop/AgentLoop.ts`, immediately **after** the `gated.length > 0` block and **before** the `let toolResults` line, add:

```ts
      // Suspend for subwork: a tool that spawns an external session (a coding
      // session) starts it now and parks the run until it completes. Checked after
      // gate so an approval still wins first (the start happens on the post-approval
      // resume — see the preamble). No-op without a startSubwork hook.
      const subworkCall = toolUses.find((c) => tools.get(c.name)?.suspendsForSubwork);
      if (subworkCall && deps.startSubwork) {
        spine.updateStepOutput(run.id, index, { response: turn.content, usage: turn.usage });
        await deps.startSubwork(run, subworkCall, source);
        spine.setRunStatus(run.id, "suspended", { stopReason: "awaiting_subwork" });
        emit({ type: "run.suspended", stopReason: "awaiting_subwork" });
        return "awaiting_subwork";
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/loop/subwork.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/loop/AgentLoop.ts tests/loop/subwork.test.ts
git commit -m "feat: agent loop suspends awaiting_subwork when a tool spawns external subwork"
```

---

## Task 8: Loop resumes subwork (preamble branch)

On resume, if the pending step holds a subwork tool: start-then-resuspend if `collectSubwork` is still empty (post-approval first entry), else commit the collected result as the tool_result.

**Files:**
- Modify: `src/loop/AgentLoop.ts` (resume preamble)
- Test: `tests/loop/subwork.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `tests/loop/subwork.test.ts`. First suspend, then resume with `collectSubwork` returning a result:

```ts
  it("resume with a completed subwork commits its result as the tool_result", async () => {
    const { spine, run, tools, events, emit } = harness();
    // First pass: suspend.
    await runAgentLoop(run as Run, spine.getAgent("agent_1")!, {
      spine, router: fakeRouter([{ content: [TOOL_USE], stop: "tool_use" }]),
      tools, toolContext: { fs: {} as any, workspaceRoot: "/tmp" }, emit,
      startSubwork: async () => "cs_1", collectSubwork: () => undefined,
    });
    expect(spine.getRun("run_1")!.stopReason).toBe("awaiting_subwork");

    // Resume: subwork completed.
    spine.setRunStatus("run_1", "running");
    const stop = await runAgentLoop({ ...(spine.getRun("run_1") as Run), status: "running" }, spine.getAgent("agent_1")!, {
      spine, router: fakeRouter([{ content: [{ type: "text", text: "all done" }], stop: "end_turn" }]),
      tools, toolContext: { fs: {} as any, workspaceRoot: "/tmp" }, emit,
      startSubwork: async () => { throw new Error("must not restart"); },
      collectSubwork: (runId, toolUseId) => (runId === "run_1" && toolUseId === "tool_1" ? { result: "session result text" } : undefined),
    }, { resumeApproval: true });

    expect(stop).toBe("completed");
    // The committed step's tool message carries the subwork result.
    const ctx = spine.getContext("s1");
    const toolMsg = ctx.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("session result text");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/loop/subwork.test.ts -t "resume with a completed subwork"`
Expected: FAIL — the existing preamble calls `finishSuspendedTurn`, which re-executes the tool (throws "must not restart"), or produces no subwork tool_result.

- [ ] **Step 3: Add the subwork branch to the resume preamble**

In `src/loop/AgentLoop.ts`, replace the resume preamble (the `if (options.resumeApproval) { ... }` block) with one that disambiguates subwork from approval by inspecting the pending step:

```ts
    // Resume preamble: finish the suspended turn. A pending step holding a
    // suspendsForSubwork tool is a subwork resume (start-then-resuspend if the
    // session hasn't finished yet, else commit its result); otherwise it's the
    // ordinary approval resume.
    if (options.resumeApproval) {
      const pending = spine.getSteps(run.id).find((s) => s.state === "pending");
      const subworkCall = pending?.response?.find(
        (b): b is ToolUse => b.type === "tool_use" && (tools.get(b.name)?.suspendsForSubwork ?? false),
      );
      if (pending && subworkCall) {
        const collected = deps.collectSubwork?.(run.id, subworkCall.id);
        if (!collected) {
          // Approval was just granted but the session isn't started: start + park.
          if (deps.startSubwork) await deps.startSubwork(run, subworkCall, source);
          spine.setRunStatus(run.id, "suspended", { stopReason: "awaiting_subwork" });
          emit({ type: "run.suspended", stopReason: "awaiting_subwork" });
          return "awaiting_subwork";
        }
        const toolResults: ContentBlock[] = [
          { type: "tool_result", toolUseId: subworkCall.id, output: collected.result },
        ];
        spine.appendMessage(run.sessionKey, "tool", toolResults, run.id);
        spine.commitStep(run.id, pending.index, {
          response: pending.response!,
          toolResults,
          usage: pending.usage,
        });
        emit({ type: "step.committed", index: pending.index, usage: pending.usage });
        index++;
      } else {
        if (spine.pendingApprovalCount(run.id) > 0) return "awaiting_approval";
        if (await finishSuspendedTurn(run, deps, emit, index, source, policy)) index++;
      }
    }
```

> `ContentBlock` is already imported in this file. If `pending.response` is typed as possibly-undefined, the `subworkCall` guard plus `pending.response!` in `commitStep` are safe because `subworkCall` only exists when `pending.response` does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/loop/subwork.test.ts`
Expected: PASS (both subwork tests). Also run `npm test` to confirm the approval-resume path is unbroken.

- [ ] **Step 5: Commit**

```bash
git add src/loop/AgentLoop.ts tests/loop/subwork.test.ts
git commit -m "feat: agent loop resumes subwork — start-then-resuspend or commit the session result"
```

---

## Task 9: The `start_coding_session` tool

**Files:**
- Create: `src/tools/coding.ts`
- Test: `tests/coding/startCodingSessionTool.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/coding/startCodingSessionTool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { startCodingSession, codingTools } from "../../src/tools/coding.js";

describe("start_coding_session tool", () => {
  it("is registered with the subwork + approval flags and a directory/task schema", () => {
    expect(startCodingSession.name).toBe("start_coding_session");
    expect(startCodingSession.suspendsForSubwork).toBe(true);
    expect(startCodingSession.needsApproval).toBe(true);
    expect(startCodingSession.inputSchema.safeParse({ directory: "/tmp/x", task: "go" }).success).toBe(true);
    expect(startCodingSession.inputSchema.safeParse({ task: "go" }).success).toBe(false);
    expect(codingTools).toContain(startCodingSession);
  });

  it("run() throws — the loop handles subwork, the tool body is never reached", async () => {
    await expect(startCodingSession.run({ directory: "/tmp/x", task: "go" }, {} as any)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/coding/startCodingSessionTool.test.ts`
Expected: FAIL — module `src/tools/coding.ts` does not exist.

- [ ] **Step 3: Create the tool**

Create `src/tools/coding.ts`:

```ts
import { z } from "zod";
import type { Tool } from "./types.js";

// The agent-facing entry to coding-agent control: spawn an external Claude Code
// session in a directory with a task. It suspends the run (awaiting_subwork) until
// the session completes; the loop's startSubwork/collectSubwork hooks do the work,
// so run() is never executed for effect. needsApproval gates it — a proactive run
// has no approver and is denied; an interactive run gates for a human OK to spawn.
const inputSchema = z.object({
  directory: z.string().describe("Absolute path of the working directory for the session."),
  task: z.string().describe("The task/prompt to give the coding agent."),
  agentKind: z.string().optional().describe("Which coding agent (default: claude-code)."),
});

export const startCodingSession: Tool<z.infer<typeof inputSchema>> = {
  name: "start_coding_session",
  description:
    "Start an external coding-agent session (Claude Code) in a directory with a task. " +
    "The run suspends until the session finishes; its summary is returned as the result.",
  inputSchema,
  needsApproval: true,
  suspendsForSubwork: true,
  run: async () => {
    throw new Error("start_coding_session is handled by the loop's subwork hooks, not run()");
  },
};

export const codingTools: Tool[] = [startCodingSession];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/coding/startCodingSessionTool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/coding.ts tests/coding/startCodingSessionTool.test.ts
git commit -m "feat: start_coding_session tool (subwork + approval flags, loop-handled)"
```

---

## Task 10: Daemon wiring — register tool, hooks, resolve fork, completion→resume

Connect the agent path end to end.

**Files:**
- Modify: `src/daemon/Daemon.ts`
- Test: `tests/coding/daemonCoding.test.ts` (extend in Task 11)

- [ ] **Step 1: Register the coding tool**

In `src/daemon/Daemon.ts`, import and add to the registry loop:

```ts
import { codingTools } from "../tools/coding.js";
```

```ts
    for (const tool of [
      ...builtinTools,
      ...fileTools,
      ...shellTools,
      ...memoryTools,
      ...scheduleTools,
      ...introspectTools,
      ...codingTools,
    ]) {
      this.tools.register(tool);
    }
```

- [ ] **Step 2: Wire the subwork hooks into `runLoop`**

In `src/daemon/Daemon.ts` `runLoop`, add `startSubwork` and `collectSubwork` to the `runAgentLoop` deps object (alongside `policy`):

```ts
          startSubwork: async (r, call, src) => {
            const input = call.input as { directory: string; task: string; agentKind?: string };
            return this.coding.start({
              agentKind: input.agentKind ?? "claude-code",
              directory: input.directory,
              task: input.task,
              spawningRunId: r.id,
              spawningToolUseId: call.id,
              source: src,
            });
          },
          collectSubwork: (runId, toolUseId) => {
            const cs = this.spine.findCodingSessionBySubwork(runId, toolUseId);
            if (!cs || (cs.status !== "completed" && cs.status !== "failed")) return undefined;
            return { result: cs.result ?? `coding session ${cs.id} ${cs.status}` };
          },
```

- [ ] **Step 3: Fork `resolveApproval` to coding approvals**

In `src/daemon/Daemon.ts`, at the **top** of `resolveApproval`, handle coding approvals before the run-approval path:

```ts
  resolveApproval(approvalId: string, decision: string): boolean {
    // Coding-session approvals resolve into a keystroke injection, not a run resume.
    const coding = this.spine.getCodingApproval(approvalId);
    if (coding) {
      if (coding.status !== "pending") return false;
      const status = decision === "deny" ? "denied" : "allowed";
      this.spine.resolveCodingApproval(approvalId, status, decision);
      this.sink.emit({
        type: "approval.resolved",
        sessionKey: `coding:${coding.codingSessionId}`,
        runId: "",
        approvalId,
        decision: decision === "allow-always" ? "allow-always" : decision === "deny" ? "deny" : "allow-once",
      });
      this.coding.resolveCodingApproval(approvalId, decision);
      return true;
    }

    const approval = this.spine.getApproval(approvalId);
    // ... existing run-approval body unchanged ...
  }
```

> Because the daemon now calls `spine.resolveCodingApproval` first, `manager.resolveCodingApproval`'s own `pending` guard (Task 4) makes its internal `spine.resolveCodingApproval` a no-op re-stamp — keep the guard so calling the manager method directly in unit tests still flips the status.

- [ ] **Step 4: Enqueue a run resume when a spawned session completes**

In `src/daemon/Daemon.ts` `onSinkEvent`, add a branch:

```ts
    } else if (event.type === "coding.session.completed" || event.type === "coding.session.failed") {
      const cs = this.spine.getCodingSession(event.codingSessionId);
      if (cs?.spawningRunId) void this.inbox.enqueue({ kind: "resume", runId: cs.spawningRunId });
    }
```

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (no behavior change to existing tests; new wiring is exercised in Task 11).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/Daemon.ts
git commit -m "feat: daemon wires start_coding_session subwork hooks, coding-approval resolve fork, completion->resume"
```

---

## Task 11: Daemon end-to-end composition + cancellation

Prove the full agent path: an agent that calls `start_coding_session` suspends, the session runs (faked), completes, and the run resumes with the result. Plus cancellation propagation.

**Files:**
- Test: `tests/coding/daemonCoding.test.ts` (extend)
- Modify (if needed): `src/daemon/Daemon.ts` (`cancelCodingSession` already exists; add manager-run cancel→PTY kill if a gap is found)

- [ ] **Step 1: Write the failing test**

Read the existing `tests/coding/daemonCoding.test.ts` for its daemon construction helper and `FakeDriver`. Add a test that: registers an agent whose allowlist includes `start_coding_session`, uses a router stub that returns a `start_coding_session` tool_use then (on resume) ends, a policy that **allows** it (so we isolate subwork from the approval gate), and a `FakeDriver` whose handle we exit to drive completion.

```ts
  it("agent calls start_coding_session: run suspends awaiting_subwork, then resumes on completion", async () => {
    const { daemon, spine, driver } = setupDaemon({
      policy: { decide: () => ({ action: "allow" }) },
      router: scriptedRouter([
        { content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: tmpWorkdir, task: "go" } }], stop: "tool_use" },
        { content: [{ type: "text", text: "subwork done, continuing" }], stop: "end_turn" },
      ]),
      agentTools: ["start_coding_session"],
    });

    await daemon.message({ agentId: "agent_1", sessionKey: "s1", message: "please run claude code" });

    // The manager started a coding session linked to the run, and the run parked.
    const run = onlyRun(spine);
    expect(run.stopReason).toBe("awaiting_subwork");
    const cs = spine.listCodingSessions()[0]!;
    expect(cs.spawningRunId).toBe(run.id);
    expect(cs.spawningToolUseId).toBe("tool_1");

    // Complete the (faked) session → daemon enqueues a resume → run completes.
    driver.handle.die(0);
    await daemon.drainInbox(); // await the enqueued resume job (use the test's drain helper)

    expect(spine.getRun(run.id)!.status).toBe("completed");
  });
```

> Adapt `setupDaemon`, `scriptedRouter`, `onlyRun`, `tmpWorkdir`, and `drainInbox` to the helpers that already exist in `tests/coding/daemonCoding.test.ts` / `tests/daemon/*`. If the daemon exposes no inbox-drain hook, await on the `run.completed` event via the sink subscription the test already uses. The behavioral assertions (suspend → complete) are the contract; the plumbing matches the file's conventions.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/coding/daemonCoding.test.ts -t "start_coding_session"`
Expected: FAIL initially if any helper is missing; once helpers compile, it should drive the new wiring. Fix helper mismatches until the assertions run.

- [ ] **Step 3: Make it pass**

No new production code should be required if Tasks 1–10 are correct. If the run does not resume, verify: (a) `coding.session.completed` carries the right `codingSessionId`; (b) `onSinkEvent` looks the session up and enqueues `{kind:"resume"}`; (c) the resume preamble's `collectSubwork` returns the result (session status `completed`). Add targeted fixes only where a wiring gap is proven.

- [ ] **Step 4: Add the cancellation-propagation test**

```ts
  it("cancelling the manager run kills the coding session PTY", async () => {
    const { daemon, spine, driver } = setupDaemon({
      policy: { decide: () => ({ action: "allow" }) },
      router: scriptedRouter([
        { content: [{ type: "tool_use", id: "tool_1", name: "start_coding_session", input: { directory: tmpWorkdir, task: "go" } }], stop: "tool_use" },
      ]),
      agentTools: ["start_coding_session"],
    });
    await daemon.message({ agentId: "agent_1", sessionKey: "s1", message: "go" });
    const cs = spine.listCodingSessions()[0]!;
    daemon.cancel("s1"); // cancel the manager run's session
    expect(driver.handle.killed).toBe(true);
    expect(spine.getCodingSession(cs.id)!.status).toBe("cancelled");
  });
```

- [ ] **Step 5: Implement cancellation propagation if the test fails**

`Daemon.cancel(sessionKey)` aborts the run's `AbortController` but does not touch the coding session. Add propagation: when a manager run is cancelled, kill its spawned coding session. In `Daemon.cancel`, after aborting, look up and cancel any coding session spawned by the run on that session:

```ts
  cancel(sessionKey: string): boolean {
    const aborter = this.aborters.get(sessionKey);
    // Kill any coding session spawned by a suspended manager run on this session.
    for (const cs of this.spine.listCodingSessions()) {
      if (cs.spawningRunId && this.spine.getRun(cs.spawningRunId)?.sessionKey === sessionKey
          && cs.status !== "completed" && cs.status !== "failed" && cs.status !== "cancelled") {
        this.coding.cancel(cs.id);
      }
    }
    if (!aborter) return true; // a suspended run has no live aborter, but we still cancelled subwork
    aborter.abort();
    return true;
  }
```

> Verify against the existing `cancel` semantics/tests — if `cancel` returning `true` with no aborter breaks an existing assertion, narrow the change (e.g., return `aborter ? (aborter.abort(), true) : killedSubwork`). Keep existing cancellation tests green.

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS (all coding, loop, db, and daemon tests).

- [ ] **Step 7: Commit**

```bash
git add tests/coding/daemonCoding.test.ts src/daemon/Daemon.ts
git commit -m "test: end-to-end agent-initiated coding session (suspend->complete->resume) + cancellation propagation"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** A (Tasks 3–5), gate storage decision = `coding_approvals` table (Tasks 2, 4, 10), B `awaiting_subwork` (Tasks 6–8), C tool (Task 9) + daemon wiring (Task 10), two-suspend composition + cancellation (Task 11). `spawning_tool_use_id` (Task 1). Result-on-completion / DEEP-JSONL seed (Task 5).
- **Deferred (note, don't silently drop):** surface fan-out (desktop/webhook) + auto-deny expiry for coding approvals — v1 emits `approval.requested` (the TUI/event-log surface), which meets the "through the reef TUI" bar; richer surface routing reuses `routeApproval` later. `--resume`-on-boot recovery for a coding session left at a `pending` coding approval (the minted UUID makes it cheap; out of this slice).
- **Type consistency:** `CodingApprovalRecord.options` is `{index,label}[]` everywhere; `collectSubwork` returns `{result:string}|undefined`; `startSubwork(run, call, source)` returns the `cs_…` id; the resume preamble keys off `tools.get(name)?.suspendsForSubwork`.
- **Before each task:** the test scaffolding references helpers (`upsertAgent`, `scriptedRouter`, `setupDaemon`, `drainInbox`) — confirm exact names against the real files (`src/db/spine.ts`, `tests/loop/*`, `tests/coding/daemonCoding.test.ts`) and reuse the existing ones rather than inventing parallel helpers.
