# Coding-Agent Control — Design Spec

> **Status:** Design approved (brainstorm, 2026-06-11). Ready to implement Step 1.
> **Sub-project:** F — the first slice of reef's multi-agent arc.

## Context

Reef should act as **middle-management over external coding agents** — spawn an instance of
Claude Code (Codex and others later) in a directory, feed it prompts and feedback, watch its
output, and **handle its approvals through reef's own policy**. This is the first concrete
multi-agent capability the user wants, ahead of internal reef→reef delegation.

It dispatches to a *foreign* agent loop (Claude Code has its own loop), so it is not the
reef-record→reef-record delegation of `reef-docs/05`. But it is a real early instance of that
model: an **external worker** spawned by a reef run (graph linkage), **governed** by reef's
approval + audit (the broker's spirit), reporting back as a **durable artifact** (the session
record), not a message. The patterns built here — suspend/resume-on-subwork, approval-routing
to a sub-worker, graph linkage — are the ones internal delegation reuses later.

## Goals

- A reef agent can start a Claude Code session in a target directory with a task.
- Reef intercepts Claude Code's interactive approval prompts and routes them through the
  existing `ApprovalPolicy` (auto-answer, or gate → surfaces → human).
- The reef agent is woken at decision points (approval / completion; later: questions,
  feedback) — the "managed session with re-wakes" model.
- **Everything is captured and replayable** so the brittle TUI-scraping can be iterated
  empirically: build → run against real Claude Code → inspect → fix → replay to confirm.

## Non-goals (seams left open, not built now)

- Codex and other agents (the transport abstraction leaves room; net-new — no corpus prior art
  for driving Codex interactively).
- The structured/headless transport (`claude -p` / Agent SDK). Deferred for billing: headless
  draws on a separate capped Agent-SDK credit pool; **interactive (PTY) uses the full plan
  allowance**. See "Billing" below.
- Concurrent coding sessions; mid-session feedback beyond the first increments.
- Internal reef→reef delegation (sub-projects A/C), concurrency (B), the real broker (E).

## Key decisions (locked in brainstorm)

1. **PTY, interactive, on-plan.** Drive the real interactive `claude` over a pseudo-terminal so
   usage bills against the Max plan, not the separate Agent-SDK credit pool. The cost is that
   there is **no machine-readable "prompt pending" signal** on the interactive path (confirmed
   from Claude Code source — `--permission-prompt-tool`/`canUseTool` only work with `--print`),
   so prompt detection is **screen-scraping**. This is a known, solved problem (see Prior art).
2. **Managed session with re-wakes (Approach 3).** The manager run suspends (`awaiting_subwork`,
   already reserved in `StopReason`); the session runs while it sleeps; the substrate resumes it
   at decision points. Session and manager **alternate** — no concurrency needed, no deadlock.
3. **Transport abstraction.** A `CodingAgentDriver` seam (evolves the archived `AgentAdapter`):
   PTY transport first, structured transport later behind the same interface.
4. **Governance reuses what exists.** Detected prompts become an `ApprovalContext` →
   `ApprovalPolicy.decide` → allow/gate/deny; every decision writes an `actions` audit row; gated
   prompts fire the existing surfaces (TUI/desktop/webhook). Reef *is* the governance layer.
5. **Reef mints the session id.** `claude --session-id <uuid>` **creates** a session with a
   caller-chosen UUID (verified against `claude` v2.1.173 + source `main.tsx:1277–1297`: the flag
   creates a new conversation; can only combine with `--resume`/`--continue` under
   `--fork-session`). Reef mints the uuid, creates with it, and recovers a lost PTY via
   `claude --resume <uuid>` in the same directory.
6. **Verifiability-first build order.** PTY-driving a TUI is empirical; the classifier cannot be
   specified blind. Build the **flight recorder + a human-as-classifier dumb driver first**,
   capture real traces, and grow the classifier *from* that data, gated by replay.

## Prior art (corpus + reef)

