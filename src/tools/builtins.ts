import { z } from "zod";
import { nowIso } from "../core/time.js";
import type { Tool } from "./types.js";

// Trivial tools for the Phase 1 skeleton — enough to prove the loop dispatches
// a tool and feeds the result back to the model. Real capability (shell, file
// I/O) lands in Phase 3, through the same fs-capability seam.

export const echoTool: Tool<{ message: string }> = {
  name: "echo",
  description: "Echo a message back verbatim. Useful for testing the tool loop.",
  inputSchema: z.object({ message: z.string() }),
  async run({ message }) {
    return { echoed: message };
  },
};

export const getTimeTool: Tool<Record<string, never>> = {
  name: "get_time",
  description: "Get the current date and time as an ISO-8601 string.",
  inputSchema: z.object({}),
  async run() {
    return { now: nowIso() };
  },
};

export const builtinTools: Tool[] = [echoTool, getTimeTool];
