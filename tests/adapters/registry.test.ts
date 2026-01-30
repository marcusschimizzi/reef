import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";

describe("AdapterRegistry", () => {
  it("returns registered adapter", () => {
    const registry = new AdapterRegistry();
    registry.register("claude", { name: "claude" } as any);
    expect(registry.get("claude")?.name).toBe("claude");
  });
});
