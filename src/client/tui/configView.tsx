import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { Theme } from "./theme.js";

// The TUI's configuration screen — a third editing surface over .reef/config.json
// (alongside the CLI and hand-editing), reusing the same validate-before-write
// core. Scalar fields (model, policy file) edit inline; custom providers list with
// remove. Adding a provider (multi-field) stays on the CLI for now. Purely
// presentational — selection/editing/save live in App.

export interface ConfigProvider {
  id: string;
  kind: string;
  baseURL?: string;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function Field({
  theme,
  label,
  value,
  selected,
  editing,
  onChange,
  onSubmit,
}: {
  theme: Theme;
  label: string;
  value: string;
  selected: boolean;
  editing: string | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Box>
      <Text color={theme.primary}>{selected ? "❯ " : "  "}</Text>
      <Box width={14}>
        <Text color={theme.muted}>{label}</Text>
      </Box>
      {selected && editing !== null ? (
        <TextInput value={editing} onChange={onChange} onSubmit={onSubmit} />
      ) : (
        <Text bold={selected}>{value || <Text color={theme.muted}>(unset)</Text>}</Text>
      )}
    </Box>
  );
}

export function ConfigView({
  theme,
  defaultModel,
  policyFile,
  providers,
  selected,
  editing,
  onEditChange,
  onEditSubmit,
  status,
}: {
  theme: Theme;
  defaultModel: string;
  policyFile: string;
  providers: ConfigProvider[];
  selected: number;
  editing: string | null; // the edit buffer when editing the selected scalar, else null
  onEditChange: (v: string) => void;
  onEditSubmit: () => void;
  status?: string;
}) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          reef
        </Text>
        <Text color={theme.muted}>  configuration</Text>
      </Box>

      <Field
        theme={theme}
        label="model"
        value={defaultModel}
        selected={selected === 0}
        editing={selected === 0 ? editing : null}
        onChange={onEditChange}
        onSubmit={onEditSubmit}
      />
      <Field
        theme={theme}
        label="policy file"
        value={policyFile}
        selected={selected === 1}
        editing={selected === 1 ? editing : null}
        onChange={onEditChange}
        onSubmit={onEditSubmit}
      />

      <Box marginTop={1}>
        <Text color={theme.muted}>providers (custom)</Text>
      </Box>
      {providers.length === 0 ? (
        <Text color={theme.muted}>  none — add with `npm run config -- provider add …`</Text>
      ) : (
        providers.map((p, i) => {
          const sel = selected === 2 + i;
          return (
            <Box key={p.id}>
              <Text color={theme.primary}>{sel ? "❯ " : "  "}</Text>
              <Box width={16}>
                <Text bold={sel} color={sel ? theme.secondary : undefined}>
                  {clip(p.id, 14)}
                </Text>
              </Box>
              <Text color={theme.muted}>
                {p.kind}
                {p.baseURL ? `  ${clip(p.baseURL, 40)}` : ""}
              </Text>
            </Box>
          );
        })
      )}
      <Text color={theme.muted}>  built-in: anthropic, openai, ollama, openrouter</Text>

      {status ? (
        <Box marginTop={1}>
          <Text color={status.startsWith("invalid") ? theme.error : theme.ok}>{status}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          ↑↓ select · enter edit · x remove provider · ← ← back · changes apply on daemon restart
        </Text>
      </Box>
    </Box>
  );
}
