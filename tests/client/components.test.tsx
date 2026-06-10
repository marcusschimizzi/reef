import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Banner, ApprovalCard, CommandPalette, StatusBar } from "../../src/client/tui/components.js";
import { resolveTheme } from "../../src/client/tui/theme.js";

const theme = resolveTheme("coral");

describe("TUI components", () => {
  it("renders the launch banner with brand + session info", () => {
    const { lastFrame } = render(
      <Banner theme={theme} session={{ cwd: "/home/marcus/dev/reef", branch: "main", agentId: "reef" }} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("█"); // the REEF block wordmark
    expect(out).toContain("▀"); // the half-block octopus sprite (default avatar)
    expect(out).toContain("your always-on agent");
    expect(out).toContain("/home/marcus/dev/reef");
    expect(out).toContain("main");
  });

  it("shows approval key hints only while pending + active", () => {
    const pending = render(
      <ApprovalCard
        theme={theme}
        active
        item={{ id: 1, kind: "approval", approvalId: "a1", action: "shell · git push", status: "pending" }}
      />,
    );
    const out = pending.lastFrame() ?? "";
    expect(out).toContain("approval needed");
    expect(out).toContain("git push");
    expect(out).toMatch(/allow once/);

    const resolved = render(
      <ApprovalCard
        theme={theme}
        active={false}
        item={{ id: 1, kind: "approval", approvalId: "a1", action: "shell · git push", status: "denied" }}
      />,
    );
    expect(resolved.lastFrame() ?? "").toContain("approval denied");
  });

  it("lists slash-command suggestions and marks the selected one", () => {
    const { lastFrame } = render(
      <CommandPalette
        theme={theme}
        selected={1}
        matches={[
          { name: "help", description: "show available commands" },
          { name: "stop", description: "cancel the current run" },
        ]}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("/help");
    expect(out).toContain("/stop");
    expect(out).toContain("cancel the current run");
    expect(out).toMatch(/❯ .*\/stop/); // the selected (index 1) row carries the marker
  });

  it("reflects run status in the status bar", () => {
    const { lastFrame } = render(
      <StatusBar theme={theme} status="working" usage={{ inputTokens: 12, outputTokens: 3 }} agentId="reef" />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("working");
    expect(out).toContain("↑12");
  });
});
