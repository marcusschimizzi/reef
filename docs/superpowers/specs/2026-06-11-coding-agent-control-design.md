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

---

## Step 3 — resume notes (written after Steps 1–2, to hop back in fast)

**Status:** Steps 1 & 2 are **built, live-verified, committed** on branch `coding-agent-control`
(NB: that branch is ~67 commits ahead of `main`, which is stuck at the MCP-era merge — the whole
agent pivot is unmerged; decide the merge story separately). All offline tests green.

### What's already built that Step 3 just wires together
- `src/coding/scrape.ts` + `render.ts` + `processor.ts` — the PTY scrape: render the screen,
  detect a prompt, parse clean option labels, debounced. **Detection works** (proven against real
  fixtures). Step 3 does **not** need to touch scraping.
- `src/coding/prompts.ts` — `classifyPrompt(text)→trust|permission|plan|question`,
  `promptAction(text)` (the "Do you want to X?" clause), `answerFor(options, decision)→option
  index by label`. **These exist and are tested** — Step 3 calls them.
- `src/coding/transcript.ts` — read Claude Code's own session JSONL; `latestToolUse(entries)` is
  the **reliable approval action** ("Write summary.txt"). Locate by minted session-id.
- `src/coding/manager.ts` — on a PTY `prompt-pending` it currently sets status
  `awaiting_decision` and emits `coding.prompt.detected`, leaving the answer to the operator's
  `send()`. **This is the exact hook Step 3 replaces** with the policy flow below.

### The Step-3 approval flow (concrete)
On `prompt-pending` in the manager:
1. Build an `ApprovalContext`: `tool_name = "claude-code:" + (latestToolUse.name ?? classifyPrompt)`,
   `input = latestToolUse.input` (reliable, from the JSONL) **or** the scraped `promptAction`
   (fallback), `source` = the run's source.
2. `policy.decide(ctx)` → **allow**: `answerFor(options, "allow-once")` → `manager.send(id, "${n}\r")`
   + audit row. **gate**: create an `approvals` row + fire surfaces; session waits at its TUI
   prompt; on human resolve → `answerFor(options, decision)` → inject. **deny**: inject the No option.
3. Every decision writes an `actions` audit row (reuse the existing audit path).

### The two genuinely-new pieces
- **`awaiting_subwork` suspend/resume** (reserved `StopReason`, still unimplemented). **Mirror the
  existing approval suspend/resume in `AgentLoop`** (`b7786ed` shipped suspend-for-approval:
  emit → persist → set run suspended → resume job re-drives). Step 3 adds a suspend-for-subwork
  variant: the manager run suspends when it starts a coding session, resumes on session completion.
- **The agent `start_coding_session` tool** — the agent-initiated path. The **operator** path
  (socket `coding_start`) already works; the tool wraps `Daemon.startCodingSession` and suspends
  the calling run.

### KEY INSIGHT — no deadlock here (unlike internal reef→reef delegation)
The coding session is an **external subprocess**, not a reef run on the serial inbox. So when the
manager run suspends (`awaiting_subwork`), the PTY session keeps running **on its own** and reef's
inbox is free. The "alternate via suspend/resume" works **without** the serial-queue deadlock that
internal delegation (sub-project C) has to solve. This is why F is a good first slice.

### Live findings that re-prioritize Step 3
- **The user's Claude Code is permissive** — plain Bash (`echo`) ran with **no** prompt; only
  edits/writes prompted. So in practice **approval prompts are rare**; the auto-answer path is
  lightly exercised and **`.claude/settings.json` pre-auth is lower-value than expected** (their
  config already pre-authorizes much of the dev loop). Prioritize the agent tool + suspend/resume
  + the JSONL-driven observability over pre-auth.
- **Weekly plan limit** was at ~85% (resets ~Jun 15) — capture live sparingly; lean on the
  committed fixtures (`tests/coding/fixtures/{trust-prompt,edit-approval,claude-session}.jsonl`)
  and `replayTrace`, which need no Claude spend.