- **gstack** (`~/dev/agent-investigations/reference-projects/gstack`) is a near-exact precedent:
  spawns interactive `claude` in a PTY, scrapes the Ink TUI, detects + answers permission
  prompts. Read `test/helpers/claude-pty-runner.ts` first — ~95% of the mechanics. Key lessons:
  ANSI strip (4-pass), **tail-window** the last ~4 KB (ignore scrollback), the **Ink gotcha**
  (option spacing renders as cursor-moves that strip to *no character* → test spaced **and**
  whitespace-collapsed forms), **fingerprint-debounce** redraws, an **LLM-judge fallback** for
  ambiguous frames.
- **Claude Code source** (`reference-projects/claude-code/src/components/permissions/*`,
  `CustomSelect/use-select-input.ts`): exact prompt strings/titles/options, and the answering
  contract — **a bare digit selects option N immediately** (no Enter); arrows = `\x1b[A/B`,
  Enter = `\r`, Esc = `\x1b`.
- **Reef's archived adapter** (`archive/adapters/`): the `AgentAdapter` seam
  (`spawn`/`resume`/`parseOutput → AsyncIterable<Event>`/`sendInput`) — the transport shape to
  evolve (it took the headless route; we take PTY).

## Architecture & components

### `CodingAgentDriver` — the transport seam
```
interface CodingAgentDriver {
  start(opts: { directory; task; sessionId; preauth }): CodingDriverSession
}
interface CodingDriverSession {
  events: AsyncIterable<DriverEvent>   // output | prompt-pending | exited
  send(text: string): void
  answer(choice: AnswerChoice): void   // by option label, mapped to a digit/keys
  cancel(): Promise<void>
}
```
PTY transport (`PtyClaudeDriver`) first; structured transport later, same seam.

### `PtyClaudeDriver` — the Claude Code PTY transport
- **Spawn** via `node-pty`: `spawn("claude", args, { cwd: directory, cols, rows, env })` with
  `TERM=xterm-256color`, `COLORTERM=truecolor`. `args` = pre-auth flags + `--session-id <uuid>`
  + `--append-system-prompt <hint>` (reef's framing, off-transcript). Binary via config / PATH.
- **Scrape → classify** (raw bytes → `DriverEvent`s): stripAnsi → tail-window → classify
  (numbered-option cursor `❯ 1.` + permission markers vs plan-ready vs prose question; spinner
  glyphs = "still working") → fingerprint-debounce → parse options to `[{index, label}]`.
- **LLM-judge fallback** for ambiguous frames runs on **reef's cheap router** (Z.ai/Ollama/
  haiku), not the plan/API pool.
- **Answer**: map a decision → option **by label** → write `${digit}\r`.

### `CodingSession` substrate (durable)
New table `coding_sessions`:
| col | meaning |
|---|---|
| `id` | reef session id (PK) |
| `spawning_run_id` | the reef run that started it (delegation-graph link); **null** when started by the operator (control command / smoke) rather than the agent tool |
| `agent_kind` | e.g. `claude-code` |
| `external_session_id` | reef-minted UUID passed to `--session-id` (for `--resume`) |
| `directory` | working dir |
| `status` | `starting`/`running`/`awaiting_decision`/`completed`/`failed`/`cancelled` |
| `task` | initial prompt |
| `result` | final summary (nullable) |
| `trace_path` | flight-recorder file pointer |
| `created_at`,`ended_at` | timestamps |

### New protocol events (`coding.*`)
`coding.session.started` · `coding.output` (rendered frame for live view) ·
`coding.prompt.detected` (kind, text, options) · `coding.decision` (decision, via: policy|human,
answer) · `coding.session.completed` (result) · `coding.session.failed` (error). They ride the
event sink → TUI/conch/audit like every other reef event.

