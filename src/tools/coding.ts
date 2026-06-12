import { z } from "zod";
import type { Tool } from "./types.js";

// The agent-facing entry to coding-agent control: spawn an external Claude Code
// session in a directory with a task. It suspends the run (awaiting_subwork) until
// the session completes; the loop's startSubwork/collectSubwork hooks do the work,
// so run() is never executed for effect. needsApproval gates it — a proactive run
// has no approver and is denied; an interactive run gates for a human OK to spawn.
const inputSchema = z.object({
  directory: z.string().describe("Absolute path of the working directory for the session."),
  task: z.string().describe("The task/prompt to give the coding agent."),
  agentKind: z.string().optional().describe("Which coding agent (default: claude-code)."),
});

export const startCodingSession: Tool<z.infer<typeof inputSchema>> = {
  name: "start_coding_session",
  description:
    "Start an external coding-agent session (Claude Code) in a directory with a task. " +
    "The run suspends until the session finishes; its summary is returned as the result.",
  inputSchema,
  needsApproval: true,
  suspendsForSubwork: true,
  run: async () => {
    throw new Error("start_coding_session is handled by the loop's subwork hooks, not run()");
  },
};

export const codingTools: Tool[] = [startCodingSession];