- The DEEP JSONL integration (manager **live-tails** the JSONL → emit clean `coding.output` from
  it instead of the garbled PTY stream; reuse the file-watch seam) lands here too.

### First concrete move for Step 3
Replace the manager's `prompt-pending` hook with the policy flow above (using a fake driver +
the committed fixtures to test it), THEN add `awaiting_subwork` + the agent tool. Dev aids:
`scripts/{capture-fixture,trace-inspect,trace-raw,coding-session-smoke}.ts`.

---

## Step 3 — detailed design (pinned 2026-06-12, full scope A+B+C this session)

Two reconnaissance findings pinned the mechanics down and forked the design from a naive
"mirror the approval flow" reading:

- **The `approvals` table cannot host coding-session prompts.** `approvals.run_id` is `NOT NULL`
  with an FK to `runs`, and `Daemon.resolveApproval` does `pendingApprovalCount(runId) → enqueue
  resume`. A coding session's *internal* prompt (Claude Code wants to edit a file) must NOT
  resume the manager run — the manager run only resumes when the **whole session** completes. And
  operator-initiated sessions have no run. So coding approvals are a different kind of record.
- **Two suspends compose in sequence.** `start_coding_session` is gated → manager run suspends
  `awaiting_approval` (existing `b7786ed` machinery) → human approves → resume → tool wants
  subwork → suspends `awaiting_subwork` (new) → session runs → completes → resume with result.
  The loop checks gate **before** subwork, so they layer — but the subwork-suspend check must
  live in **both** the normal turn path and `finishSuspendedTurn` (the post-approval resume).

### A — policy flow in `CodingSessionManager` (on `prompt-pending`)
1. Read Claude Code's transcript JSONL (`findClaudeTranscript(externalSessionId, {cwd})` →
   `latestToolUse`) for the reliable action; fall back to scraped `promptAction(text)`.
2. Build a `PolicyContext`: `toolName = "claude-code:" + (latestToolUse?.name ?? classifyPrompt)`,
   `input = latestToolUse?.input ?? promptAction`, `needsApproval = true`,
   `source` = the spawning run's source (operator-initiated → `{kind:"message"}`),
   `sessionKey = coding:<id>`, `agentId` = the coding agent's id (or the spawning agent's).
3. `policy.decide(ctx)`:
   - **allow** → `answerFor(options,"allow-once")` → inject `${n}\r`; audit `actions` row.
   - **deny** → `answerFor(options,"deny")` → inject; audit (outcome `denied`).
   - **gate** → insert a `coding_approvals` row (status `pending`), `emit("approval.requested")`
     so the existing surfaces fire; session waits at its PTY. On human resolve →
     `answerFor(options, decision)` → inject; audit.

### Gate storage — `coding_approvals` table (decision: durable, not in-memory)
A dedicated durable table, parallel to `approvals` but never colliding with the run-resume path:

| col | meaning |
|---|---|
| `id` | approval id (PK; reuse `newApprovalId()`) |
| `coding_session_id` | the `cs_…` session it belongs to |
| `prompt_text` | the rendered prompt |
| `options` | JSON `[{index,label}]` (so resolve can `answerFor`) |
| `tool_name` | `claude-code:<latestToolUse>` (for the surface/audit) |
| `input` | JSON — `latestToolUse.input` or `promptAction` |
| `status` | `pending`/`allowed`/`denied` |
| `decision` | the resolved decision string (nullable) |
| `created_at`,`decided_at`,`expires_at` | timestamps (expiry reuses the proactive auto-deny) |

