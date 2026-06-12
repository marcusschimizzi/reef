// scripts/capture-fixture.ts
//
// Capture a REAL Claude Code session trace as a committed test fixture. Spawns a
// session in a temp dir with the given task, auto-answers any detected prompt
// with option 1, and saves the trace to tests/coding/fixtures/<name>.jsonl on
// completion (or after a time budget — Claude Code's interactive REPL doesn't
// self-exit, so we cancel to flush the trace). Used to grow the scraper from
// real prompt shapes (Bash approval, edit approval, …).
//
// Run: npx tsx scripts/capture-fixture.ts <name> "<task>" [seconds]

import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spine } from "../src/db/spine.js";
import { CodingSessionManager } from "../src/coding/manager.js";
import { PtyClaudeDriver } from "../src/coding/ptyClaude.js";
import type { ReefEventInit } from "../src/protocol/events.js";

const name = process.argv[2];
const task = process.argv[3];
const seconds = Number(process.argv[4] ?? 50);
if (!name || !task) {
  process.stderr.write('usage: npx tsx scripts/capture-fixture.ts <name> "<task>" [seconds]\n');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "reef-fixture-"));
writeFileSync(join(dir, "NOTES.md"), "# Notes\n\nSample content the agent may read.\n");
const spine = new Spine(join(dir, "reef.db"));
let id = "";
let saved = false;

function save(): void {
  if (saved) return;
  saved = true;
  const rec = spine.getCodingSession(id);
  const dest = join("tests/coding/fixtures", `${name}.jsonl`);
  mkdirSync("tests/coding/fixtures", { recursive: true });
  if (rec) copyFileSync(rec.tracePath, dest);
  process.stdout.write(`\n[capture] saved ${dest}\n`);
  spine.close();
  process.exit(0);
}

function emit(e: ReefEventInit): void {
  const ev = e as { type: string; text?: string; options?: unknown };
  if (ev.type === "coding.output" && ev.text) process.stdout.write(ev.text);
  if (ev.type === "coding.prompt.detected") {
    process.stdout.write(`\n[capture] PROMPT: ${JSON.stringify(ev.options)} -> answering 1\n`);
    setTimeout(() => mgr.send(id, "1\r"), 700);
  }
  if (ev.type === "coding.session.completed" || ev.type === "coding.session.failed") save();
}

const mgr = new CodingSessionManager({ spine, emit, driver: new PtyClaudeDriver(), traceDir: join(dir, "traces") });
id = mgr.start({ agentKind: "claude-code", directory: dir, task });
process.stdout.write(`[capture] ${name}: session ${id} in ${dir}\n`);

setTimeout(() => {
  process.stdout.write("\n[capture] time budget reached — cancelling to flush the trace\n");
  mgr.cancel(id);
}, seconds * 1000);
