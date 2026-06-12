// src/coding/processor.ts
//
// The verifiability spine: turns a stream of raw terminal bytes into typed
// DriverEvents. PURE of any I/O — the PTY driver feeds it live bytes and the
// replay harness feeds it recorded bytes through the EXACT same path, so a
// captured trace deterministically reproduces what the live session detected.

import { detectPrompt, fingerprint, stripAnsi, type PromptOption } from "./scrape.js";
import { renderText } from "./render.js";

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

    // \x1b[2J (erase display) signals a full screen clear — discard old scrollback
    // so that cleared prompts don't linger in the detection window.
    const clearIdx = chunk.lastIndexOf("\x1b[2J");
    if (clearIdx !== -1) {
      this.raw = chunk.slice(clearIdx + "\x1b[2J".length);
    } else {
      this.raw = (this.raw + chunk).slice(-TAIL);
    }
    // Detect on the RENDERED screen (cursor-positioning escapes reconstructed to
    // real spacing), not the fused stripAnsi text — so option labels are readable.
    const screen = renderText(this.raw);
    const options = detectPrompt(screen);
    if (options) {
      const fp = fingerprint(screen);
      if (fp !== this.lastFingerprint) {
        this.lastFingerprint = fp;
        events.push({ type: "prompt-pending", promptText: promptTextOf(screen), options });
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