`Daemon.resolveApproval(id, decision)` checks `coding_approvals` **first**: if the id is a coding
approval, resolve it there and route to `manager.resolveCodingApproval(id, decision)` (inject the
mapped digit + audit) — do **not** touch the run-resume path. Rationale (user, 2026-06-12): we
already mint the session UUID, so `--resume` recovery is cheap to add later and the durable row
becomes actionable; doing it right now avoids debt. Until recovery lands, a restart leaves the row
`pending` against a dead PTY — acceptable, and the natural seam for the future recovery work.

### B — `awaiting_subwork` suspend/resume (new loop machinery, mirrors `b7786ed`)
- `Tool` gains `suspendsForSubwork?: boolean` (parallel to `needsApproval`).
- `LoopDeps` gains two hooks the daemon wires to the manager + spine:
  `startSubwork(run, call) → codingSessionId` (start the session linked to `run.id` + `call.id`)
  and `collectSubwork(runId, toolUseId) → { result } | undefined` (read the completed session's
  result). Omitting them preserves today's behavior (a subwork tool with no hook just runs).
- Shared check in **both** the main loop iteration and `finishSuspendedTurn`: an un-started
  subwork tool → `startSubwork`, persist the step pending (model turn saved), `setRunStatus(
  suspended, {stopReason:"awaiting_subwork"})`, emit `run.suspended`, return `"awaiting_subwork"`.
- `Daemon.resumeRun` picks the resume mode from the run's stored `stopReason`
  (`awaiting_subwork` → subwork resume; else the existing approval resume).
- Completion→resume: the daemon already subscribes to the sink; on `coding.session.completed`
  for a session with a non-null `spawning_run_id`, enqueue `{kind:"resume", runId}`. The resume
  runs `collectSubwork` → the transcript's final assistant text becomes the `tool_result`; the
  turn commits and the loop continues.
- New column `coding_sessions.spawning_tool_use_id` so `collectSubwork` locates the session by
  `(spawning_run_id, spawning_tool_use_id)`. `coding_sessions.result` (already in the schema) is
  set on completion from `renderTranscript`'s final assistant text.

### C — the `start_coding_session` tool
`{ name:"start_coding_session", description, inputSchema:{directory, task, agentKind?},
needsApproval:true, suspendsForSubwork:true }`. Registered in the daemon's tool list; an agent
must list it in its allowlist to use it. `needsApproval:true` means a proactive/trigger run
**denies** it (no approver — safe) and an interactive run **gates** it (human approves spawning
Claude Code). Its `run()` is never executed for effect (the loop's `startSubwork` hook does the
work, like gate) — it throws if reached, signalling a wiring bug.

### Testing (no Claude spend)
- Replay/fixtures unchanged. New: drive A end-to-end through `CodingSessionManager` with the
  `FakeDriver` + committed fixtures (`trust-prompt`/`edit-approval`/`claude-session`) and a fake
  `ApprovalPolicy` returning each of allow/gate/deny; assert the injected digit, the audit row,
  and (gate) the `coding_approvals` row + `resolveCodingApproval` injection.
- B+C: unit-test the loop's subwork suspend/resume with a fake `startSubwork`/`collectSubwork`
  and a stub `start_coding_session` tool; assert `awaiting_subwork` on first pass and the
  `tool_result` from `collectSubwork` on resume. Daemon-level test: the two-suspend composition
  (gate-approval then subwork) and the `coding.session.completed → resume` wiring.

### Build order (TDD, each step green before the next)
1. `coding_approvals` table + spine CRUD; manager A-flow (allow/deny first, then gate +
   `resolveCodingApproval`); `Daemon.resolveApproval` fork. (Concern A.)
2. `Tool.suspendsForSubwork`; loop subwork suspend/resume + `LoopDeps` hooks;
   `coding_sessions.spawning_tool_use_id` + result-on-completion. (Concern B.)
3. `start_coding_session` tool + daemon wiring (`startSubwork`/`collectSubwork`,
   completion→resume enqueue, `resumeRun` mode select). (Concern C.)
4. Daemon composition test + cancellation propagation (cancel manager run → kill PTY).

