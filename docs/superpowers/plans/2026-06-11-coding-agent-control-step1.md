# Coding-Agent Control — Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reef can spawn a real interactive Claude Code over a PTY in a directory, stream + fully record everything to a replayable trace, crudely flag when a prompt is waiting, let an operator answer by sending keystrokes, and store the session durably.

**Architecture:** A pure, testable **stream processor** (raw terminal bytes → typed events) sits behind a thin **PTY driver** (node-pty glue). A **session manager** wires driver → flight-recorder trace → reef's event sink → the `coding_sessions` table. Operator control flows over the existing Unix socket. The same processor powers a **replay** path, so captured traces are deterministic test fixtures. Prompt *detection* is intentionally crude here — Step 2 grows it from real captured traces.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, better-sqlite3 (the spine), `node-pty` (new), the existing `EventSink` / socket / TUI.

**Design-for-testability rule:** all stream logic lives in `CodingStreamProcessor` (pure, unit-tested + replay-tested). `node-pty` appears in exactly one file (`ptyClaude.ts`) and is exercised only by the live smoke script. Everything else is testable without a real terminal.

---

### Task 1: Add the `node-pty` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install node-pty**

Run: `npm install node-pty`
Expected: `node-pty` appears under `dependencies` in `package.json`; `node_modules/node-pty` builds (prebuilt binary on macOS/Node).

- [ ] **Step 2: Verify it loads**

Run: `node -e "const pty=require('node-pty'); console.log(typeof pty.spawn)"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add node-pty for interactive coding-agent PTY transport"
```

---

### Task 2: ANSI-strip + crude prompt detection (pure helpers)

**Files:**
- Create: `src/coding/scrape.ts`
- Test: `tests/coding/scrape.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { stripAnsi, detectPrompt, parseOptions, fingerprint } from "../../src/coding/scrape.js";

describe("stripAnsi", () => {
  it("removes CSI color codes and cursor moves", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m\x1b[40Cgap")).toBe("redgap");
  });
});

describe("detectPrompt / parseOptions", () => {
  const frame = [
    "Bash command",
    "  git push origin main",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, allow all edits during this session",
    "  3. No",
  ].join("\n");

  it("detects a numbered option list with the cursor on option 1", () => {
    const options = detectPrompt(frame);
    expect(options).not.toBeNull();
    expect(options).toEqual([
      { index: 1, label: "Yes" },
      { index: 2, label: "Yes, allow all edits during this session" },
      { index: 3, label: "No" },
    ]);
  });

  it("returns null when no option list is present", () => {
    expect(detectPrompt("just some streaming output\nworking...")).toBeNull();
  });

  it("fingerprints a frame stably regardless of surrounding noise", () => {
    expect(fingerprint(`spinner ✶\n${frame}`)).toBe(fingerprint(`spinner ✻\n${frame}`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/scrape.test.ts`
Expected: FAIL — module `src/coding/scrape.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coding/scrape.ts
//
// Pure terminal-scraping helpers for the interactive coding-agent PTY transport.
// Step 1's prompt detection is deliberately CRUDE (a numbered option list with a
// cursor): real marker strings are grown in Step 2 from captured traces. Pure
// and deterministic so the same code runs live and over replayed traces.

export interface PromptOption {
  index: number;
  label: string;
}

/** Strip the ANSI sequences an interactive TUI emits (CSI, OSC, charset, etc.). */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // CSI (colors, cursor moves)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[()][AB0-2]/g, "") // charset select
    .replace(/\x1b[=>]/g, ""); // keypad mode
}

/** Whitespace-collapsed form — Ink renders option spacing as cursor moves that
 *  strip to no character, so matchers must test this variant too (gstack lesson). */
export function collapse(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Read a sequential `N. label` block (>=2 options) anchored at the last `1.`. */
export function parseOptions(stripped: string): PromptOption[] {
  const lines = stripped.split("\n");
  const options: PromptOption[] = [];
  let expected = 1;
  for (const line of lines) {
    const m = line.match(/^[\s❯>]*([1-9])\.\s*(\S.*?)\s*$/);
    if (!m) {
      if (options.length > 0) break; // the block ended
      continue;
    }
    const index = Number(m[1]);
    if (index !== expected) {
      if (options.length > 0) break;
      continue;
    }
    options.push({ index, label: m[2]! });
    expected += 1;
  }
  return options.length >= 2 ? options : [];
}

/** Crude "a prompt is waiting" check: a numbered option list with the cursor
 *  (`❯`) on option 1. Returns the parsed options, or null if no prompt. */
export function detectPrompt(stripped: string): PromptOption[] | null {
  const cursorOnOne = /❯\s*1\./.test(stripped) || /❯1\./.test(collapse(stripped));
  if (!cursorOnOne) return null;
  const options = parseOptions(stripped);
  return options.length >= 2 ? options : null;
}

/** A stable key for a detected prompt (its option labels), used to debounce TUI
 *  redraws — spinner glyphs and color changes must not re-fire the same prompt. */
export function fingerprint(stripped: string): string {
  return parseOptions(stripped)
    .map((o) => `${o.index}:${o.label}`)
    .join("|");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/scrape.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/coding/scrape.ts tests/coding/scrape.test.ts
git commit -m "feat: ANSI-strip + crude prompt detection for coding-agent PTY"
```

