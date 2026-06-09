import type { ModelTool } from "../model/router.js";
import type { Tool } from "./types.js";

/**
 * The set of tools available in the daemon. Per-agent allowlists are applied at
 * read time — an agent sees only the tools its record names (reef-docs/08:
 * configuration, not enforcement-by-prompt).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Full tool objects an agent may use (filtered by its allowlist). */
  forAgent(allowlist: string[]): Tool[] {
    return allowlist
      .map((name) => this.tools.get(name))
      .filter((t): t is Tool => t !== undefined);
  }

  /** The model-facing view (name/description/schema only) for an agent. */
  modelTools(allowlist: string[]): ModelTool[] {
    return this.forAgent(allowlist).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }
}
