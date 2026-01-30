import { describe, expect, it } from "vitest";
import { buildTools } from "../../src/mcp/tools.js";

describe("MCP tools", () => {
  it("exposes spawn/status/send/output/kill", () => {
    const tools = buildTools({} as any);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["reef:spawn", "reef:status", "reef:send", "reef:output", "reef:kill"]);
  });
});
