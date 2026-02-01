import { describe, expect, it } from "vitest";
import { buildTools } from "../../src/mcp/tools.js";

function getTool(tools: any[], name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error("tool not found");
  return tool;
}

describe("reef:info", () => {
  it("returns version, adapters, uptimeMs", async () => {
    const tools = buildTools({} as any, { version: "0.1.0", adapters: ["claude"], startedAt: 0 });
    const info = await getTool(tools, "reef:info").handler({});
    expect(info.structuredContent).toMatchObject({
      version: "0.1.0",
      adapters: ["claude"]
    });
    expect(typeof info.structuredContent.uptimeMs).toBe("number");
  });
});
