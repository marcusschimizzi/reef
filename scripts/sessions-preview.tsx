import React from "react";
import { render } from "ink-testing-library";
import { SessionsView } from "../src/client/tui/sessions.js";
import { resolveTheme } from "../src/client/tui/theme.js";

const theme = resolveTheme(process.argv[2]);
const s = (o: any) => ({ agentId: "reef", status: "idle", title: "t", preview: "p", pendingApprovals: 0, lastActivityAt: "", createdAt: "", ...o });
const now = Date.now();
const iso = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
const sessions = [
  s({ sessionKey: "cli:1", status: "awaiting_approval", title: "run a deploy command", preview: "shell(npm run deploy) — needs approval", pendingApprovals: 1, lastActivityAt: iso(120) }),
  s({ sessionKey: "cli:2", status: "working", title: "summarize today's commits", preview: "drafting the summary…", lastActivityAt: iso(4) }),
  s({ sessionKey: "reef:reef:trigger-abc", status: "idle", title: "Create a random file in your workspace to demonstrate scheduling", preview: "✅ created scheduled-demo.txt", lastActivityAt: iso(1860) }),
  s({ sessionKey: "cli:3", status: "idle", title: "what's my name?", preview: "It's Marcus", lastActivityAt: iso(3600) }),
  s({ sessionKey: "reef:reef:trigger-hb", status: "idle", title: "self-maintenance check", preview: "nothing needed", lastActivityAt: iso(7200) }),
];
const { lastFrame } = render(
  <SessionsView theme={theme} sessions={sessions} counts={{ awaiting_approval: 1, working: 1, idle: 3, failed: 0 }} selected={0} agentId="reef" />
);
console.log(lastFrame());
