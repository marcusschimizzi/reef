// scripts/trace-inspect.ts
//
// Inspect a captured coding-session trace: line-type counts, what the LIVE run
// detected, and a REPLAY (re-derive events from the recorded raw bytes through
// the same processor) — proving replay fidelity. The core dev aid for iterating
// the scraper offline. Run: npx tsx scripts/trace-inspect.ts <trace.jsonl>

import { readTrace } from "../src/coding/trace.js";
import { replayTrace } from "../src/coding/replay.js";
import { stripAnsi } from "../src/coding/scrape.js";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: npx tsx scripts/trace-inspect.ts <trace.jsonl>\n");
  process.exit(1);
}

const lines = readTrace(path);
const counts: Record<string, number> = {};
for (const l of lines) counts[l.type] = (counts[l.type] ?? 0) + 1;
process.stdout.write(`trace: ${path}\nline types: ${JSON.stringify(counts)}\n`);

let raw = "";
for (const l of lines) if (l.type === "pty.raw") raw += Buffer.from(l.bytes, "base64").toString("utf8");
process.stdout.write(`total raw bytes: ${raw.length}\n`);

const livePrompts = lines.filter((l) => l.type === "event" && l.event.type === "prompt-pending").length;
const replayed = replayTrace(path);
const replayPrompts = replayed.filter((e) => e.type === "prompt-pending");
process.stdout.write(`live prompt-pending: ${livePrompts} | replay prompt-pending: ${replayPrompts.length} | match: ${livePrompts === replayPrompts.length}\n`);
for (const p of replayPrompts) if (p.type === "prompt-pending") process.stdout.write(`  options: ${JSON.stringify(p.options)}\n`);

process.stdout.write(`\n=== stripped tail (last 800 chars) ===\n${stripAnsi(raw).slice(-800)}\n`);
