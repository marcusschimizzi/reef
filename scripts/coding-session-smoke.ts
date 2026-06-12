// scripts/coding-session-smoke.ts
//
// Live verification of the PTY transport + the Step-3 policy flow against a REAL
// Claude Code. Spawns a session in a temp dir with a trivial, read-only task on a
// CHEAP model (haiku by default, via REEF_CODING_MODEL / --model), streams output,
// and lets reef's ApprovalPolicy auto-answer detected prompts (an allow-all policy
// here, so the manager's auto-inject path is exercised end-to-end — no manual send).
// On exit it prints the captured result + the trace path.
//
// Run: npx tsx scripts/coding-session-smoke.ts            (defaults to haiku)
//      REEF_CODING_MODEL=sonnet npx tsx scripts/coding-session-smoke.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../src/db/spine.js";
import { CodingSessionManager } from "../src/coding/manager.js";
import { PtyClaudeDriver } from "../src/coding/ptyClaude.js";
import type { ApprovalPolicy } from "../src/policy/policy.js";
import type { ReefEventInit } from "../src/protocol/events.js";

const dir = mkdtempSync(join(tmpdir(), "reef-coding-smoke-"));
writeFileSync(join(dir, "NOTES.md"), "# Smoke test\n\nA file for the agent to read.\n");

const spine = new Spine(join(dir, "reef.db"));
const traceDir = join(dir, "traces");
let currentId = "";

// Allow-all: every detected prompt is auto-answered by reef's policy flow (the
// thing we're verifying). Swap for DefaultPolicy to exercise the gate path.
const policy: ApprovalPolicy = { decide: () => ({ action: "allow" }) };

const emit = (e: ReefEventInit): void => {
  const ev = e as { type: string; text?: string; options?: unknown; result?: string };
  if (ev.type === "coding.output" && ev.text) process.stdout.write(ev.text);
  if (ev.type === "coding.prompt.detected") {
    process.stdout.write(`\n[reef] PROMPT DETECTED: ${JSON.stringify(ev.options)} — policy deciding…\n`);
  }
  if (
    ev.type === "coding.session.paused" ||
    ev.type === "coding.session.completed" ||
    ev.type === "coding.session.failed"
  ) {
    const rec = spine.getCodingSession(currentId);
    process.stdout.write(`\n[reef] session ${ev.type}\n`);
    process.stdout.write(`[reef] result: ${rec?.result ?? "(none captured)"}\n`);
    process.stdout.write(`[reef] status: ${rec?.status}; resumable via --resume ${rec?.externalSessionId}\n`);
    process.stdout.write(`[reef] trace: ${rec?.tracePath}\n`);
    spine.close();
    process.exit(0);
  }
};

const mgr = new CodingSessionManager({ spine, emit, policy, driver: new PtyClaudeDriver(), traceDir });
currentId = mgr.start({
  agentKind: "claude-code",
  directory: dir,
  model: process.env.REEF_CODING_MODEL ?? "haiku",
  task: "Read NOTES.md and tell me in one sentence what it says. Do not modify anything.",
});
process.stdout.write(`[reef] started coding session ${currentId} in ${dir} (model: ${process.env.REEF_CODING_MODEL ?? "haiku"})\n`);

// Safety: hard stop after 120s.
setTimeout(() => {
  process.stdout.write("\n[reef] timeout — cancelling\n");
  mgr.cancel(currentId);
  setTimeout(() => process.exit(1), 2000);
}, 120_000);
