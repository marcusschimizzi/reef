import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { PROMPT } from "./avatar.js";
import {
  CommandPalette,
  ItemView,
  StatusBar,
  startsTurn,
  Transcript,
  type Command,
  type SessionInfo,
} from "./components.js";
import { SessionsView } from "./sessions.js";
import { ConfigView, type ConfigProvider } from "./configView.js";
import { Connection, type ConnStatus } from "./connection.js";
import { resolveTheme } from "./theme.js";
import {
  applyConfigEdit,
  readRawConfig,
  writeRawConfig,
  type ConfigEdit,
  type ScalarKey,
} from "../../config/config.js";
import {
  emptyIndex,
  indexEvent,
  orderedSessions,
  seedSessions,
  statusCounts,
  type SessionIndex,
} from "./sessionIndex.js";
import {
  initialState,
  pendingApprovals,
  pushNotice,
  reduceEvent,
  splitTranscript,
  type TranscriptState,
} from "./transcript.js";

// Clear screen + scrollback + home cursor — when switching the open session.
const CLEAR_SCREEN = "\x1B[2J\x1B[3J\x1B[H";

const COMMANDS: Command[] = [
  { name: "help", description: "show available commands" },
  { name: "stop", description: "cancel the current run" },
  { name: "sessions", description: "back to the sessions list" },
  { name: "config", description: "view & edit configuration" },
  { name: "clear", description: "clear the transcript" },
  { name: "quit", description: "exit reef" },
];

const HELP = [
  "commands:",
  ...COMMANDS.map((c) => `  /${c.name.padEnd(9)} ${c.description}`),
].join("\n");

export interface AppProps {
  socketPath: string;
  configPath: string;
  session: SessionInfo;
}

type View = "sessions" | "session" | "config";

