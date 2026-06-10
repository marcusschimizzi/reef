import type { ReactNode } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { resolveAvatar, WORDMARK, TAGLINE, type Avatar } from "./avatar.js";
import { shade, type Theme } from "./theme.js";
import { parseSegments } from "./markdown.js";
import type { RunStatus, TranscriptItem, UsageTotals } from "./transcript.js";

const EYE = "#1b1f24"; // near-black eyes read as holes in the colored body

/** Render a pixel grid as half-block rows: two pixel rows per text row, using
 *  ▀ with fg = top pixel and bg = bottom pixel (doubling vertical resolution).
 *  'o' body · 'h' highlight (lighter body) · 'e' eye · '.' transparent. */
function PixelSprite({ rows, body }: { rows: string[]; body: string }) {
  const highlight = shade(body, 0.34);
  const colorOf = (ch: string | undefined): string | undefined =>
    ch === "o" ? body : ch === "h" ? highlight : ch === "e" ? EYE : undefined;
  const lines: ReactNode[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? "";
    const bot = rows[y + 1] ?? "";
    const width = Math.max(top.length, bot.length);
    const cells: ReactNode[] = [];
    for (let x = 0; x < width; x++) {
      const t = colorOf(top[x]);
      const b = colorOf(bot[x]);
      if (t && b) cells.push(<Text key={x} color={t} backgroundColor={b}>▀</Text>);
      else if (t) cells.push(<Text key={x} color={t}>▀</Text>);
      else if (b) cells.push(<Text key={x} color={b}>▄</Text>);
      else cells.push(<Text key={x}> </Text>);
    }
    lines.push(<Box key={y}>{cells}</Box>);
  }
  return <Box flexDirection="column">{lines}</Box>;
}

export function AvatarArt({ theme, avatar }: { theme: Theme; avatar: Avatar }) {
  return <PixelSprite rows={avatar.rows} body={theme.primary} />;
}

// Presentational Ink components. Color is an accent only (see theme.ts): body
// text is left as the terminal's own foreground; the palette is spent on the
// brand, borders, de-emphasis, and semantic state. The launch banner is the one
// place that leans into color — it's the splash.

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
          <AvatarArt theme={theme} avatar={resolveAvatar()} />
        </Box>
        <Box flexDirection="column">
          <Text color={theme.primary}>{WORDMARK}</Text>
          <Text color={theme.muted}>  {TAGLINE}</Text>
        </Box>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.muted}
        paddingX={1}
        marginTop={1}
        alignSelf="flex-start"
      >
        <Text color={theme.muted}>
          {session.cwd}
          {session.branch ? <Text color={theme.secondary}>  ⎇ {session.branch}</Text> : null}
        </Text>
        <Text color={theme.muted}>
          agent <Text color={theme.primary}>{session.agentId}</Text>
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
  return (
    <Box flexDirection="column">
      <Text color={theme.muted}>
        <Text color={theme.muted}>⚙</Text> <Text>{item.name}</Text>
        <Text color={theme.muted}>({summarize(item.input, 60)})</Text>{" "}
        {item.status === "running" ? (
          <Text color={theme.muted}>
            <Spinner type="dots" />
          </Text>
        ) : item.status === "ok" ? (
          <Text color={theme.ok}>✓</Text>
        ) : item.status === "error" ? (
          <Text color={theme.error}>✗</Text>
        ) : (
          <Text color={theme.muted}>·</Text>
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
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1} marginY={1} alignSelf="flex-start">
      <Text color={border}>
        {item.status === "pending" ? "⚠ approval needed" : `approval ${item.status}`}
      </Text>
      <Text>{item.action}</Text>
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

/** A fenced code block: bordered, with a muted language tag. */
function CodeBlock({ theme, lang, code }: { theme: Theme; lang?: string; code: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.muted}
      paddingX={1}
      marginY={1}
      alignSelf="flex-start"
    >
      {lang ? <Text color={theme.muted}>{lang}</Text> : null}
      <Text>{code}</Text>
    </Box>
  );
}

/** An assistant turn. Plain replies render inline; replies containing fenced
 *  code render the prose + boxed code blocks stacked, with the label on top. */
function AssistantView({
  theme,
  item,
}: {
  theme: Theme;
  item: Extract<TranscriptItem, { kind: "assistant" }>;
}) {
  const segments = parseSegments(item.text);
  const cursor = item.streaming ? <Text color={theme.muted}>▌</Text> : null;

  if (!segments.some((s) => s.kind === "code")) {
    return (
      <Text>
        <Text color={theme.primary} bold>
          reef{" "}
        </Text>
        {item.text}
        {cursor}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.primary} bold>
        reef
      </Text>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <Text key={i}>{s.text}</Text>
        ) : (
          <CodeBlock key={i} theme={theme} lang={s.lang} code={s.code} />
        ),
      )}
      {cursor}
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
          {item.text}
        </Text>
      );
    case "assistant":
      return <AssistantView theme={theme} item={item} />;
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
      return (
        <Text>
          <Text color={theme.error}>✗ </Text>
          {item.text}
        </Text>
      );
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
        <ItemView key={item.id} theme={theme} item={item} activeApprovalId={activeApprovalId} />
      ))}
    </Box>
  );
}

export interface Command {
  name: string;
  description: string;
}

/** Filtered slash-command suggestions, shown above the input as you type `/`. */
export function CommandPalette({
  theme,
  matches,
  selected,
}: {
  theme: Theme;
  matches: Command[];
  selected: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {matches.map((c, i) => {
        const on = i === selected;
        return (
          <Text key={c.name}>
            <Text color={on ? theme.primary : theme.muted}>{on ? "❯ " : "  "}</Text>
            <Text color={on ? theme.primary : undefined} bold={on}>
              /{c.name}
            </Text>
            <Text color={theme.muted}>{"  "}{c.description}</Text>
          </Text>
        );
      })}
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
          <Text color={theme.muted}>
            <Text color={theme.primary}>
              <Spinner type="dots" />
            </Text>{" "}
            working…
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
