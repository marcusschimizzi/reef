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
 *  teaching the agent the handback protocol. */
export const HANDBACK_INSTRUCTION =
  `When you have completed the requested task and are waiting for further ` +
  `instructions, print this exact marker on its own line as the very last thing ` +
  `you output: ${HANDBACK_MARKER}`;

/** True when rendered output contains the handback marker. */
export function containsHandback(text: string): boolean {
  return text.includes(HANDBACK_MARKER);
}