### The re-wake bridge (Approach 3)
The session's driver events drive the manager run's suspend/resume:
- **prompt-pending (permission)** → build `ApprovalContext` → `ApprovalPolicy.decide`:
  *allow* injects the mapped digit + audit row; *gate* creates an `approvals` record + fires
  surfaces, the session waits at its own TUI prompt until the human resolves (which injects the
  digit); *deny* injects "No" + audit. Manager stays `awaiting_subwork` throughout.
- **exited / completed** → resume the manager run with the result.
- (Later) **question / mid-session feedback** → resume to let the manager respond.

### Two ways to start a session (operator vs agent)
- **Operator-initiated (Steps 1–2):** a socket **control command** (`start_coding_session`, like
  `set_model`) and the smoke script. No manager run, no suspend/resume — the daemon just starts a
  driver and streams it to the TUI. This is how we test "through reef" *before* the agent-tool
  machinery exists, and why `spawning_run_id` is nullable.
- **Agent-initiated (Step 3):** the reef agent calls a `start_coding_session` **tool**, which
  **suspends** the manager run (`awaiting_subwork`) and resumes it with the result. This is the
  one new bit of loop machinery the slice needs (the reserved `awaiting_subwork` stop reason,
  unimplemented today). Later: `send_feedback(sessionId, text)`, `answer_question(...)`.

Both paths share the same driver, substrate, recorder, and approval integration; only the
initiation + the manager re-wake differ.

### Pre-authorization
Before spawning, reef writes/merges a `.claude/settings.json` in the target dir (and/or passes
`--allowedTools`/`--permission-mode`) mirroring reef's dev-loop policy, so Claude Code
auto-runs safe actions and only prompts on exceptions — cutting scrape volume. **Never**
`bypassPermissions` (it defeats reef-decides).

### The flight recorder + replay (the verifiability spine)
Every session writes a JSONL **trace** (`~/.reef/coding-sessions/<id>.jsonl`), one line per
event, timestamped:
- `pty.raw` `{bytes: base64}` — ground truth (exactly what `claude` emitted)
- `frame` `{stripped, fingerprint}`
- `classify` `{state, matcher, options}`
- `inject` `{data, reason, decisionRef}`
- `policy` `{toolName, input, decision, reason}`
- `lifecycle` `{event: spawn|exit|kill|resume, code?}`

**Replay**: feed a trace's `pty.raw` bytes back through the classifier offline (no `claude`, no
spend) → deterministic. Real captured sessions become test fixtures; "why didn't it detect that
approval?" is debugged by replaying the exact bytes, and fixes are confirmed by re-replay.

### The TUI split-view
Extend reef's sessions view to render a coding session split: the live terminal on one side,
**reef's interpretation** on the other (detected state, pending approval, last injection). Plus
it is all in the event + audit logs. "See what went right and wrong" = look, live or after.

## Data flow (one session, end to end)

This is the **agent-initiated** end-state (Step 3). Operator-initiated sessions (Steps 1–2) are
identical minus the manager suspend/resume (no run to suspend) — the driver/recorder/approval
path is the same.

1. Reef agent calls `start_coding_session({agent, directory, task})` → policy gates it.
2. Daemon mints a uuid, inserts a `coding_sessions` row, opens a trace file, and starts the
   driver; the **manager run suspends** (`awaiting_subwork`).
3. `PtyClaudeDriver` spawns `claude` in the dir; raw bytes stream to the trace; `coding.output`
   frames stream to the live view.
4. Claude Code hits a permission prompt → classifier emits `prompt-pending` → `ApprovalPolicy`:
   allow → inject digit; gate → approval record + surfaces, session waits, human resolves →
   inject digit; deny → inject "No". Each is traced + audited.
5. Session ends → `coding.session.completed` with a result; the manager run **resumes** with it.
6. (Crash/restart) the `coding_sessions` row + `external_session_id` make the session
   **resumable** via `claude --resume <uuid>`.

## Error handling & robustness

