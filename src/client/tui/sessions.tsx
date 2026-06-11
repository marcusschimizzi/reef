import { Box, Text } from "ink";
import type { SessionStatus, SessionSummary } from "../../core/types.js";
import { STATUS_LABEL } from "./sessionIndex.js";
import type { Theme } from "./theme.js";

// The sessions list — reef's "home" view (Phase 4c). Each row is one session,
// grouped by status (awaiting-approval first, since those need a human), with a
// source glyph, title, latest-line preview, an approval badge, and relative
// time. Purely presentational; selection/navigation live in App. Color stays an
// accent — titles use the terminal foreground; the palette marks status.

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Compact relative age, e.g. `4s` `12m` `3h` `2d`. now is injectable for tests. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const isTriggerSession = (key: string): boolean => key.includes(":trigger-");

function statusGlyph(theme: Theme, s: SessionSummary): { glyph: string; color: string } {
  switch (s.status) {
    case "awaiting_approval":
      return { glyph: "⏸", color: theme.warn };
    case "working":
      return { glyph: "✶", color: theme.primary };
    case "failed":
      return { glyph: "✗", color: theme.error };
    case "idle":
      return isTriggerSession(s.sessionKey)
        ? { glyph: "⏰", color: theme.muted }
        : { glyph: "💬", color: theme.muted };
  }
}

const GROUP_COLOR: Record<SessionStatus, (t: Theme) => string> = {
  awaiting_approval: (t) => t.warn,
  working: (t) => t.primary,
  idle: (t) => t.muted,
  failed: (t) => t.error,
};

function SessionRow({
  theme,
  session,
  selected,
}: {
  theme: Theme;
  session: SessionSummary;
  selected: boolean;
}) {
  const { glyph, color } = statusGlyph(theme, session);
  return (
    <Box>
      <Text color={theme.primary}>{selected ? "❯ " : "  "}</Text>
      <Text color={color}>{glyph} </Text>
      <Box width={34}>
        <Text bold={selected} color={selected ? theme.secondary : undefined}>
          {clip(session.title, 32)}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={theme.muted}>{clip(session.preview, 52)}</Text>
      </Box>
      {session.pendingApprovals > 0 ? (
        <Text color={theme.warn}> ●{session.pendingApprovals} </Text>
      ) : null}
      <Text color={theme.muted}> {relativeTime(session.lastActivityAt).padStart(3)}</Text>
    </Box>
  );
}

export function SessionsView({
  theme,
  sessions,
  counts,
  selected,
  agentId,
}: {
  theme: Theme;
  sessions: SessionSummary[];
  counts: Record<SessionStatus, number>;
  selected: number;
  agentId: string;
}) {
  let lastStatus: SessionStatus | null = null;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.primary}>
          reef
        </Text>
        <Text color={theme.muted}>
          {"  "}
          {agentId} ·{" "}
        </Text>
        <Text color={theme.warn}>{counts.awaiting_approval} awaiting</Text>
        <Text color={theme.muted}> · </Text>
        <Text color={theme.primary}>{counts.working} working</Text>
        <Text color={theme.muted}>
          {" · "}
          {counts.idle + counts.failed} idle
        </Text>
      </Box>

      {sessions.length === 0 ? (
        <Text color={theme.muted}>no sessions yet — start one below</Text>
      ) : (
        sessions.map((s, i) => {
          const header =
            s.status !== lastStatus ? (
              <Text key={`h${s.status}`} color={GROUP_COLOR[s.status](theme)}>
                {STATUS_LABEL[s.status]}
              </Text>
            ) : null;
          lastStatus = s.status;
          return (
            <Box key={s.sessionKey} flexDirection="column" marginTop={header ? 1 : 0}>
              {header}
              <SessionRow theme={theme} session={s} selected={i === selected} />
            </Box>
          );
        })
      )}
    </Box>
  );
}
