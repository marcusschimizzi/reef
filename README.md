# Reef

Reef is an always-on autonomous agent daemon. One agent runs a single durable
loop — think → act → observe — persisting one step per iteration to SQLite, so a
crash mid-run is recovered by querying the database, not guessing. It wakes for
user messages, scheduled/heartbeat triggers, and wakes it schedules for itself,
and emits a native typed event stream that consumers (a terminal UI, conch)
project from.

## Run it

```
npm install
npm run daemon   # start the agent daemon (unix socket + HTTP/SSE on :9876)
npm run tui      # the Ink terminal UI, in a second shell
```

Set `ANTHROPIC_API_KEY` in `.env` (see `.env.example`). State lives in `./.reef`
(SQLite db, workspaces, control socket).

### Useful env

- `REEF_HTTP_PORT` (default `9876`), `REEF_API_KEY` — HTTP interface.
- `REEF_HEARTBEAT_MINUTES` — opt-in self-maintenance heartbeat cadence (`0`/unset = off).
- `REEF_LOG=off` — silence run-lifecycle logging.
- `REEF_THEME`, `REEF_AVATAR` — TUI look (`teal` + `pixel` by default).

## Develop

```
npm run typecheck
npm test          # vitest (live model tests are excluded by default)
```

## Shape

- `src/loop/` — the one agent loop; durable step per iteration; typed terminations.
- `src/db/` — the SQLite spine: agents, sessions, messages, runs, steps, approvals,
  compactions, triggers, actions (the audit log), events. The database *is* the state.
- `src/daemon/` — the runtime: serial wake inbox, scheduler, event sink, recovery.
- `src/policy/` — the approval policy seam (allow / gate / deny) governing tool calls.
- `src/tools/` — tools (files, shell, memory, scheduling, introspection) behind a
  capability-injected `ToolContext`.
- `src/protocol/` — the native `ReefEvent` vocabulary consumers project from.
- `src/interface/` — HTTP+SSE and the conch projection; `src/daemon/socket.ts` for the CLI.
- `src/client/` — the Ink TUI (sessions view, streaming, markdown, syntax highlighting).
