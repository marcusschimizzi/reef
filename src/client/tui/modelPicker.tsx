import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { Theme } from "./theme.js";
import type { ModelOption } from "./models.js";

// The `/model` picker — a selectable list of grounded model ids (from the
// catalog, configured providers, and models already in use) plus a free-text
// "Custom…" entry. Purely presentational; selection/editing live in App. The
// list is windowed so a long catalog never overflows the terminal.

const WINDOW = 12; // max rows shown at once

export function ModelPicker({
  theme,
  options,
  selected,
  current,
  editing,
  onEditChange,
  onEditSubmit,
  status,
}: {
  theme: Theme;
  options: ModelOption[];
  selected: number;
  /** The session's current model (normalized), marked with ●. */
  current?: string;
  /** Free-text buffer when the custom row is being typed, else null. */
  editing: string | null;
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  status?: string;
}) {
  // Window the list around the selection so it fits the screen.
  const start = Math.max(0, Math.min(selected - Math.floor(WINDOW / 2), options.length - WINDOW));
  const from = Math.max(0, start);
  const shown = options.slice(from, from + WINDOW);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          reef
        </Text>
        <Text color={theme.muted}>  switch model — this session</Text>
      </Box>

      {from > 0 ? <Text color={theme.muted}>  ↑ {from} more</Text> : null}
      {shown.map((opt, i) => {
        const idx = from + i;
        const sel = idx === selected;
        const isCurrent = !opt.custom && current !== undefined && opt.id === current;
        if (opt.custom && sel && editing !== null) {
          return (
            <Box key="custom-edit">
              <Text color={theme.primary}>❯ </Text>
              <TextInput
                value={editing}
                onChange={onEditChange}
                onSubmit={onEditSubmit}
                placeholder="provider/model — e.g. opencode/minimax-m3"
              />
            </Box>
          );
        }
        return (
          <Box key={opt.id || "custom"}>
            <Text color={theme.primary}>{sel ? "❯ " : "  "}</Text>
            <Text color={isCurrent ? theme.ok : sel ? theme.secondary : undefined} bold={sel}>
              {opt.label}
            </Text>
            {isCurrent ? <Text color={theme.ok}>  ● current</Text> : null}
          </Box>
        );
      })}
      {from + WINDOW < options.length ? (
        <Text color={theme.muted}>  ↓ {options.length - (from + WINDOW)} more</Text>
      ) : null}

      {status ? (
        <Box marginTop={1}>
          <Text color={status.startsWith("invalid") || status.startsWith("error") ? theme.error : theme.ok}>
            {status}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>↑↓ select · enter choose · ← ← cancel · applies to your next message</Text>
      </Box>
    </Box>
  );
}