export function App({ socketPath, configPath, session }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = resolveTheme();

  const [view, setView] = useState<View>("sessions");
  const [index, setIndex] = useState<SessionIndex>(emptyIndex);
  const [state, setState] = useState<TranscriptState>(initialState);
  const [input, setInput] = useState("");
  const [paletteSel, setPaletteSel] = useState(0);
  const [sessionSel, setSessionSel] = useState(0);
  const [conn, setConn] = useState<ConnStatus>("connecting");
  // Bumped when the open session changes, to remount <Static> (its committed
  // line count must reset or it won't reprint after the transcript shrinks).
  const [generation, setGeneration] = useState(0);

  // Config view (a third editing surface over .reef/config.json).
  const [cfgRaw, setCfgRaw] = useState<Record<string, unknown>>({});
  const [cfgSel, setCfgSel] = useState(0);
  const [cfgEditing, setCfgEditing] = useState<string | null>(null); // edit buffer, or null
  const [cfgStatus, setCfgStatus] = useState("");

  const connRef = useRef<Connection | null>(null);
  // The session whose transcript is open; a ref so the socket handlers (set up
  // once) always read the current value rather than a stale closure.
  const openKey = useRef<string | null>(null);
  const leftPresses = useRef(0);

  useEffect(() => {
    const c = new Connection(socketPath, {
      onStatus: (s) => {
        setConn(s);
        if (s === "connected") c.listSessions(); // seed/refresh the list
      },
      onSessions: (sessions) => setIndex((i) => seedSessions(i, sessions)),
      onEvent: (event) => {
        setIndex((i) => indexEvent(i, event)); // keep the list live, all sessions
        if (event.sessionKey === openKey.current) setState((s) => reduceEvent(s, event));
      },
      onHistory: (sessionKey, events) => {
        if (sessionKey !== openKey.current) return; // a stale reply for a prior open
        setState(events.reduce(reduceEvent, initialState));
      },
      onError: (message) =>
        setState((s) => ({
          ...s,
          items: [...s.items, { id: s.nextId, kind: "error", text: message }],
          nextId: s.nextId + 1,
        })),
    });
    connRef.current = c;
    return () => c.close();
  }, [socketPath]);

  const ordered = useMemo(() => orderedSessions(index), [index]);
  const counts = useMemo(() => statusCounts(index), [index]);
  useEffect(() => {
    setSessionSel((s) => Math.min(s, Math.max(0, ordered.length - 1)));
  }, [ordered.length]);

  const pending = pendingApprovals(state);
  const active = pending[0];

  // Slash-command palette (session view only): `/` opens a filtered hint list.
  const slashQuery =
    view === "session" && input.startsWith("/") ? input.slice(1).split(/\s+/)[0] ?? "" : null;
  const matches = slashQuery !== null ? COMMANDS.filter((c) => c.name.startsWith(slashQuery)) : [];
  const showPalette = matches.length > 0 && !active;
  useEffect(() => setPaletteSel(0), [slashQuery]);

  // ── view transitions ────────────────────────────────────────────────────────
  function openSession(sessionKey: string): void {
    openKey.current = sessionKey;
    setView("session");
    setInput("");
    leftPresses.current = 0;
    stdout.write(CLEAR_SCREEN);
    setState(initialState);
    setGeneration((g) => g + 1);
    connRef.current?.history(sessionKey); // rebuild the transcript from its log
  }

  function newSession(text: string): void {
    const key = `cli:${Date.now()}`;
    openKey.current = key;
    setView("session");
    setInput("");
    leftPresses.current = 0;
    stdout.write(CLEAR_SCREEN);
    setState(initialState);
    setGeneration((g) => g + 1);
    connRef.current?.send(key, text); // the user line echoes back as message.received
  }

  function toSessions(): void {
    openKey.current = null;
    setView("sessions");
    setInput("");
    stdout.write(CLEAR_SCREEN);
    connRef.current?.listSessions(); // refresh titles/previews from the daemon
  }

  function toConfig(): void {
    setCfgRaw(readRawConfig(configPath) ?? {}); // load the raw file fresh
    setCfgSel(0);
    setCfgEditing(null);
    setCfgStatus("");
    setView("config");
    setInput("");
    leftPresses.current = 0;
    stdout.write(CLEAR_SCREEN);
  }

  // The scalar value (model / policy file) at config-view row 0 / 1.
  const cfgScalar = (row: number): string => {
    const v = row === 0 ? cfgRaw.defaultModel : cfgRaw.policyFile;
    return typeof v === "string" ? v : "";
  };

  /** Apply an edit to the config file, validating before writing (reusing the
   *  same core the CLI uses); surface the outcome on the status line. */
  function saveConfig(edit: ConfigEdit): void {
    try {
      const next = applyConfigEdit(cfgRaw, edit);
      writeRawConfig(configPath, next);
      setCfgRaw(next);
      setCfgStatus("saved — restart the daemon to apply");
    } catch (err) {
      setCfgStatus(`invalid: ${configEditError(err)}`);
    }
  }

  function submitConfigEdit(): void {
    const key: ScalarKey = cfgSel === 0 ? "defaultModel" : "policyFile";
    const value = (cfgEditing ?? "").trim();
    saveConfig(value ? { op: "set", key, value } : { op: "unset", key });
    setCfgEditing(null);
  }

  // ── input handling ───────────────────────────────────────────────────────────
  // Sessions view: arrow-select rows; approve/deny in place; enter opens.
  useInput(
    (key, k) => {
      if (k.upArrow) setSessionSel((s) => Math.max(0, s - 1));
      else if (k.downArrow) setSessionSel((s) => Math.min(ordered.length - 1, s + 1));
      else if (key === "a" || key === "d") {
        const sel = ordered[sessionSel];
        if (sel?.pendingApprovalId) {
          connRef.current?.resolve(sel.pendingApprovalId, key === "a" ? "allow-once" : "deny");
        }
      }
    },
    { isActive: view === "sessions" },
  );

  // Session view: a pending approval takes the keys (text input is hidden).
  useInput(
    (key) => {
      if (!active || !connRef.current) return;
      if (key === "a") connRef.current.resolve(active.approvalId, "allow-once");
      else if (key === "A") connRef.current.resolve(active.approvalId, "allow-always");
      else if (key === "d") connRef.current.resolve(active.approvalId, "deny");
    },
    { isActive: view === "session" && Boolean(active) },
  );

  // Session view: `← ←` (double-left, while the prompt is empty) returns home.
  useInput(
    (_key, k) => {
      if (k.leftArrow && input === "") {
        leftPresses.current += 1;
        if (leftPresses.current >= 2) toSessions();
      } else {
        leftPresses.current = 0;
      }
    },
    { isActive: view === "session" && !active && !showPalette },
  );

  // Session view: palette navigation.
  useInput(
    (_input, k) => {
      if (k.upArrow) setPaletteSel((s) => Math.max(0, s - 1));
      else if (k.downArrow) setPaletteSel((s) => Math.min(matches.length - 1, s + 1));
    },
    { isActive: showPalette },
  );

  // Config view: navigate fields/providers, edit scalars inline, remove a
  // provider, `← ←` back. While editing, keys go to the field (Esc cancels).
  useInput(
    (key, k) => {
      if (cfgEditing !== null) {
        if (k.escape) setCfgEditing(null);
        return; // the TextInput owns typing + submit
      }
      const providers = providersOf(cfgRaw);
      const rowCount = 2 + providers.length;
      if (k.upArrow) setCfgSel((s) => Math.max(0, s - 1));
      else if (k.downArrow) setCfgSel((s) => Math.min(rowCount - 1, s + 1));
      else if (k.return) {
        if (cfgSel <= 1) setCfgEditing(cfgScalar(cfgSel)); // edit a scalar field
      } else if (key === "x") {
        const i = cfgSel - 2;
        if (i >= 0 && i < providers.length) {
          saveConfig({ op: "provider-rm", id: providers[i]!.id });
          setCfgSel((s) => Math.min(s, rowCount - 2)); // a row went away
        }
      } else if (k.leftArrow) {
        leftPresses.current += 1;
        if (leftPresses.current >= 2) toSessions();
      } else {
        leftPresses.current = 0;
      }
    },
    { isActive: view === "config" },
  );

  function submit(line: string): void {
    const text = line.trim();
    setInput("");
    if (view === "sessions") {
      if (text.startsWith("/")) return command(text.slice(1).split(/\s+/)[0] ?? "");
      if (text) newSession(text);
      else if (ordered[sessionSel]) openSession(ordered[sessionSel]!.sessionKey);
      return;
    }
    if (!text) return;
    if (text.startsWith("/")) {
      const typed = text.slice(1).split(/\s+/)[0] ?? "";
      return command(matches[paletteSel]?.name ?? typed);
    }
    if (openKey.current) connRef.current?.send(openKey.current, text); // echoes back

  }

  function command(name: string): void {
    switch (name) {
      case "help":
        setState((s) => pushNotice(s, HELP));
        break;
      case "stop":
        if (openKey.current) connRef.current?.stop(openKey.current);
        setState((s) => pushNotice(s, "requested stop"));
        break;
      case "sessions":
        toSessions();
        break;
      case "config":
        toConfig();
        break;
      case "clear":
        stdout.write(CLEAR_SCREEN);
        setState(() => initialState);
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

  // ── render ───────────────────────────────────────────────────────────────────
  if (view === "config") {
    return (
      <Box flexDirection="column">
        <ConfigView
          theme={theme}
          defaultModel={cfgScalar(0)}
          policyFile={cfgScalar(1)}
          providers={providersOf(cfgRaw)}
          selected={cfgSel}
          editing={cfgEditing}
          onEditChange={setCfgEditing}
          onEditSubmit={submitConfigEdit}
          status={cfgStatus}
        />
      </Box>
    );
  }

  if (view === "sessions") {
    return (
      <Box flexDirection="column">
        <SessionsView
          theme={theme}
          sessions={ordered}
          counts={counts}
          selected={sessionSel}
          agentId={session.agentId}
        />
        <Box marginTop={1} flexDirection="column">
          {conn === "disconnected" ? (
            <Text color={theme.error}>✗ disconnected from daemon</Text>
          ) : (
            <Box>
              <Text color={theme.primary}>{PROMPT} </Text>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={submit}
                placeholder="describe a task for a new session…"
              />
            </Box>
          )}
          <Text color={theme.muted}>
            ↑↓ move · enter open · a/d approve · type to start a new session · /quit
          </Text>
        </Box>
      </Box>
    );
  }

  // session view — the transcript, the live tail, and the input/approval region
  const { done, live } = splitTranscript(state.items);
  const openSummary = openKey.current ? index[openKey.current] : undefined;
  const title = openSummary?.title ?? openKey.current ?? "";
  const openModel = openSummary?.model;
  const staticEntries: Array<{ key: string; item?: TranscriptState["items"][number] }> = [
    { key: "header" },
    ...done.map((item) => ({ key: `i${item.id}`, item })),
  ];

  return (
    <Box flexDirection="column">
      <Static key={generation} items={staticEntries}>
        {(entry) =>
          entry.item ? (
            <Box key={entry.key} marginTop={startsTurn(entry.item) ? 1 : 0}>
              <ItemView theme={theme} item={entry.item} />
            </Box>
          ) : (
            <Box key={entry.key} marginBottom={1}>
              <Text color={theme.primary}>reef </Text>
              <Text color={theme.muted}>· {title}  </Text>
              {openModel ? <Text color={theme.secondary}>{openModel}  </Text> : null}
              <Text color={theme.muted}>(← ← back to sessions)</Text>
            </Box>
          )
        }
      </Static>

      <Transcript theme={theme} items={live} activeApprovalId={active?.approvalId} />

      <Box marginTop={1} flexDirection="column">
        {showPalette ? <CommandPalette theme={theme} matches={matches} selected={paletteSel} /> : null}
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
        <StatusBar theme={theme} status={state.status} usage={state.usage} agentId={session.agentId} model={openModel} />
      </Box>
    </Box>
  );
}

/** Extract the custom-provider rows from the raw config object for display. */
function providersOf(raw: Record<string, unknown>): ConfigProvider[] {
  const list = Array.isArray(raw.providers) ? (raw.providers as Array<Record<string, unknown>>) : [];
  return list.map((p) => ({
    id: typeof p.id === "string" ? p.id : "",
    kind: typeof p.kind === "string" ? p.kind : "",
    baseURL: typeof p.baseURL === "string" ? p.baseURL : undefined,
  }));
}

/** A short, readable reason from a config validation error (zod or otherwise). */
function configEditError(err: unknown): string {
  const issues = (err as { issues?: Array<{ message: string }> }).issues;
  if (Array.isArray(issues)) return issues.map((i) => i.message).join("; ");
  return err instanceof Error ? err.message : String(err);
}
