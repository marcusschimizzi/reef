// src/coding/handback.ts
//
// "Handback" — the signal that an external coding agent has FINISHED the requested
// increment and is waiting for further instructions. Interactive `claude` does not
// exit after a task (it sits at its prompt), so reef needs an explicit signal to
// know an increment is done, capture the result, and resume the manager run. This
// is increment-done, NOT permanently-done: the session is parked `paused` and stays
// revivable via `claude --resume <uuid>`. Only the user ends a session for good.

/** A distinctive, whitespace-free marker the agent prints when it has finished the
 *  task. Whitespace-free so the Ink TUI's column-positioning can't fracture it. */
export const HANDBACK_MARKER = "<<REEF_HANDBACK>>";

/** The off-transcript instruction injected via `claude --append-system-prompt`,
 *  teaching the agent the handback protocol. Phrased emphatically with the rationale
 *  because it is appended after Claude Code's large default system prompt (low
 *  salience) and weaker models skip soft instructions — the idle timer is the net. */
export const HANDBACK_INSTRUCTION =
  `## Handback protocol (REQUIRED)\n` +
  `You are being driven by an automated orchestrator that needs to know the moment ` +
  `you have finished and are waiting for input. When you have fully addressed the ` +
  `request — INCLUDING short or simple answers — you MUST end your final message with ` +
  `this exact marker on a line by itself, as the very last thing you output:\n` +
  `${HANDBACK_MARKER}\n` +
  `Output nothing after it. Do this every time you finish a turn and are waiting for ` +
  `further instructions. The marker is how the orchestrator detects you are done; if ` +
  `you omit it, the session stalls.`;

/** True when rendered output contains the handback marker. */
export function containsHandback(text: string): boolean {
  return text.includes(HANDBACK_MARKER);
}
