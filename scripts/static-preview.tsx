// Throwaway: verify <Static> (committed scrollback) + a live tail render together.
// Run: npx tsx scripts/static-preview.tsx [theme]
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { Banner, ItemView, StatusBar } from "../src/client/tui/components.js";
import { resolveTheme } from "../src/client/tui/theme.js";
import { splitTranscript, type TranscriptItem } from "../src/client/tui/transcript.js";
import { Static } from "ink";

const theme = resolveTheme(process.argv[2]);
const items: TranscriptItem[] = [
  { id: 1, kind: "user", text: "what changed today?" },
  { id: 2, kind: "assistant", text: "Here's the summary.", streaming: false },
  { id: 3, kind: "tool", toolUseId: "t1", name: "shell", input: { command: "git log" }, status: "ok", output: "3 commits" },
  { id: 4, kind: "assistant", text: "Still typing", streaming: true }, // live tail
];
const { done, live } = splitTranscript(items);
const staticEntries = [{ key: "banner" as const }, ...done.map((i) => ({ key: `i${i.id}`, item: i }))];

const { lastFrame } = render(
  <Box flexDirection="column">
    <Static items={staticEntries}>
      {(e: { key: string; item?: TranscriptItem }) =>
        e.item ? <ItemView key={e.key} theme={theme} item={e.item} /> : <Banner key={e.key} theme={theme} session={{ cwd: process.cwd(), branch: "reef-agent-pivot", agentId: "reef" }} />
      }
    </Static>
    <Box flexDirection="column">
      {live.map((i) => <ItemView key={i.id} theme={theme} item={i} />)}
      <StatusBar theme={theme} status="working" usage={{ inputTokens: 1840, outputTokens: 320 }} agentId="reef" />
    </Box>
  </Box>,
);

process.stdout.write("FRAME:\n" + (lastFrame() ?? "") + "\nEND\n");
