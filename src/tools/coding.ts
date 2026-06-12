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
  model: z.string().optional().describe("Model for the coding agent (e.g. 'haiku'); default: the agent's own."),
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

// Feed a follow-up increment to a PAUSED coding session, reviving it via
// `claude --resume <uuid>`. Like start_coding_session it suspends the run until the
// session hands back again. NOT gated (the session was already approved at start;
// per-edit approvals inside it still apply). The sessionId comes from a prior
// subwork tool_result's `codingSessionId`. A non-resumable id → an error result.
const feedbackSchema = z.object({
  sessionId: z.string().describe("The coding session id (cs_…) from a prior tool_result."),
  text: z.string().describe("The follow-up instruction/feedback for the session."),
});

export const sendFeedback: Tool<z.infer<typeof feedbackSchema>> = {
  name: "send_feedback",
  description:
    "Send follow-up instructions to a paused coding session (revives it via --resume). " +
    "The run suspends until the session finishes the new increment; its summary is returned.",
  inputSchema: feedbackSchema,
  needsApproval: false,
  suspendsForSubwork: true,
  run: async () => {
    throw new Error("send_feedback is handled by the loop's subwork hooks, not run()");
  },
};

export const codingTools: Tool[] = [startCodingSession, sendFeedback];
