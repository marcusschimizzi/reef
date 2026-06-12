// src/coding/scrape.ts
//
// Pure terminal-scraping helpers for the interactive coding-agent PTY transport.
// Step 1's prompt detection is deliberately CRUDE (a numbered option list with a
// cursor): real marker strings are grown later from captured traces. Pure and
// deterministic so the same code runs live and over replayed traces.

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
