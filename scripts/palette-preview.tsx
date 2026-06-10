// Throwaway: preview the slash-command palette above the input.
// Run: npx tsx scripts/palette-preview.tsx [theme]
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { CommandPalette, StatusBar } from "../src/client/tui/components.js";
import { PROMPT } from "../src/client/tui/avatar.js";
import { resolveTheme } from "../src/client/tui/theme.js";

const theme = resolveTheme(process.argv[2]);
const matches = [
  { name: "stop", description: "cancel the current run" },
  { name: "clear", description: "clear the transcript" },
];

const { lastFrame } = render(
  <Box flexDirection="column">
    <Text color={theme.muted}>reef Done — pushed to origin/cleanup.</Text>
    <Box marginTop={1} flexDirection="column">
      <CommandPalette theme={theme} matches={matches} selected={0} />
      <Box>
        <Text color={theme.primary}>{PROMPT} </Text>
        <Text>/s</Text>
      </Box>
      <StatusBar theme={theme} status="idle" usage={{ inputTokens: 1840, outputTokens: 320 }} agentId="reef" />
    </Box>
  </Box>,
);

process.stdout.write((lastFrame() ?? "") + "\n");
