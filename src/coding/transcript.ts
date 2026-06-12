// src/coding/transcript.ts
//
// Read Claude Code's own session transcript — the structured JSONL it writes to
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. This is the RELIABLE
// evidence source for *what the agent did* (messages, tool calls, results),
// strictly better than parsing the garbled PTY screen. We mint the session id,
// so we can locate it deterministically. The PTY scrape stays the control
// channel (detecting prompts, injecting answers — neither is in the JSONL);
// this carries the content. Everything degrades gracefully when the file is
// absent (older CLI, path drift): the caller falls back to the PTY read.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TranscriptToolUse {
  name: string;
  input: unknown;
}

export interface TranscriptEntry {
  role: "user" | "assistant";
  text?: string;
  toolUse?: TranscriptToolUse;
  toolResult?: string;
}

/** The root where Claude Code stores per-project session transcripts. */
export function claudeProjectsDir(): string {
  return process.env.REEF_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
}

/** Claude Code encodes a project's cwd into its transcript-dir name by replacing
 *  every non-alphanumeric character with '-' (verified against real dirs). */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Locate a session's transcript JSONL. Fast path: compute it from the cwd.
 * Fallback: scan the project dirs for `<sessionId>.jsonl` (robust to any drift
 * in the path-encoding scheme, since the session id is unique). Returns
 * undefined if not found — the caller degrades to the PTY read.
 */
export function findClaudeTranscript(
  sessionId: string,
  opts: { cwd?: string; root?: string } = {},
): string | undefined {
  const root = opts.root ?? claudeProjectsDir();
  if (opts.cwd) {
    const direct = join(root, encodeProjectPath(opts.cwd), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  if (!existsSync(root)) return undefined;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Parse a transcript JSONL into ordered message/tool entries. Tolerant of
 *  unknown line types (Claude Code writes many) and partial final lines. */
export function parseClaudeTranscript(path: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: unknown; message?: { content?: unknown } };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    const role = o.type === "assistant" ? "assistant" : o.type === "user" ? "user" : undefined;
    if (!role) continue;

    const content = o.message?.content;
    if (typeof content === "string") {
      out.push({ role, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const c = raw as Record<string, unknown>;
      if (c.type === "text" && typeof c.text === "string") {
        out.push({ role, text: c.text });
      } else if (c.type === "tool_use") {
        out.push({ role, toolUse: { name: String(c.name ?? ""), input: c.input } });
      } else if (c.type === "tool_result") {
        out.push({
          role,
          toolResult: typeof c.content === "string" ? c.content : JSON.stringify(c.content),
        });
      }
    }
  }
  return out;
}

/** The most recent tool call — used to give an approval a RELIABLE action
 *  description ("Write summary.txt") when the PTY scrape detects a prompt. */
export function latestToolUse(entries: TranscriptEntry[]): TranscriptToolUse | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.toolUse) return entries[i]!.toolUse;
  }
  return undefined;
}

/** A clean, readable rendering of the transcript — the reliable "what happened"
 *  view (vs the garbled PTY stream). */
export function renderTranscript(entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.text) lines.push(`${e.role === "assistant" ? "assistant" : "user"}: ${e.text}`);
    else if (e.toolUse) lines.push(`tool: ${e.toolUse.name}(${JSON.stringify(e.toolUse.input)})`);
    else if (e.toolResult) lines.push(`result: ${e.toolResult.split("\n")[0]}`);
  }
  return lines.join("\n");
}
