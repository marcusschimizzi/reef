import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { PROMPT } from "./avatar.js";
import {
  Banner,
  CommandPalette,
  StatusBar,
  Transcript,
  type Command,
  type SessionInfo,
} from "./components.js";
import { Connection, type ConnStatus } from "./connection.js";
import { resolveTheme } from "./theme.js";
import {
  initialState,
  pendingApprovals,
  pushNotice,
  pushUser,
  reduceEvent,
  type TranscriptState,
} from "./transcript.js";

const COMMANDS: Command[] = [
  { name: "help", description: "show available commands" },
  { name: "stop", description: "cancel the current run" },
  { name: "clear", description: "clear the transcript" },
  { name: "new", description: "start a fresh session" },
  { name: "quit", description: "exit reef" },
];

const HELP = [
  "commands:",
  ...COMMANDS.map((c) => `  /${c.name.padEnd(7)} ${c.description}`),
].join("\n");

export interface AppProps {
  socketPath: string;
  session: SessionInfo;
}

export function App({ socketPath, session }: AppProps) {
  const { exit } = useApp();
  const theme = resolveTheme();
  const [state, setState] = useState<TranscriptState>(initialState);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("connecting");
  const connRef = useRef<Connection | null>(null);
  const sessionKey = useRef(`cli:${Date.now()}`);

  useEffect(() => {
    const c = new Connection(socketPath, {
      onEvent: (event) => {
        if (event.sessionKey !== sessionKey.current) return; // our session only
        setState((s) => reduceEvent(s, event));
      },
      onError: (message) => setState((s) => ({ ...s, items: [...s.items, { id: s.nextId, kind: "error", text: message }], nextId: s.nextId + 1 })),
      onStatus: setConn,
    });
    connRef.current = c;
    return () => c.close();
  }, [socketPath]);

  const pending = pendingApprovals(state);
  const active = pending[0];

  // While an approval is pending, keys drive the decision (text input is hidden).
  useInput(
    (key) => {
      if (!active || !connRef.current) return;
      if (key === "a") connRef.current.resolve(active.approvalId, "allow-once");
      else if (key === "A") connRef.current.resolve(active.approvalId, "allow-always");
      else if (key === "d") connRef.current.resolve(active.approvalId, "deny");
    },
    { isActive: Boolean(active) },
  );

  // Slash-command palette: `/` opens a filtered, arrow-navigable hint list.
  const slashQuery = input.startsWith("/") ? input.slice(1).split(/\s+/)[0] ?? "" : null;
  const matches = slashQuery !== null ? COMMANDS.filter((c) => c.name.startsWith(slashQuery)) : [];
  const showPalette = matches.length > 0 && !active;

  // Keep the highlight on the best match as the query narrows.
  useEffect(() => setSelected(0), [slashQuery]);

  useInput(
    (_input, key) => {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSelected((s) => Math.min(matches.length - 1, s + 1));
    },
    { isActive: showPalette },
  );

  function submit(line: string): void {
    const text = line.trim();
    setInput("");
    if (!text) return;
    if (text.startsWith("/")) {
      // Enter runs the highlighted suggestion (falling back to what was typed).
      const typed = text.slice(1).split(/\s+/)[0] ?? "";
      return command(matches[selected]?.name ?? typed);
    }
    setState((s) => pushUser(s, text));
    connRef.current?.send(sessionKey.current, text);
  }

  function command(name: string): void {
    switch (name) {
      case "help":
        setState((s) => pushNotice(s, HELP));
        break;
      case "stop":
        connRef.current?.stop(sessionKey.current);
        setState((s) => pushNotice(s, "requested stop"));
        break;
      case "clear":
        setState(() => initialState);
        break;
      case "new":
        sessionKey.current = `cli:${Date.now()}`;
        setState(() => ({ ...initialState }));
        break;
      case "quit":
      case "exit":
        connRef.current?.close();
        exit();
        break;
      default:
        setState((s) => pushNotice(s, `unknown command: /${name}`));
    }
  }

  return (
    <Box flexDirection="column">
      <Banner theme={theme} session={session} />
      <Transcript theme={theme} items={state.items} activeApprovalId={active?.approvalId} />

      <Box marginTop={1} flexDirection="column">
        {showPalette ? <CommandPalette theme={theme} matches={matches} selected={selected} /> : null}
        {active ? (
          <Text color={theme.muted}>respond to the approval above — a / A / d</Text>
        ) : conn === "disconnected" ? (
          <Text color={theme.error}>✗ disconnected from daemon</Text>
        ) : (
          <Box>
            <Text color={theme.primary}>{PROMPT} </Text>
            <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="ask reef…" />
          </Box>
        )}
        <StatusBar theme={theme} status={state.status} usage={state.usage} agentId={session.agentId} />
      </Box>
    </Box>
  );
}