---

### Task 3: The stream processor (stateful, replay-ready)

**Files:**
- Create: `src/coding/processor.ts`
- Test: `tests/coding/processor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { CodingStreamProcessor } from "../../src/coding/processor.js";

describe("CodingStreamProcessor", () => {
  it("emits output for streamed chunks", () => {
    const p = new CodingStreamProcessor();
    const events = p.push("\x1b[32mhello\x1b[0m world");
    expect(events).toContainEqual({ type: "output", text: "hello world" });
  });

  it("emits prompt-pending once per distinct prompt (debounced across redraws)", () => {
    const p = new CodingStreamProcessor();
    const frame = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    const first = p.push(frame);
    expect(first.some((e) => e.type === "prompt-pending")).toBe(true);
    // a redraw (spinner change) of the same prompt must NOT re-fire
    const redraw = p.push("\x1b[2J❯ 1. Yes\n  2. No\n");
    expect(redraw.some((e) => e.type === "prompt-pending")).toBe(false);
  });

  it("re-fires after the prompt clears and a new one appears", () => {
    const p = new CodingStreamProcessor();
    p.push("❯ 1. Yes\n  2. No\n");
    p.push("\x1b[2Jworking on it...\n"); // prompt gone
    const again = p.push("❯ 1. Approve\n  2. Reject\n");
    expect(again.some((e) => e.type === "prompt-pending")).toBe(true);
  });

  it("emits exited on exit()", () => {
    const p = new CodingStreamProcessor();
    expect(p.exit(0)).toEqual([{ type: "exited", code: 0 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/processor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coding/processor.ts
//
// The verifiability spine: turns a stream of raw terminal bytes into typed
// DriverEvents. PURE of any I/O — the PTY driver feeds it live bytes and the
// replay harness feeds it recorded bytes through the EXACT same path, so a
// captured trace deterministically reproduces what the live session detected.

import { detectPrompt, fingerprint, stripAnsi, type PromptOption } from "./scrape.js";

export type DriverEvent =
  | { type: "output"; text: string }
  | { type: "prompt-pending"; promptText: string; options: PromptOption[] }
  | { type: "exited"; code: number | null };

const TAIL = 8000; // chars of raw scrollback kept for prompt detection

export class CodingStreamProcessor {
  private raw = "";
  private lastFingerprint = "";

  /** Feed a chunk of raw terminal bytes; return any events detected. */
  push(chunk: string): DriverEvent[] {
    const events: DriverEvent[] = [];

    const strippedChunk = stripAnsi(chunk);
    if (strippedChunk.trim().length > 0) {
      events.push({ type: "output", text: strippedChunk });
    }

    this.raw = (this.raw + chunk).slice(-TAIL);
    const stripped = stripAnsi(this.raw);
    const options = detectPrompt(stripped);
    if (options) {
      const fp = fingerprint(stripped);
      if (fp !== this.lastFingerprint) {
        this.lastFingerprint = fp;
        events.push({ type: "prompt-pending", promptText: promptTextOf(stripped), options });
      }
    } else {
      this.lastFingerprint = ""; // prompt cleared — allow the next one to fire
    }
    return events;
  }

  /** Signal the process exited. */
  exit(code: number | null): DriverEvent[] {
    return [{ type: "exited", code }];
  }
}

/** A short human-readable snapshot of the prompt region (the recent tail). */
function promptTextOf(stripped: string): string {
  return stripped.split("\n").slice(-12).join("\n").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/processor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/coding/processor.ts tests/coding/processor.test.ts
git commit -m "feat: CodingStreamProcessor (bytes to typed events, replay-ready)"
```

---

### Task 4: The flight-recorder trace

**Files:**
- Create: `src/coding/trace.ts`
- Test: `tests/coding/trace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter, readTrace } from "../../src/coding/trace.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-trace-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("TraceWriter / readTrace", () => {
  it("appends JSONL lines (each stamped) and reads them back", () => {
    const path = join(tmp(), "s.jsonl");
    const w = new TraceWriter(path);
    w.write({ type: "lifecycle", event: "spawn" });
    w.write({ type: "pty.raw", bytes: Buffer.from("hi").toString("base64") });
    w.write({ type: "event", event: { type: "exited", code: 0 } });
    w.close();

    const lines = readTrace(path);
    expect(lines.map((l) => l.type)).toEqual(["lifecycle", "pty.raw", "event"]);
    expect(typeof lines[0]!.t).toBe("number");
    expect(lines[1]).toMatchObject({ type: "pty.raw", bytes: Buffer.from("hi").toString("base64") });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/trace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coding/trace.ts
//
// The flight recorder. Every coding session writes a complete, timestamped JSONL
// trace: raw PTY bytes (ground truth), detected events, injections, lifecycle.
// Raw bytes make the session REPLAYABLE — the regression net for brittle scraping.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DriverEvent } from "./processor.js";

export type TraceBody =
  | { type: "pty.raw"; bytes: string } // base64 of exactly what the agent emitted
  | { type: "event"; event: DriverEvent }
  | { type: "inject"; data: string; reason: string }
  | { type: "lifecycle"; event: string; code?: number | null };

export type TraceLine = TraceBody & { t: number };

export class TraceWriter {
  private readonly fd: number;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }

  write(body: TraceBody): void {
    const line: TraceLine = { t: Date.now(), ...body };
    appendFileSync(this.fd, `${JSON.stringify(line)}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Parse a trace file into its lines (skips blanks/garbage defensively). */
