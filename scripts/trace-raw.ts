// scripts/trace-raw.ts
//
// Dump the raw terminal bytes of a captured trace around a search term, with
// escape sequences made visible (\e, \r, \n) — for studying exactly how the
// coding agent's TUI renders a prompt, so the scraper can be grown from truth.
// Run: npx tsx scripts/trace-raw.ts <trace.jsonl> <search> [before] [after]

import { readTrace } from "../src/coding/trace.js";

const path = process.argv[2];
const search = process.argv[3] ?? "";
const before = Number(process.argv[4] ?? 140);
const after = Number(process.argv[5] ?? 120);
if (!path) {
  process.stderr.write("usage: npx tsx scripts/trace-raw.ts <trace.jsonl> <search> [before] [after]\n");
  process.exit(1);
}

let raw = "";
for (const l of readTrace(path)) {
  if (l.type === "pty.raw") raw += Buffer.from(l.bytes, "base64").toString("utf8");
}

const idx = search ? raw.indexOf(search) : 0;
if (idx === -1) {
  process.stdout.write(`"${search}" not found in ${raw.length} bytes of raw output\n`);
  process.exit(0);
}
const region = raw.slice(Math.max(0, idx - before), idx + after);
const vis = region
  .replace(/\x1b/g, "\\e")
  .replace(/\r/g, "\\r")
  .replace(/\n/g, "\\n\n");
process.stdout.write(`=== raw around "${search}" (idx ${idx} of ${raw.length}) ===\n${vis}\n`);