**Step 3 STATUS: BUILT + MERGED TO MAIN (2026-06-12, 282 tests).** All of A+B+C plus the
review-fix rounds. Plan: `docs/superpowers/plans/2026-06-12-coding-agent-control-step3.md`.
Also added: **model selection** (`--model`, `REEF_CODING_MODEL` env default — run testing on
haiku). **Live-verified** against real Claude Code v2.1.175 on Haiku 4.5: trust prompt detected
with clean labels, ApprovalPolicy auto-answered (`policy:allow` → injected `1`), result captured
from the transcript. The live run surfaced the handback gap below.

---

## Step 3.1 — handback & resumable session lifecycle (design 2026-06-12)

**Why:** Live verification showed interactive `claude` does **not** exit after finishing a task —
it completes the work and waits at its prompt. So a coding session never reaches a natural
`completed`; the smoke ran to its 120 s safety cap and was force-cancelled. For the agent flow
this is load-bearing: with no session end, `collectSubwork` never fires and the manager run stays
suspended `awaiting_subwork` forever.

**Reframe (user, 2026-06-12):** a coding session is a **durable, resumable entity** (minted UUID +
`claude --resume <uuid>`). "This increment is done, hand control back" is NOT "permanently done" —
only the user deems a session finished-forever. So completion-of-an-increment is a **handback**
that *parks* the session resumably, not a teardown of its identity.

### The handback signal (hybrid: sentinel primary, idle fallback)
- **Sentinel** via the existing `appendSystemPrompt` seam: the manager always injects a handback
  instruction telling the agent to print a unique marker (`<<REEF_HANDBACK>>`) on its own line
  when it has finished the requested task and is awaiting further instructions. Detected in the
  manager by scanning rendered `output` text for the marker → fast handback.
- **Idle fallback**: the manager arms a per-session idle timer (`idleMs`, dep/`REEF_CODING_IDLE_MS`
  default ~8 s), reset on each `output`. Fired while `running` → handback. **Disarmed during
  `awaiting_decision`** (a gated prompt waiting on a human is idle but NOT done) and re-armed when
  the prompt is answered. Safety net for a non-compliant agent.

### On handback (manager)
Latch (once per session) → `readResult` (transcript final assistant text) → set status **`paused`**
+ result → emit **`coding.session.paused {codingSessionId, result?}`** → tear down the PTY as a
**deliberate handback** (a `handingBack` set, like `cancelling`, so `onExit` records neither
`failed` nor a second completion event — it just clears the timer + trace + live entry). The
`external_session_id` is retained → revivable via `--resume`.

### Lifecycle / status model
`running` → (`awaiting_decision` ⇄ `running`) → **`paused`** (increment done, PTY torn down,
**resumable**). `completed`/`cancelled` stay reserved for **user-ended** sessions. `paused` is a
new free-text value of `coding_sessions.status` (no schema change). Reviving a paused session is a
future `send_feedback(sessionId, text)` that spawns `claude --resume <uuid>` with the new prompt.

### Daemon wiring
- `onSinkEvent`: `coding.session.paused` (like `completed`/`failed`) for a session with a
  `spawning_run_id` → enqueue `{kind:"resume", runId}`.
- `collectSubwork`: treat `paused` as a completable status (return its `result`; `failed` only for
  status `failed`). So the manager run resumes with the increment result on handback.

### Testing (no Claude spend)
`containsHandback(text)` unit; manager: marker in `output` → `coding.session.paused` + status
`paused` + PTY killed + result captured + NO `completed` event; idle fallback via fake timers;
idle disarmed during `awaiting_decision`; `appendSystemPrompt` carries the handback instruction
(via `driver.lastOpts`); daemon: `coding.session.paused` enqueues a resume + `collectSubwork`
returns the result for `paused`. Smoke updated to report `paused` (should now end cleanly, no cap).

