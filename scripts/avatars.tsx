// Throwaway: render every octopus variant side by side to compare them for real.
// Run: npx tsx scripts/avatars.tsx [theme]   (theme: coral | purple)
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { AVATARS } from "../src/client/tui/avatar.js";
import { AvatarArt } from "../src/client/tui/components.js";
import { resolveTheme } from "../src/client/tui/theme.js";

const theme = resolveTheme(process.argv[2]);
const names = Object.keys(AVATARS);

const { lastFrame } = render(
  <Box flexDirection="column">
    {names.map((name) => (
      <Box key={name} flexDirection="column" marginBottom={1}>
        <Text color={theme.muted}>REEF_AVATAR={name}</Text>
        <AvatarArt theme={theme} avatar={AVATARS[name]!} />
      </Box>
    ))}
  </Box>,
);

process.stdout.write((lastFrame() ?? "") + "\n");