export function readTrace(path: string): TraceLine[] {
  const out: TraceLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as TraceLine);
    } catch {
      // a partially-written final line on a crash — ignore
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/trace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coding/trace.ts tests/coding/trace.test.ts
git commit -m "feat: flight-recorder trace (raw-byte JSONL, replayable)"
```

---

### Task 5: `coding_sessions` table + spine methods

**Files:**
- Modify: `src/db/schema.ts` (add the table to the DDL)
- Modify: `src/db/spine.ts` (CRUD methods + a `CodingSessionRecord` type)
- Test: `tests/db/codingSessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";

const dirs: string[] = [];
const spine = () => { const d = mkdtempSync(join(tmpdir(), "reef-cs-")); dirs.push(d); return new Spine(join(d, "reef.db")); };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("coding_sessions spine", () => {
  it("creates, reads, updates status, and lists", () => {
    const s = spine();
    s.createCodingSession({
      id: "cs_1", spawningRunId: null, agentKind: "claude-code",
      externalSessionId: "uuid-1", directory: "/tmp/proj", status: "running",
      task: "list files", tracePath: "/tmp/proj/.trace.jsonl",
    });
    expect(s.getCodingSession("cs_1")).toMatchObject({ id: "cs_1", status: "running", agentKind: "claude-code" });

    s.setCodingSessionStatus("cs_1", "completed", "done");
    const done = s.getCodingSession("cs_1");
    expect(done).toMatchObject({ status: "completed", result: "done" });
    expect(done!.endedAt).toBeTruthy();

    expect(s.listCodingSessions().map((c) => c.id)).toEqual(["cs_1"]);
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/codingSessions.test.ts`
Expected: FAIL — `createCodingSession` is not a function.

- [ ] **Step 3a: Add the table to the DDL**

In `src/db/schema.ts`, append this block to the `DDL` template string (after the `events` table, before the closing backtick):

```sql
-- Interactive external coding sessions (Phase: coding-agent control). A session
-- reef drives over a PTY (Claude Code, etc.); `external_session_id` is the
-- reef-minted UUID passed to --session-id, enabling --resume after a lost PTY.
CREATE TABLE IF NOT EXISTS coding_sessions (
  id           TEXT PRIMARY KEY,
  spawning_run_id     TEXT,
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

- [ ] **Step 3b: Add the type + methods to the spine**

In `src/db/spine.ts`, add the type near the other record types:

```ts
export interface CodingSessionRecord {
  id: string;
  spawningRunId: string | null;
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

Add these methods to the `Spine` class (use `nowIso()` — already imported in spine.ts):

```ts
  // ── coding sessions ───────────────────────────────────────────────────────
  createCodingSession(rec: Omit<CodingSessionRecord, "createdAt" | "result" | "endedAt">): void {
    this.db
      .prepare(
        `INSERT INTO coding_sessions
           (id, spawning_run_id, agent_kind, external_session_id, directory, status, task, trace_path, created_at)
         VALUES (@id, @spawningRunId, @agentKind, @externalSessionId, @directory, @status, @task, @tracePath, @createdAt)`,
      )
      .run({ ...rec, createdAt: nowIso() });
  }

  getCodingSession(id: string): CodingSessionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM coding_sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCodingSession(row) : undefined;
  }

  setCodingSessionStatus(id: string, status: string, result?: string): void {
    const terminal = status === "completed" || status === "failed" || status === "cancelled";
    this.db
      .prepare(
        `UPDATE coding_sessions
            SET status = ?, result = COALESCE(?, result), ended_at = COALESCE(ended_at, ?)
          WHERE id = ?`,
      )
      .run(status, result ?? null, terminal ? nowIso() : null, id);
  }

  listCodingSessions(): CodingSessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM coding_sessions ORDER BY created_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToCodingSession);
  }
```

Add this mapper at the bottom of `src/db/spine.ts` (module scope, alongside other helpers):

```ts
function rowToCodingSession(row: Record<string, unknown>): CodingSessionRecord {
  return {
    id: row.id as string,
    spawningRunId: (row.spawning_run_id as string | null) ?? null,
    agentKind: row.agent_kind as string,
    externalSessionId: row.external_session_id as string,
    directory: row.directory as string,
    status: row.status as string,
    task: row.task as string,
    result: (row.result as string | null) ?? undefined,
    tracePath: row.trace_path as string,
    createdAt: row.created_at as string,
    endedAt: (row.ended_at as string | null) ?? undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/codingSessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/spine.ts tests/db/codingSessions.test.ts
git commit -m "feat: coding_sessions table + spine CRUD"
```

---

### Task 6: `coding.*` protocol events

**Files:**
- Modify: `src/protocol/events.ts`
- Test: `tests/coding/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { isEventType, type ReefEvent } from "../../src/protocol/events.js";

describe("coding.* events", () => {
  it("are part of the ReefEvent union and narrow correctly", () => {
    const e: ReefEvent = {
      seq: 1, ts: 0, sessionKey: "coding:cs_1", runId: "",
      type: "coding.output", codingSessionId: "cs_1", text: "hello",
    };
    expect(isEventType(e, "coding.output")).toBe(true);
    if (isEventType(e, "coding.output")) expect(e.text).toBe("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/events.test.ts`
Expected: FAIL — `"coding.output"` is not assignable to `ReefEvent["type"]`.

- [ ] **Step 3: Add the events to the union**

In `src/protocol/events.ts`, add this block inside the `ReefEvent` union (after the `session.model.changed` line):

```ts
    // ── coding-agent control (external interactive sessions over a PTY) ───────
    // A session reef drives (Claude Code, etc.). Carried on a synthetic sessionKey
    // `coding:<id>` with an empty runId (the session is not a reef run), so it
    // surfaces in the sessions view and event log like any other session.
    | { type: "coding.session.started"; codingSessionId: string; agentKind: string; directory: string }
    | { type: "coding.output"; codingSessionId: string; text: string }
    | {
        type: "coding.prompt.detected";
        codingSessionId: string;
        promptText: string;
        options: { index: number; label: string }[];
      }
    | { type: "coding.session.completed"; codingSessionId: string; result?: string }
    | { type: "coding.session.failed"; codingSessionId: string; error: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/events.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc clean (the transcript/sessionIndex `default` cases already ignore unknown types).

- [ ] **Step 5: Commit**

```bash
git add src/protocol/events.ts tests/coding/events.test.ts
git commit -m "feat: coding.* native protocol events"
```

---

### Task 7: The driver seam + the node-pty Claude driver

**Files:**
- Create: `src/coding/driver.ts` (interfaces only)
- Create: `src/coding/ptyClaude.ts` (the only file importing node-pty)
- Test: none (node-pty glue is covered by the live smoke in Task 11; logic lives in the processor, already tested)

- [ ] **Step 1: Write the driver seam**

```ts
// src/coding/driver.ts
//
// The transport seam. A driver owns the subprocess; it does NOT interpret output
// (that's CodingStreamProcessor). PTY transport now; a structured transport can
// implement the same interface later without touching the manager.

export interface StartOpts {
  directory: string;
  /** reef-minted UUID passed to the agent (e.g. claude --session-id). */
  sessionId: string;
  task: string;
  /** Off-transcript orchestration framing (e.g. claude --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Override the agent binary path; defaults to the agent's name on PATH. */
  bin?: string;
}

export interface CodingDriverHandle {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface CodingAgentDriver {
  start(opts: StartOpts): CodingDriverHandle;
}
```

- [ ] **Step 2: Write the node-pty Claude driver**

```ts
// src/coding/ptyClaude.ts
//
// The Claude Code PTY transport — the ONLY file that imports node-pty. Spawns the
// real interactive `claude` so usage bills against the Max plan (not the headless
// Agent-SDK credit pool). It just pumps bytes; CodingStreamProcessor interprets them.

import * as pty from "node-pty";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "./driver.js";

export class PtyClaudeDriver implements CodingAgentDriver {
  start(opts: StartOpts): CodingDriverHandle {
    const args = [
      "--session-id", opts.sessionId,
      ...(opts.appendSystemPrompt ? ["--append-system-prompt", opts.appendSystemPrompt] : []),
      opts.task,
    ];
    const proc = pty.spawn(opts.bin ?? "claude", args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.directory,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    return {
      onData: (cb) => { proc.onData(cb); },
      onExit: (cb) => { proc.onExit(({ exitCode }) => cb(exitCode)); },
      write: (data) => proc.write(data),
      kill: () => { try { proc.kill(); } catch { /* already dead */ } },
    };
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (If node-pty lacks bundled types, run `npm i -D @types/node-pty` — but modern node-pty ships its own.)

- [ ] **Step 4: Commit**

```bash
git add src/coding/driver.ts src/coding/ptyClaude.ts
git commit -m "feat: coding-agent driver seam + node-pty Claude transport"
```

---

### Task 8: The session manager (driver ↔ trace ↔ events ↔ spine)

**Files:**
- Create: `src/coding/manager.ts`
- Test: `tests/coding/manager.test.ts`

- [ ] **Step 1: Write the failing test (with a fake driver)**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../../src/db/spine.js";
import { CodingSessionManager } from "../../src/coding/manager.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ReefEvent, ReefEventInit } from "../../src/protocol/events.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-mgr-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class FakeHandle implements CodingDriverHandle {
  dataCb?: (c: string) => void; exitCb?: (c: number | null) => void;
  written: string[] = []; killed = false;
  onData(cb: (c: string) => void) { this.dataCb = cb; }
  onExit(cb: (c: number | null) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); }
  kill() { this.killed = true; }
  feed(chunk: string) { this.dataCb?.(chunk); }
  die(code: number | null) { this.exitCb?.(code); }
}
class FakeDriver implements CodingAgentDriver {
  handle = new FakeHandle();
  start(_opts: StartOpts): CodingDriverHandle { return this.handle; }
}

function setup() {
  const dir = tmp();
  const spine = new Spine(join(dir, "reef.db"));
  const events: ReefEvent[] = [];
  const emit = (e: ReefEventInit) => events.push({ ...e, seq: events.length, ts: 0 } as ReefEvent);
  const driver = new FakeDriver();
  const mgr = new CodingSessionManager({ spine, emit, driver, traceDir: join(dir, "traces") });
  return { spine, events, driver, mgr, dir };
}

describe("CodingSessionManager", () => {
  it("starts a session: row + started event + trace", () => {
    const { spine, events, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "list files" });
    expect(spine.getCodingSession(id)).toMatchObject({ status: "running", agentKind: "claude-code" });
    expect(events.find((e) => e.type === "coding.session.started")).toMatchObject({ codingSessionId: id });
  });

  it("forwards output and flags a detected prompt (status -> awaiting_decision)", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.feed("hello\n");
    driver.handle.feed("Do you want to proceed?\n❯ 1. Yes\n  2. No\n");
    expect(events.some((e) => e.type === "coding.output")).toBe(true);
    expect(events.find((e) => e.type === "coding.prompt.detected")).toMatchObject({ codingSessionId: id });
    expect(spine.getCodingSession(id)!.status).toBe("awaiting_decision");
  });

  it("send() injects to the driver; cancel() kills it", () => {
    const { driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    mgr.send(id, "1\r");
    expect(driver.handle.written).toContain("1\r");
    mgr.cancel(id);
    expect(driver.handle.killed).toBe(true);
  });

  it("on exit, marks completed and emits completed", () => {
    const { spine, events, driver, mgr } = setup();
    const id = mgr.start({ agentKind: "claude-code", directory: "/tmp/x", task: "t" });
    driver.handle.die(0);
    expect(spine.getCodingSession(id)!.status).toBe("completed");
    expect(events.some((e) => e.type === "coding.session.completed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coding/manager.ts
//
// Wires a coding-agent driver to reef's substrate: mints ids, records the trace,
// emits coding.* events, and tracks status in coding_sessions. Step 1 routes a
// detected prompt to status `awaiting_decision` and leaves answering to the
// operator via send() (policy-driven auto-answer is Step 3). Driver is injected
// so the whole thing is unit-testable without a real PTY.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Spine } from "../db/spine.js";
import type { EmitFn } from "../protocol/events.js";
import { CodingStreamProcessor, type DriverEvent } from "./processor.js";
import type { CodingAgentDriver, CodingDriverHandle } from "./driver.js";
import { TraceWriter } from "./trace.js";

export interface CodingSessionManagerDeps {
  spine: Spine;
  emit: EmitFn;
  driver: CodingAgentDriver;
  traceDir: string;
  appendSystemPrompt?: string;
}

export interface StartCodingSession {
  agentKind: string;
  directory: string;
  task: string;
  spawningRunId?: string | null;
}

interface Live {
  handle: CodingDriverHandle;
  processor: CodingStreamProcessor;
  trace: TraceWriter;
}

export class CodingSessionManager {
  private readonly live = new Map<string, Live>();
  constructor(private readonly deps: CodingSessionManagerDeps) {}

  start(opts: StartCodingSession): string {
    const externalSessionId = randomUUID();
    const id = `cs_${externalSessionId}`;
    const tracePath = join(this.deps.traceDir, `${id}.jsonl`);

    this.deps.spine.createCodingSession({
      id,
      spawningRunId: opts.spawningRunId ?? null,
      agentKind: opts.agentKind,
      externalSessionId,
      directory: opts.directory,
      status: "running",
      task: opts.task,
      tracePath,
    });

    const trace = new TraceWriter(tracePath);
    trace.write({ type: "lifecycle", event: "spawn" });
    const processor = new CodingStreamProcessor();
    const handle = this.deps.driver.start({
      directory: opts.directory,
      sessionId: externalSessionId,
      task: opts.task,
      appendSystemPrompt: this.deps.appendSystemPrompt,
    });
    this.live.set(id, { handle, processor, trace });

    this.emitCoding(id, { type: "coding.session.started", codingSessionId: id, agentKind: opts.agentKind, directory: opts.directory });

    handle.onData((chunk) => {
      trace.write({ type: "pty.raw", bytes: Buffer.from(chunk, "utf8").toString("base64") });
      for (const ev of processor.push(chunk)) this.onDriverEvent(id, ev);
    });
    handle.onExit((code) => {
      trace.write({ type: "lifecycle", event: "exit", code });
      const status = code === 0 || code === null ? "completed" : "failed";
      this.deps.spine.setCodingSessionStatus(id, status);
      if (status === "completed") {
        this.emitCoding(id, { type: "coding.session.completed", codingSessionId: id });
      } else {
        this.emitCoding(id, { type: "coding.session.failed", codingSessionId: id, error: `exited with code ${code}` });
      }
      trace.close();
      this.live.delete(id);
    });

    return id;
  }

  /** Inject raw keystrokes (operator answering a prompt by hand in Step 1). */
  send(id: string, data: string): void {
    const l = this.live.get(id);
    if (!l) return;
    l.trace.write({ type: "inject", data, reason: "operator" });
    l.handle.write(data);
  }

  cancel(id: string): void {
    this.live.get(id)?.handle.kill();
  }

  private onDriverEvent(id: string, ev: DriverEvent): void {
    const l = this.live.get(id);
    l?.trace.write({ type: "event", event: ev });
    if (ev.type === "output") {
      this.emitCoding(id, { type: "coding.output", codingSessionId: id, text: ev.text });
    } else if (ev.type === "prompt-pending") {
      this.deps.spine.setCodingSessionStatus(id, "awaiting_decision");
      this.emitCoding(id, { type: "coding.prompt.detected", codingSessionId: id, promptText: ev.promptText, options: ev.options });
    }
  }

  private emitCoding(id: string, body: { type: string } & Record<string, unknown>): void {
    this.deps.emit({ ...body, sessionKey: `coding:${id}`, runId: "" } as Parameters<EmitFn>[0]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/coding/manager.ts tests/coding/manager.test.ts
git commit -m "feat: CodingSessionManager (driver to trace/events/spine)"
```

---

### Task 9: The replay harness

**Files:**
- Create: `src/coding/replay.ts`
- Test: `tests/coding/replay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../../src/coding/trace.js";
import { replayTrace } from "../../src/coding/replay.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-replay-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("replayTrace", () => {
  it("re-derives events by feeding recorded raw bytes back through the processor", () => {
    const path = join(tmp(), "s.jsonl");
    const w = new TraceWriter(path);
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    w.write({ type: "pty.raw", bytes: b64("working...\n") });
    w.write({ type: "pty.raw", bytes: b64("Do you want to proceed?\n❯ 1. Yes\n  2. No\n") });
    w.close();

    const events = replayTrace(path);
    expect(events.some((e) => e.type === "prompt-pending")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/coding/replay.ts
//
// Deterministic replay: feed a trace's recorded raw bytes back through a fresh
// CodingStreamProcessor — the EXACT path the live session used. This is how the
// brittle scraping is iterated and regression-tested: a captured session is a
// fixture; "why didn't it detect that prompt?" is debugged offline, no `claude`.

import { CodingStreamProcessor, type DriverEvent } from "./processor.js";
import { readTrace } from "./trace.js";

export function replayTrace(path: string): DriverEvent[] {
  const processor = new CodingStreamProcessor();
  const events: DriverEvent[] = [];
  for (const line of readTrace(path)) {
    if (line.type === "pty.raw") {
      const chunk = Buffer.from(line.bytes, "base64").toString("utf8");
      events.push(...processor.push(chunk));
    }
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/coding/replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/coding/replay.ts tests/coding/replay.test.ts
git commit -m "feat: deterministic trace replay (captured sessions as fixtures)"
```

---

### Task 10: Daemon wiring + socket controls

**Files:**
- Modify: `src/daemon/Daemon.ts` (own a `CodingSessionManager`; expose start/send/cancel)
- Modify: `src/daemon/socket.ts` (control requests)
- Modify: `src/daemon/index.ts` (construct the manager with the real PtyClaudeDriver)
- Test: `tests/coding/daemonCoding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import type { CodingAgentDriver, CodingDriverHandle, StartOpts } from "../../src/coding/driver.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "reef-dc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class NullRouter implements ModelRouter { async generateTurn(_i: ModelTurnInput): Promise<ModelTurn> { throw new Error("unused"); } }
class FakeHandle implements CodingDriverHandle {
  dataCb?: (c: string) => void; exitCb?: (c: number | null) => void; written: string[] = []; killed = false;
  onData(cb: (c: string) => void) { this.dataCb = cb; } onExit(cb: (c: number | null) => void) { this.exitCb = cb; }
  write(d: string) { this.written.push(d); } kill() { this.killed = true; }
}
class FakeDriver implements CodingAgentDriver { handle = new FakeHandle(); start(_o: StartOpts): CodingDriverHandle { return this.handle; } }

describe("Daemon coding-session control", () => {
  it("starts, sends, and cancels a coding session via the daemon API", () => {
    const dir = tmp();
    const driver = new FakeDriver();
    const d = new Daemon({ dbPath: join(dir, "reef.db"), workspaceDir: join(dir, "ws"), router: new NullRouter(), codingDriver: driver });
    const id = d.startCodingSession({ agentKind: "claude-code", directory: dir, task: "list" });
    expect(d.spine.getCodingSession(id)!.status).toBe("running");
    d.sendToCodingSession(id, "1\r");
    expect(driver.handle.written).toContain("1\r");
    d.cancelCodingSession(id);
    expect(driver.handle.killed).toBe(true);
    d.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/coding/daemonCoding.test.ts`
Expected: FAIL — `codingDriver` not in `DaemonOptions`; `startCodingSession` not a method.

- [ ] **Step 3a: Wire the manager into the Daemon**

In `src/daemon/Daemon.ts`:

Add imports near the other coding-free imports:

```ts
import { CodingSessionManager } from "../coding/manager.js";
import { PtyClaudeDriver } from "../coding/ptyClaude.js";
import type { CodingAgentDriver } from "../coding/driver.js";
```

Add to `DaemonOptions`:

```ts
  /** Coding-agent transport; defaults to the node-pty Claude driver. Injectable for tests. */
  codingDriver?: CodingAgentDriver;
  /** Directory for coding-session flight-recorder traces; defaults to <home>/coding-sessions. */
  codingTraceDir?: string;
```

Add a field and construct it in the constructor (after `this.inbox` is set):

```ts
  private readonly coding: CodingSessionManager;
```

```ts
    this.coding = new CodingSessionManager({
      spine: this.spine,
      emit: this.sink.emit,
      driver: opts.codingDriver ?? new PtyClaudeDriver(),
      traceDir: opts.codingTraceDir ?? join(opts.workspaceDir, "..", "coding-sessions"),
    });
```

Add public methods (near `setSessionModel`):

```ts
  // ── coding-agent control (operator-initiated in Step 1) ─────────────────────
  startCodingSession(opts: { agentKind: string; directory: string; task: string }): string {
    return this.coding.start(opts);
  }
  sendToCodingSession(id: string, data: string): void {
    this.coding.send(id, data);
  }
  cancelCodingSession(id: string): void {
    this.coding.cancel(id);
  }
```

- [ ] **Step 3b: Add socket controls**

In `src/daemon/socket.ts`, extend the `ControlRequest` union:

```ts
  | { kind: "coding_start"; directory: string; task: string; agentKind?: string }
  | { kind: "coding_send"; codingSessionId: string; data: string }
  | { kind: "coding_cancel"; codingSessionId: string }
```

Add cases in `handleLine`'s switch:

```ts
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
```

- [ ] **Step 3c: (index.ts) no change needed**

`src/daemon/index.ts` constructs `new Daemon({...})` without `codingDriver`, so the real `PtyClaudeDriver` is used by default. Confirm it still compiles.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/coding/daemonCoding.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/Daemon.ts src/daemon/socket.ts tests/coding/daemonCoding.test.ts
git commit -m "feat: daemon coding-session control + socket commands"
```

---

### Task 11: Live smoke script (the iterate harness)

**Files:**
- Create: `scripts/coding-session-smoke.ts`
- Test: live (manual) — requires `claude` logged in via your plan.

- [ ] **Step 1: Write the smoke script**

```ts
// scripts/coding-session-smoke.ts
//
// Live verification of the PTY transport against a REAL Claude Code. Spawns a
// session in a temp dir with a trivial, mostly read-only task, streams output,
// auto-answers any prompt with option 1 after a short delay (logging it), and on
// exit prints the trace path + a timeline. This is the iterate harness: run it,
// read the trace, tweak the scraper, replay the trace, re-run.
//
// Run: npx tsx scripts/coding-session-smoke.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../src/db/spine.js";
import { CodingSessionManager } from "../src/coding/manager.js";
import { PtyClaudeDriver } from "../src/coding/ptyClaude.js";
import type { ReefEventInit } from "../src/protocol/events.js";

const dir = mkdtempSync(join(tmpdir(), "reef-coding-smoke-"));
writeFileSync(join(dir, "NOTES.md"), "# Smoke test\n\nA file for the agent to read.\n");

const spine = new Spine(join(dir, "reef.db"));
const traceDir = join(dir, "traces");
let currentId = "";

const emit = (e: ReefEventInit): void => {
  const ev = e as { type: string; text?: string; options?: unknown };
  if (ev.type === "coding.output" && ev.text) process.stdout.write(ev.text);
  if (ev.type === "coding.prompt.detected") {
    process.stdout.write(`\n[reef] PROMPT DETECTED: ${JSON.stringify(ev.options)}\n`);
    setTimeout(() => { process.stdout.write("[reef] auto-answering 1\n"); mgr.send(currentId, "1\r"); }, 800);
  }
  if (ev.type === "coding.session.completed" || ev.type === "coding.session.failed") {
    const rec = spine.getCodingSession(currentId);
    process.stdout.write(`\n[reef] session ${ev.type}; trace: ${rec?.tracePath}\n`);
    spine.close();
    process.exit(0);
  }
};

const mgr = new CodingSessionManager({ spine, emit, driver: new PtyClaudeDriver(), traceDir });
currentId = mgr.start({
  agentKind: "claude-code",
  directory: dir,
  task: "Read NOTES.md and tell me in one sentence what it says. Do not modify anything.",
});
process.stdout.write(`[reef] started coding session ${currentId} in ${dir}\n`);

// Safety: hard stop after 120s.
setTimeout(() => { process.stdout.write("\n[reef] timeout — cancelling\n"); mgr.cancel(currentId); setTimeout(() => process.exit(1), 2000); }, 120_000);
```

- [ ] **Step 2: Run the live smoke**

Run: `npx tsx scripts/coding-session-smoke.ts`
Expected: real Claude Code output streams to your terminal; any approval prompt is detected + auto-answered with `1`; on completion the trace path prints. (If `claude` is not on PATH, set `bin` via the driver or install it.)

- [ ] **Step 3: Replay the captured trace**

Run: `npx tsx -e "import('./src/coding/replay.js').then(m=>console.log(JSON.stringify(m.replayTrace(process.argv[1]),null,2)))" <trace-path-from-step-2>`
Expected: the same `prompt-pending`/`output` events re-derived offline — proving replay fidelity.

- [ ] **Step 4: Commit**

```bash
git add scripts/coding-session-smoke.ts
git commit -m "feat: live coding-session smoke + replay harness"
```

---

### Task 12: Minimal TUI rendering of coding output

**Files:**
- Modify: `src/client/tui/transcript.ts` (render `coding.output` / `coding.prompt.detected` as transcript items)
- Test: `tests/client/codingTranscript.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { initialState, reduceEvent } from "../../src/client/tui/transcript.js";
import type { ReefEvent } from "../../src/protocol/events.js";

const ev = (body: Partial<ReefEvent> & { type: ReefEvent["type"] }): ReefEvent =>
  ({ seq: 1, ts: 0, sessionKey: "coding:cs_1", runId: "", ...body }) as ReefEvent;

describe("transcript renders coding.* events", () => {
  it("appends coding output and a prompt notice", () => {
    let s = reduceEvent(initialState, ev({ type: "coding.output", codingSessionId: "cs_1", text: "building..." } as Partial<ReefEvent> & { type: ReefEvent["type"] }));
    s = reduceEvent(s, ev({ type: "coding.prompt.detected", codingSessionId: "cs_1", promptText: "Proceed?", options: [{ index: 1, label: "Yes" }, { index: 2, label: "No" }] } as Partial<ReefEvent> & { type: ReefEvent["type"] }));
    const text = s.items.map((i) => ("text" in i ? i.text : "")).join("\n");
    expect(text).toContain("building...");
    expect(text).toContain("Yes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/codingTranscript.test.ts`
Expected: FAIL — coding events fall through `reduceEvent`'s default and produce no items.

- [ ] **Step 3: Add cases to `reduceEvent`**

In `src/client/tui/transcript.ts`, inside `reduceEvent`'s `switch (event.type)` (before `default:`), add (reusing the existing `pushNotice` helper defined in this file, so no new item kind is introduced):

```ts
    case "coding.output":
      return pushNotice(state, event.text);

    case "coding.prompt.detected":
      return pushNotice(
        state,
        `coding agent needs a decision:\n${event.promptText}\n${event.options
          .map((o) => `  ${o.index}. ${o.label}`)
          .join("\n")}`,
      );
```

Note: `pushNotice` already exists in `transcript.ts` (it's the helper `App.tsx` uses for `/help`), so this introduces no new transcript item shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/codingTranscript.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/client/tui/transcript.ts tests/client/codingTranscript.test.ts
git commit -m "feat: render coding.* events in the TUI transcript"
```

---

### Final: full suite + Step 1 exit check

- [ ] **Step 1: Run the whole non-live suite**

Run: `npx tsc --noEmit && npx vitest run --exclude '**/live/**'`
Expected: all green (existing + ~20 new tests).

- [ ] **Step 2: Exit-criterion demo (manual)**

Start the daemon (`npm run daemon`), then drive a coding session over the socket (or via `scripts/coding-session-smoke.ts`): spawn real Claude Code in a temp dir, watch output stream, answer a prompt by sending `1\r`, and confirm the trace at `~/.reef/coding-sessions/<id>.jsonl` captured raw bytes and replays via `replayTrace`. **This is Step 1 done — the recorder + raw pump + human-as-classifier loop works against real Claude Code.**

---

## Self-review notes (coverage)

- Spec "flight recorder + replay" → Tasks 4, 9 (+ smoke 11). ✓
- Spec "PtyClaudeDriver / transport seam" → Tasks 7. ✓
- Spec "crude detection, human-as-classifier" → Tasks 2, 3, 8 (status `awaiting_decision`), 11 (operator/auto-answer), 12 (TUI notice). ✓
- Spec "coding_sessions substrate + coding.* events" → Tasks 5, 6. ✓
- Spec "operator-initiated start (control command + smoke)" → Tasks 10, 11. ✓
- Spec "reef-minted `--session-id` UUID" → Task 8 (`externalSessionId = randomUUID()`), Task 7 (passed to `claude --session-id`). ✓
- **Deferred to Step 2/3 (correctly not here):** marker-based classifier from real traces + LLM-judge (Step 2); `ApprovalPolicy` auto-answer + `awaiting_subwork` suspend/resume + the agent `start_coding_session` tool + `.claude/settings.json` pre-auth + cancellation propagation (Step 3); the full split-view (polish).
