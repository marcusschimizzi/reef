import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { SessionsView, relativeTime } from "../../src/client/tui/sessions.js";
import { resolveTheme } from "../../src/client/tui/theme.js";
import type { SessionSummary } from "../../src/core/types.js";

const theme = resolveTheme("coral");

const summary = (over: Partial<SessionSummary> & { sessionKey: string }): SessionSummary => ({
  agentId: "reef",
  status: "idle",
  title: "t",
  preview: "p",
  pendingApprovals: 0,
  lastActivityAt: "2026-06-11T12:00:00Z",
  createdAt: "2026-06-11T12:00:00Z",
  ...over,
});

describe("relativeTime", () => {
  const base = Date.parse("2026-06-11T12:00:00Z");
  it("renders compact ages", () => {
    expect(relativeTime("2026-06-11T11:59:55Z", base)).toBe("5s");
    expect(relativeTime("2026-06-11T11:48:00Z", base)).toBe("12m");
    expect(relativeTime("2026-06-11T09:00:00Z", base)).toBe("3h");
    expect(relativeTime("2026-06-09T12:00:00Z", base)).toBe("2d");
  });
  it("is blank for an unparseable time", () => {
    expect(relativeTime("", base)).toBe("");
  });
});

describe("SessionsView", () => {
  it("groups by status, shows titles/previews, an approval badge, and the selection marker", () => {
    const sessions = [
      summary({ sessionKey: "s_wait", status: "awaiting_approval", title: "run a deploy", preview: "shell — needs approval", pendingApprovals: 2 }),
      summary({ sessionKey: "s_work", status: "working", title: "summarize commits", preview: "drafting…" }),
      summary({ sessionKey: "reef:reef:trigger-x", status: "idle", title: "scheduled-demo", preview: "created file" }),
    ];
    const { lastFrame } = render(
      <SessionsView
        theme={theme}
        sessions={sessions}
        counts={{ awaiting_approval: 1, working: 1, idle: 1, failed: 0 }}
        selected={0}
        agentId="reef"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("AWAITING APPROVAL");
    expect(out).toContain("WORKING");
    expect(out).toContain("run a deploy");
    expect(out).toContain("summarize commits");
    expect(out).toContain("●2"); // pending-approval badge
    expect(out).toContain("1 awaiting");
    expect(out).toMatch(/❯ .*run a deploy/); // selected row carries the marker
  });

  it("shows an empty-state hint when there are no sessions", () => {
    const { lastFrame } = render(
      <SessionsView
        theme={theme}
        sessions={[]}
        counts={{ awaiting_approval: 0, working: 0, idle: 0, failed: 0 }}
        selected={0}
        agentId="reef"
      />,
    );
    expect(lastFrame() ?? "").toContain("no sessions yet");
  });
});
