// src/coding/prompts.ts
//
// The semantic layer over a detected prompt: what KIND it is (so a policy can
// route it) and which option a decision maps to. Built from the marker strings
// Claude Code actually renders (captured fixtures + corpus). Kept separate from
// scrape.ts — that turns raw terminal bytes into text+options; this turns text
// into meaning. Step 3 wires these into the ApprovalPolicy flow.

import type { PromptOption } from "./scrape.js";

export type PromptKind = "trust" | "permission" | "plan" | "question";

/** Classify a rendered prompt by its marker text. `trust` and `plan` are checked
 *  before the generic permission markers so they win when phrasing overlaps. */
export function classifyPrompt(text: string): PromptKind {
  if (/trust this folder/i.test(text)) return "trust";
  if (/ready to code|ready to execute|here is claude'?s plan/i.test(text)) return "plan";
  if (
    /do you want to (proceed|create|edit|write|run|make|apply|delete)|requested permission|allow all edits|bash command|requires permission/i.test(
      text,
    )
  ) {
    return "permission";
  }
  return "question";
}

/** A short description of what's being approved, when the prompt phrases it as a
 *  "Do you want to X?" question (e.g. "create summary.txt"). */
export function promptAction(text: string): string | undefined {
  const m = text.match(/do you want to ([^?\n]+)\?/i);
  return m ? m[1]!.trim().replace(/\s+/g, " ") : undefined;
}

export type Decision = "allow-once" | "allow-always" | "deny";

/** Map a decision to the option index to select, by matching the option labels
 *  Claude Code renders ("Yes" / "Yes, allow all edits…" / "No"). Returns
 *  undefined if nothing suitable is found, so the caller can fall back. */
export function answerFor(options: PromptOption[], decision: Decision): number | undefined {
  const match = (re: RegExp): number | undefined => options.find((o) => re.test(o.label))?.index;
  const last = options[options.length - 1]?.index;

  if (decision === "deny") {
    return match(/^no\b|^no[,.]/i) ?? last;
  }
  if (decision === "allow-always") {
    return match(/allow all|don'?t ask again|during this session/i) ?? plainYes(options);
  }
  // allow-once → the plain "Yes", never the "Yes, allow all …" escalation.
  return plainYes(options) ?? match(/^yes/i) ?? options[0]?.index;
}

function plainYes(options: PromptOption[]): number | undefined {
  return options.find(
    (o) => /^yes\b/i.test(o.label) && !/allow all|don'?t ask|during this session/i.test(o.label),
  )?.index;
}
