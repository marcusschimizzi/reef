// Throwaway: render the TUI with sample content to a string so the look can be
// eyeballed without a daemon/TTY. Run: npx tsx scripts/tui-preview.tsx [theme]
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Banner, Transcript, StatusBar } from "../src/client/tui/components.js";
import { PROMPT } from "../src/client/tui/avatar.js";
import { resolveTheme } from "../src/client/tui/theme.js";
import type { TranscriptItem } from "../src/client/tui/transcript.js";

const theme = resolveTheme(process.argv[2]);
const items: TranscriptItem[] = [
  { id: 1, kind: "user", text: "push the cleanup branch" },
  { id: 2, kind: "assistant", text: "On it — let me run that for you.", streaming: false },
  { id: 3, kind: "tool", toolUseId: "t1", name: "shell", input: { command: "git push origin cleanup" }, status: "ok", output: "Everything up-to-date" },
  { id: 4, kind: "approval", approvalId: "a1", action: "shell · git push origin cleanup", status: "allowed" },
  { id: 5, kind: "notice", text: "compacted 6 earlier message(s) into a summary" },
  {
    id: 6,
    kind: "assistant",
    text: "Here's the helper:\n```ts\nexport const sum = (a: number, b: number) => a + b;\n```\nWant tests too?",
    streaming: false,
  },
];

const { lastFrame } = render(
  <Box flexDirection="column">
    <Banner theme={theme} session={{ cwd: process.cwd(), branch: "reef-agent-pivot", agentId: "reef" }} />
    <Transcript theme={theme} items={items} />
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={theme.primary}>{PROMPT} </Text>
        <Text color={theme.muted}>ask reef…</Text>
      </Box>
      <StatusBar theme={theme} status="working" usage={{ inputTokens: 1840, outputTokens: 320 }} agentId="reef" />
    </Box>
  </Box>,
);

process.stdout.write((lastFrame() ?? "") + "\n");
