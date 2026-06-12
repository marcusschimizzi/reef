// scripts/coding-session-smoke.ts
//
// Live verification of the PTY transport against a REAL Claude Code. Spawns a
// session in a temp dir with a trivial, mostly read-only task, streams output,
// auto-answers any prompt with option 1 after a short delay (logging it), and on
// exit prints the trace path. This is the iterate harness: run it, read the
// trace, tweak the scraper, replay the trace, re-run.
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
    setTimeout(() => {
      process.stdout.write("[reef] auto-answering 1\n");
      mgr.send(currentId, "1\r");
    }, 800);
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
setTimeout(() => {
  process.stdout.write("\n[reef] timeout — cancelling\n");
  mgr.cancel(currentId);
  setTimeout(() => process.exit(1), 2000);
}, 120_000);