- **Lifecycle kill**: SIGINT (Claude Code's graceful interrupt) → ~2 s → SIGKILL, with
  **process-group kill** (Claude Code spawns grandchildren via Bash) — net-new vs gstack.
- **Hang detection**: output-idle past a budget → LLM-judge `working` vs `hung` → if hung,
  surface to the manager.
- **Crash-fast**: process exits before a result → fail with the last captured frame.
- **Version drift**: marker strings are a *maintained allowlist + collapse-variants + judge
  fallback*, never a permanent contract.
- **Recovery**: non-terminal `coding_sessions` are resumable via `--resume`; whether v1
  auto-resumes on boot or leaves them resumable-on-demand is a Step-3 scope call.
- **Cancellation propagation**: cancelling the manager run cancels the session (kill the PTY).

## Verifiability & testing

- **Replay suite** (deterministic, no `claude`): captured traces are fixtures; assert the
  classifier detects the expected prompts/options on real recorded bytes. This is the regression
  net for the brittle part.
- **Injectable driver**: a fake `CodingAgentDriver` for unit-testing the re-wake bridge,
  approval integration, and substrate without a real PTY.
- **Live smoke** (`scripts/coding-session-smoke.ts`): spawn real `claude` in a **temp/sandbox
  dir** with a trivial task, stream the trace, dump a post-mortem timeline. Safe by construction
  (temp dir, pre-auth).
- **Through-the-reef-agent test** (the bar): in the reef TUI, "use Claude Code in `~/x` to do Y";
  watch the split-view; inspect trace + event + audit logs.
- **The iterate loop**: run live → watch split-view → save trace → tweak a matcher → replay to
  confirm → re-run live.

## Build plan (verifiable at each step)

- **Step 1 — Recorder + raw pump + human-as-classifier.** Add `node-pty`. `PtyClaudeDriver`
  spawns `claude --session-id <uuid> [pre-auth] --append-system-prompt <hint>` in a dir; capture
  the full trace; emit `coding.output`. Sessions are **operator-initiated** (a socket
  `start_coding_session` control command + the smoke script — no agent tool / suspend-resume
  yet). A **crude** "a prompt is up" heuristic surfaces every prompt to the human via reef's
  approval UI (answer maps to a digit injection); a raw send-keystrokes escape hatch exists.
  `coding_sessions` row + status; minimal TUI live view. **Exit:** through reef, spawn real
  Claude Code in a temp dir, watch output live, answer prompts by hand, full trace captured +
  replayable.
- **Step 2 — Classifier from traces, gated by replay.** Build marker detection + label-based
  auto-answer against the **actual captured prompts**; replay-test suite; cheap-router judge
  fallback; fingerprint-debounce. **Exit:** replay suite green; live, reef auto-classifies common
  prompts, human handles the rest.
- **Step 3 — Close the loop.** Wire `ApprovalPolicy` auto-allow/gate, the `awaiting_subwork`
  suspend/resume re-wake, the `start_coding_session` tool, `.claude/settings.json` pre-auth,
  cancellation propagation, and (optionally) resume-on-boot. **Exit:** the reef agent drives a
  full session end-to-end, policy-governed, and you can prove what it approved.

## Dependencies & risks

- **`node-pty`** — native module; prebuilt binaries on macOS/Node are reliable. The one new dep.
- **TUI version drift** — mitigated by maintained markers + collapse-variants + judge fallback +
  the replay suite catching regressions against captured fixtures.
- **Billing** — interactive PTY bills against the Max plan (intended). The judge fallback uses
  reef's cheap router, not the plan/API.
- **Safety** — sessions run in a caller-specified dir; testing uses temp/sandbox dirs;
  `start_coding_session` is gated; never `bypassPermissions`.

## Deferred / future

Codex (interactive — net-new) and other agents · the structured transport (when the SDK-credit
tradeoff is acceptable) · concurrent sessions · richer mid-session steering · internal reef→reef
delegation (A/C) · concurrency (B) · the real broker (E), under which "access to a directory"
becomes a proper external lease.
