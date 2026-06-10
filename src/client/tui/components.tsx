import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { OCTOPUS, WORDMARK, TAGLINE } from "./avatar.js";
import type { Theme } from "./theme.js";
import type { RunStatus, TranscriptItem, UsageTotals } from "./transcript.js";

// Presentational Ink components. All color comes from the active Theme (passed
// down), so re-skinning is a theme swap and these never name a raw color.

export interface SessionInfo {
  cwd: string;
  branch?: string;
  agentId: string;
}

export function Banner({ theme, session }: { theme: Theme; session: SessionInfo }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Box flexDirection="column" marginRight={3}>
          <Text color={theme.primary}>{OCTOPUS}</Text>
        </Box>
        <Box flexDirection="column">
          <Text color={theme.primary}>{WORDMARK}</Text>
          <Text color={theme.muted}>  {TAGLINE}</Text>
        </Box>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.secondary}
        paddingX={1}
        marginTop={1}
        alignSelf="flex-start"
      >
        <Text color={theme.muted}>
          {session.cwd}
          {session.branch ? <Text color={theme.secondary}>  ⎇ {session.branch}</Text> : null}
        </Text>
        <Text color={theme.muted}>
          agent <Text color={theme.assistant}>{session.agentId}</Text>
        </Text>
      </Box>
      <Text color={theme.muted}>  type a message, or /help for commands</Text>
    </Box>
  );
}

function summarize(value: unknown, max = 100): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function ToolView({ theme, item }: { theme: Theme; item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const glyph =
    item.status === "ok" ? "✓" : item.status === "error" ? "✗" : item.status === "running" ? "" : "·";
  const glyphColor =
    item.status === "ok" ? theme.ok : item.status === "error" ? theme.error : theme.tool;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.tool}>⚙ {item.name}</Text>
        <Text color={theme.muted}>({summarize(item.input, 60)})</Text>{" "}
        {item.status === "running" ? (
          <Text color={theme.tool}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
      </Text>
      {item.status === "ok" && item.output !== undefined ? (
        <Text color={theme.muted}>   ↳ {summarize(item.output)}</Text>
      ) : null}
      {item.status === "error" && item.error ? (
        <Text color={theme.error}>   ↳ {summarize(item.error)}</Text>
      ) : null}
    </Box>
  );
}

export function ApprovalCard({
  theme,
  item,
  active,
}: {
  theme: Theme;
  item: Extract<TranscriptItem, { kind: "approval" }>;
  active: boolean;
}) {
  const border =
    item.status === "allowed" ? theme.ok : item.status === "denied" ? theme.error : theme.warn;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} marginY={1}>
      <Text color={border}>
        {item.status === "pending" ? "⚠ approval needed" : `approval ${item.status}`}
      </Text>
      <Text color={theme.user}>{item.action}</Text>
      {active && item.status === "pending" ? (
        <Text color={theme.muted}>
          <Text color={theme.ok}>[a]</Text> allow once {"  "}
          <Text color={theme.ok}>[A]</Text> always {"  "}
          <Text color={theme.error}>[d]</Text> deny
        </Text>
      ) : null}
    </Box>
  );
}

export function ItemView({
  theme,
  item,
  activeApprovalId,
}: {
  theme: Theme;
  item: TranscriptItem;
  activeApprovalId?: string;
}) {
  switch (item.kind) {
    case "user":
      return (
        <Text>
          <Text color={theme.muted}>you </Text>
          <Text color={theme.user}>{item.text}</Text>
        </Text>
      );
    case "assistant":
      return (
        <Text>
          <Text color={theme.primary} bold>
            reef{" "}
          </Text>
          <Text color={theme.assistant}>{item.text}</Text>
          {item.streaming ? <Text color={theme.muted}>▌</Text> : null}
        </Text>
      );
    case "thinking":
      return (
        <Text color={theme.muted} italic>
          ✲ {item.text}
        </Text>
      );
    case "tool":
      return <ToolView theme={theme} item={item} />;
    case "approval":
      return <ApprovalCard theme={theme} item={item} active={item.approvalId === activeApprovalId} />;
    case "notice":
      return <Text color={theme.muted}>⊙ {item.text}</Text>;
    case "error":
      return <Text color={theme.error}>✗ {item.text}</Text>;
  }
}

export function Transcript({
  theme,
  items,
  activeApprovalId,
}: {
  theme: Theme;
  items: TranscriptItem[];
  activeApprovalId?: string;
}) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Box key={item.id} marginBottom={item.kind === "tool" || item.kind === "approval" ? 0 : 0}>
          <ItemView theme={theme} item={item} activeApprovalId={activeApprovalId} />
        </Box>
      ))}
    </Box>
  );
}

export function StatusBar({
  theme,
  status,
  usage,
  agentId,
}: {
  theme: Theme;
  status: RunStatus;
  usage: UsageTotals;
  agentId: string;
}) {
  return (
    <Box justifyContent="space-between">
      <Box>
        {status === "working" ? (
          <Text color={theme.primary}>
            <Spinner type="dots" /> <Text color={theme.muted}>working…</Text>
          </Text>
        ) : status === "awaiting_approval" ? (
          <Text color={theme.warn}>● awaiting approval</Text>
        ) : (
          <Text color={theme.muted}>● ready</Text>
        )}
      </Box>
      <Text color={theme.muted}>
        ↑{usage.inputTokens} ↓{usage.outputTokens} · {agentId}
      </Text>
    </Box>
  );
}
