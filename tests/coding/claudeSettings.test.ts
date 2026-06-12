import { describe, expect, it } from "vitest";
import { buildHandbackSettings } from "../../src/coding/claudeSettings.js";

describe("buildHandbackSettings", () => {
  it("emits a Stop hook that touches the (absolute) handback file", () => {
    const s = buildHandbackSettings("/tmp/reef/cs_1.handback");
    const cmd = s.hooks!.Stop![0]!.hooks[0]!;
    expect(cmd.type).toBe("command");
    expect(cmd.command).toBe("touch '/tmp/reef/cs_1.handback'");
  });

  it("shell-quotes a path with spaces and quotes safely", () => {
    const s = buildHandbackSettings("/tmp/a b/it's.handback");
    expect(s.hooks!.Stop![0]!.hooks[0]!.command).toBe(`touch '/tmp/a b/it'\\''s.handback'`);
  });

  it("is JSON-serializable (passed via --settings)", () => {
    const json = JSON.stringify(buildHandbackSettings("/x.handback"));
    expect(JSON.parse(json).hooks.Stop[0].hooks[0].command).toContain("touch");
  });
});