**Step 3.1 STATUS: BUILT + LIVE-CONFIRMED (2026-06-12).** Strengthened the handback instruction;
added the deterministic Stop-hook path (`--settings` Stop hook touches a reef-owned sentinel reef
watches — onboarding-clean, no repo pollution). Live: the Stop hook FIRES in interactive/PTY mode
(sentinel file created) and the strengthened prompt made haiku emit the marker; result-capture
moved to `onExit` (after the transcript flush) + marker stripped. Plus **model selection**
(`--model`/`REEF_CODING_MODEL`).

---

## Step 3.2 — `send_feedback(sessionId, text)`: revive a paused session (design 2026-06-12)

The payoff of the resumable-`paused` lifecycle: a reef agent feeds a follow-up increment to a
parked coding session, reviving it via `claude --resume <uuid>`. Reuses the **same subwork
suspend/resume machinery** as `start_coding_session` — the manager run suspends `awaiting_subwork`,
the revived session runs, hands back (`paused`) with a NEW result, the run resumes with it.

### Decisions (user-confirmed 2026-06-12)
- **Not gated** (`needsApproval: false`): continuing an already-approved session is lower-risk; the
  per-edit approvals INSIDE the session still gate via `ApprovalPolicy`.
- **Invalid/non-`paused` sessionId → graceful error tool_result** (not a run failure): the loop's
  subwork-suspend wraps `startSubwork`; a thrown revive-failure becomes an `isError` tool_result so
  the agent learns + retries, and the run continues.

### Necessary contract change — subwork tool_result exposes the session id
The agent only sees tool_results (not raw events), so to call `send_feedback` it needs the `cs_…`
id. `collectSubwork` now returns `{ result, failed, sessionId, status }`; the loop builds the
subwork tool_result `output = { codingSessionId, status, result }` (was a bare string). Applies to
`start_coding_session` AND `send_feedback` — more useful, and the id is how the agent references
the session.

### Mechanics
- **Driver revive mode:** `StartOpts.resume?: boolean` → `claudeArgs` emits `--resume <id>`
  (instead of `--session-id <id>`) + model/settings/append-prompt + the feedback text.
- **`coding_sessions.model`** column (nullable) so revive faithfully reuses the original model
  (also observability). Set on `start`.
- **`CodingSessionManager.resume(sessionId, text, { spawningRunId, spawningToolUseId })`:** validate
  the row is `paused` (else throw → graceful loop error); **re-link** `spawning_run_id` +
  `spawning_tool_use_id` to the current (run, toolUse) so `collectSubwork` routes the new result
  back; reopen the trace (append — one continuous record); status → `running`; `driver.start` in
  resume mode with the stored model + a fresh handback settings file + the handback instruction;
  re-arm the handback detectors. New handback → `paused` with the new result → run resumes. Shared
  "live setup" (trace/processor/watcher/onData/onExit wiring) is extracted from `start`.
- **`send_feedback` tool** (`src/tools/coding.ts`): `{ sessionId, text }`, `suspendsForSubwork:
  true`, `needsApproval: false`, `run()` throws (loop-handled).
- **Daemon `startSubwork` dispatch on `call.name`:** `send_feedback` → `manager.resume(...)`;
  else → `manager.start(...)` (existing). `collectSubwork` unchanged beyond the id/status fields.
- **Loop graceful failure:** the main-loop subwork-suspend wraps `await startSubwork` in try/catch
  → on throw, commit an `isError` tool_result and continue (don't suspend).

### Testing (no Claude spend)
`claudeArgs` resume mode (`--resume` vs `--session-id`); manager `resume` revives a `paused` row
(status→running, re-linked, driver got `resume:true` + stored model), throws on a non-`paused`
id; tool registered with the flags; daemon dispatch (`send_feedback`→resume); loop builds the
structured `{codingSessionId,status,result}` tool_result + the graceful-failure error result; e2e:
start→paused→send_feedback→paused-again with the new result. Live (after): revive a real paused
haiku session with a follow-up.
