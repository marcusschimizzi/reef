// src/coding/claudeSettings.ts
//
// Builds the Claude Code settings reef passes via `--settings <file>` — never
// written into the user's repo or ~/.claude (onboarding: reef injects everything
// it needs invisibly, clobbers nothing, commits nothing). Today it carries a Stop
// hook that touches a reef-owned sentinel file when the agent finishes a turn — a
// deterministic, model-independent handback signal (vs. asking the model to print a
// marker). The same settings object is the seam for future pre-authorization
// (permissions.allow) to cut approval prompts.

/** A Claude Code settings object. Loosely typed — only the parts reef sets. */
export interface ClaudeSettings {
  hooks?: {
    Stop?: Array<{ hooks: Array<{ type: "command"; command: string }> }>;
  };
}

/** Settings with a Stop hook that touches `handbackFile` (an absolute, reef-owned
 *  path) whenever the agent finishes responding. The command is portable
 *  (`touch`); the path is absolute so the hook's cwd (the user's dir) doesn't
 *  matter and nothing lands in the user's repo. */
export function buildHandbackSettings(handbackFile: string): ClaudeSettings {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `touch ${shellQuote(handbackFile)}` }] }],
    },
  };
}

/** Single-quote a path for a POSIX shell, escaping embedded single quotes. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
