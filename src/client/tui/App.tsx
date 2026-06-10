import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { PROMPT } from "./avatar.js";
import {
  Banner,
  CommandPalette,
  ItemView,
  Mascot,
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
  splitTranscript,
  type TranscriptState,
} from "./transcript.js";

// Clear screen + scrollback + home cursor — for /clear and /new.
const CLEAR_SCREEN = "\x1B[2J\x1B[3J\x1B[H";

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
  const { stdout } = useStdout();
  const theme = resolveTheme();
  const [state, setState] = useState<TranscriptState>(initialState);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("connecting");
  // Bumped on /clear and /new to remount <Static> (its committed-line count must
  // reset, or it won't print anything after the transcript shrinks).
  const [generation, setGeneration] = useState(0);
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
        stdout.write(CLEAR_SCREEN);
        setState(() => initialState);
        setGeneration((g) => g + 1);
        break;
      case "new":
        sessionKey.current = `cli:${Date.now()}`;
        stdout.write(CLEAR_SCREEN);
        setState(() => ({ ...initialState }));
        setGeneration((g) => g + 1);
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

  // Finalized items (+ the banner) commit to scrollback via <Static> and never
  // re-render; only the live tail + input region repaint each frame.
  const { done, live } = splitTranscript(state.items);
  const staticEntries: Array<{ key: string; item?: TranscriptState["items"][number] }> = [
    { key: "banner" },
    ...done.map((item) => ({ key: `i${item.id}`, item })),
  ];

  return (
    <Box flexDirection="column">
      <Static key={generation} items={staticEntries}>
        {(entry) =>
          entry.item ? (
            <ItemView key={entry.key} theme={theme} item={entry.item} />
          ) : (
            <Banner key={entry.key} theme={theme} session={session} />
          )
        }
      </Static>

      <Transcript theme={theme} items={live} activeApprovalId={active?.approvalId} />

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
        <Box marginTop={1}>
          <Mascot theme={theme} active={state.status === "working"} />
        </Box>
        <StatusBar theme={theme} status={state.status} usage={state.usage} agentId={session.agentId} />
      </Box>
    </Box>
  );
}
