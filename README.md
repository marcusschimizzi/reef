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
npm run setup    # guided: pick a provider, enter your API key (stored in your OS keychain)
npm run daemon   # start the agent daemon (unix socket + HTTP/SSE on :9876)
npm run tui      # the Ink terminal UI, in a second shell
```

`npm run setup` is the easy path — choose a provider from the catalog (Anthropic,
OpenAI, Ollama, OpenRouter, Z.ai, OpenCode Go, …), confirm a model, and enter the
key with hidden input. The key is stored in the **OS keyring** (a 0600
`~/.reef/secrets.json` when no keyring is available) — never in a config file or
a manual env var. State lives in `~/.reef`
(SQLite db, workspaces, control socket, config, policy) — cwd-independent, since
the daemon is a persistent personal service. Set `REEF_HOME` to relocate it (e.g.
`REEF_HOME=$PWD/.reef` to keep state repo-local while hacking on reef).

### Useful env

- `REEF_HOME` — state directory (default `~/.reef`); the daemon, TUI, and config
  CLI all resolve it, so they stay in sync.
- `REEF_HTTP_PORT` (default `9876`), `REEF_API_KEY` — HTTP interface.
- `REEF_HEARTBEAT_MINUTES` — opt-in self-maintenance heartbeat cadence (`0`/unset = off).
- `REEF_MODEL` — model the default agent uses, as `provider/model` (a bare id is
  Anthropic). Built-in providers: `anthropic`, `openai`, `ollama` (local, free —
  `ollama/llama3.1`), `openrouter` (cheap — `openrouter/…`). Keys come from each
  provider's conventional env var (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, …);
  Ollama needs none. Custom OpenAI-compatible endpoints (Z.ai, etc.) are added via
  config (coming next).
- `REEF_LOG=off` — silence run-lifecycle logging.
- `REEF_THEME`, `REEF_AVATAR` — TUI look (`teal` + `pixel` by default).

## Configuration

Non-secret settings live in `.reef/config.json` (or `REEF_CONFIG_FILE`) — see
`config.example.json`. It's optional and fail-soft: a missing or invalid file
falls back to defaults, never crashing the daemon. Keys: `defaultModel`,
`providers` (custom OpenAI-/Anthropic-compatible endpoints like Z.ai or OpenCode
Go, extending the built-ins), and `policyFile`. **Secrets never go here** — a
provider names the env var its key comes from (`apiKeyEnv`). An env var overrides
the matching config key (`REEF_MODEL`, `REEF_POLICY_FILE`), so the precedence is
env → config → built-in default.

Edit it with the `config` CLI (every change is validated before writing; restart
the daemon to apply):

```
npm run config -- show
npm run config -- set defaultModel ollama/llama3.1
npm run config -- provider add zai openai-compatible --base-url <url> --api-key-env ZAI_API_KEY
npm run config -- provider rm zai
```

## Approval policy

Whether a tool call runs, asks for approval, or is refused is decided by an
approval policy. By default, gated tools (`shell`) ask for human approval. You
can configure this with a JSON file at `.reef/policy.json` (or `REEF_POLICY_FILE`)
— an ordered list of rules, first match wins, anything unmatched falls through to
the default. See `policy.example.json` for a conservative dev-loop shell safelist
that auto-allows `tsc`/`vitest`/`git diff` and the like (every action is still
recorded in the `actions` audit log; `GET /v1/actions`). Auto-allow only applies
to plain commands and matches on parsed argv prefixes, so `git push`, `rm`, and
anything chained/redirected still gate. A missing or invalid config falls back to
the default — a broken config never grants authority.

### Proactive approval routing

A proactive run (trigger/heartbeat) has no human attached to its session, so a
gated tool can't be approved live. By default (`proactiveApproval: "deny"`) it's
auto-denied and the run continues. Set `proactiveApproval: "route"` and configure
`surfaces` (desktop notification, webhook → Slack/ntfy/custom) and reef instead
**suspends and notifies you** to approve in your UI (TUI/conch/`POST
/v1/approvals/:id/resolve`); an unanswered request auto-denies after
`proactiveApprovalTimeoutSeconds` (default 3600), so it never hangs. Put a secret
webhook URL in an env var named by `urlEnv`, not in the file.

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
