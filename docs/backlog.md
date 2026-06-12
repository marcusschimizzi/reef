# Reef backlog

> Source: full-repo evaluation, 2026-06-12 (multi-agent review of the codebase + a mining pass over
> all 19 `~/dev/agent-investigations` reports and synthesis docs; every non-low finding adversarially
> verified against the code). Full findings: `docs/eval/2026-06-12-evaluation.md` (+ raw JSON alongside).
>
> Conventions: **P0** fix now · **P1** before/with coding-agent Step 3 · **P2** next arcs · **P3** quality of life.
> Effort: S (≤half day) · M (1–3 days) · L (a week+). Check the box when done; leave a dated note if a
> ticket is rejected or superseded (same protocol as `reef-docs/10-open-questions.md`).
>
> Already shipped while the eval ran: Claude Code session-JSONL ingestion (`0a6e30f`) — the eval's
> top coding-agent verifiability recommendation (Codex pattern). Kept out of the list below.

## Index

| ID | Title | Prio | Effort | Area |
|----|-------|------|--------|------|
| [RF-01](#rf-01) | Bind HTTP to loopback (+ Origin check) | P0 | S | security |
| [RF-02](#rf-02) | Whitelist approval decision vocabulary | P0 | S | security |
| [RF-03](#rf-03) | Env allowlist for PTY + shell children | P0 | S | security |
| [RF-04](#rf-04) | Stop persisting `coding.output` to the events table | P0 | S | coding-agent |
| [RF-05](#rf-05) | CI + take live smoke out of default `npm test` | P0 | S | testing |
| [RF-06](#rf-06) | Generalize suspend/resume for `awaiting_subwork` | P1 | M | loop |
| [RF-07](#rf-07) | Durable `RunSource` | P1 | S | daemon |
| [RF-08](#rf-08) | Crash recovery: repair dangling `tool_use` turns | P1 | M | loop |
| [RF-09](#rf-09) | Compaction for single-step (chat) runs | P1 | S | loop |
| [RF-10](#rf-10) | Router: surface real provider error causes | P1 | S | model |
| [RF-11](#rf-11) | Scheduler tick reentrancy guard | P1 | S | daemon |
| [RF-12](#rf-12) | Approval integrity: fingerprint + atomic resolve-once | P1 | M | security |
| [RF-13](#rf-13) | `allow-always`: persist it or remove it | P1 | M | policy |
| [RF-14](#rf-14) | Process-group SIGTERM→SIGKILL for coding sessions | P1 | S | coding-agent |
| [RF-15](#rf-15) | `pid` on coding_sessions + every-tick reaping | P1 | S | coding-agent |
| [RF-16](#rf-16) | Idle-output (not wall-clock) hang detection | P1 | M | coding-agent |
| [RF-17](#rf-17) | Progress-ledger supervision for coding sessions | P2 | M | coding-agent |
| [RF-18](#rf-18) | Approval grants: once / session / always → policy.json | P2 | M | policy |
| [RF-19](#rf-19) | One reply-capable surface (signed approve/deny) | P2 | M | surfaces |
| [RF-20](#rf-20) | Guardian: fail-closed LLM auto-reviewer tier | P2 | M | policy |
| [RF-21](#rf-21) | Prompt caching (`cache_control` + stable prefix) | P2 | S | model |
| [RF-22](#rf-22) | Untrusted-content envelope + sanitize at boundaries | P2 | S | security |
| [RF-23](#rf-23) | Durable wake queue with coalescing | P2 | L | daemon |
| [RF-24](#rf-24) | Soft loop termination + RemainingSteps | P2 | S | loop |
| [RF-25](#rf-25) | Tool-loop guards (repeat/ping-pong/no-progress) | P2 | M | loop |
| [RF-26](#rf-26) | Compaction hardening (overflow-retry, /compact, pinned task) | P2 | M | loop |
| [RF-27](#rf-27) | BoundFs symlink containment | P2 | M | security |
| [RF-28](#rf-28) | Webhook payload redaction + signing | P2 | M | surfaces |
| [RF-29](#rf-29) | Wire tests: socket protocol + HTTP interface | P2 | M | testing |
| [RF-30](#rf-30) | VercelRouter offline tests | P2 | M | testing |
| [RF-31](#rf-31) | Loop failure + cancellation tests | P2 | S | testing |
| [RF-32](#rf-32) | Inbox concurrency tests | P3 | S | testing |
| [RF-33](#rf-33) | launchd service + daemon state file | P3 | M | ops |
| [RF-34](#rf-34) | Login-shell env hydration at startup | P3 | S | ops |
| [RF-35](#rf-35) | TUI reconnect + config-apply without double restart | P3 | M | tui |
| [RF-36](#rf-36) | Unread-run tracking (`readAt`) | P3 | S | tui |
| [RF-37](#rf-37) | TUI views: actions audit + triggers | P3 | M | tui |
| [RF-38](#rf-38) | Head+tail tool-output truncation + spine pointer | P3 | S | tools |
| [RF-39](#rf-39) | Mid-run steering (queue/steer/interrupt) | P3 | M | daemon |
| [RF-40](#rf-40) | Wire the memory `primer()` seam (with synapse) | P3 | M | memory |
| [RF-41](#rf-41) | Docs honesty pass | P3 | S | docs |

---

## P0 — fix now

### RF-01 · Bind the HTTP interface to loopback (+ Origin check) {#rf-01}
- [ ] **P0 · S · security**

`startHttpInterface` calls `server.listen(opts.port)` with no host (`src/interface/http.ts:28`) — Node
binds `::` (all interfaces) while `src/daemon/index.ts:129` logs `http://127.0.0.1:…`. Auth is opt-in
(`REEF_API_KEY` unset by default), so the daemon — which runs shell commands and resolves approvals —
is reachable from the LAN, and from any web page via direct localhost requests (no Origin/CSRF check).

**Fix:** pass `"127.0.0.1"` to `listen`; reject requests whose `Origin` header is present and not an
allowed value; make the startup log print the actual bound address. If LAN access is ever wanted, that's
a separate, deliberate listener (gstack's dual-listener pattern), not a default.
**Done when:** `lsof -iTCP -sTCP:LISTEN` shows loopback only; a cross-origin `fetch` from a browser page
is rejected; a test asserts the bind host.
**Source:** eval security #1/#3 (verified); babyagi AVOID, gstack Security Wave 1, openclaw AVOID.

### RF-02 · Whitelist the approval decision vocabulary {#rf-02}
- [ ] **P0 · S · security**

`Daemon.resolveApproval` maps `decision === "deny" ? "denied" : "allowed"` (`src/daemon/Daemon.ts:266`)
— case-sensitive, allow-by-default. `{"decision":"denied"}`, `"DENY"`, or `"cancel"` **approves** the
gated tool. The HTTP route (`src/interface/http.ts:126`) only defaults a *missing* decision to deny;
the socket path forwards the raw string.

**Fix:** parse against the closed set `allow-once | allow-always | deny` (the protocol's own vocabulary,
`src/protocol/events.ts:16`); anything else → deny, with a logged warning naming the rejected string.
**Done when:** tests cover `"denied"`, `"DENY"`, `""`, and garbage strings all denying, on both the HTTP
and socket paths.
**Source:** eval quality (high, verified inline 2026-06-12).

### RF-03 · Curated env allowlist for PTY + shell children {#rf-03}
- [ ] **P0 · S · security**

`PtyClaudeDriver` spawns with `{ ...process.env, TERM, COLORTERM }` (`src/coding/ptyClaude.ts:22`) and
the shell tool inherits the daemon env (`src/tools/shell.ts:35`). The daemon env carries provider API
keys for every configured vendor (env-overrides-config by design), so any shell command the model runs —
or is prompt-injected into running — can `env`-exfiltrate them, and the driven Claude Code child sees
all of reef's credentials.

**Fix:** build child env from an explicit allowlist (`PATH`, `HOME`, `LANG`, `TERM`, `COLORTERM`,
`SHELL`, …) plus per-context additions (the coding agent needs its own auth, not reef's). One helper,
used by both spawn sites.
**Done when:** a test asserts a known daemon-env secret name is absent from both child env builds.
**Source:** eval security (verified); openhuman `env_clear`, paperclip GHSA-gqqj-85qm-8qhf, babyagi AVOID.

### RF-04 · Stop persisting `coding.output` to the events table {#rf-04}
- [ ] **P0 · S · coding-agent**

`EventSink` persists every event unconditionally, and the coding-session manager emits `coding.output`
per PTY chunk — Ink redraw frames are being written to SQLite, flooding the per-session events table and
duplicating the flight-recorder trace (which the spec designates as the ground-truth record; the spine
should hold the *pointer*, `trace_path`, not a second copy).

**Fix:** per-event-type persistence policy on the sink (broadcast-only for `coding.output`; persist
lifecycle/prompt/decision events). TUI live view + replay-from-trace are unaffected.
**Done when:** a live coding session adds O(lifecycle) rows to `events`, not O(frames); replay of a
recorded session still renders.
**Source:** eval architecture (high, verified — "the window to fix before wiring has closed; it's a retrofit").

### RF-05 · CI + take the live smoke out of default `npm test` {#rf-05}
- [ ] **P0 · S · testing**

Nothing runs the suite automatically (no `.github`, no hooks), and `tests/live/smoke.test.ts` runs inside
default `npm test` — a real Anthropic call on every local run, silently green without a key.

**Fix:** GitHub Actions workflow running `npm run typecheck && npm test` on push/PR; exclude `tests/live/`
from the default vitest run (separate `npm run test:live`).
**Done when:** a red test blocks a PR; `npm test` makes zero network calls.
**Source:** eval testing (high, verified).

## P1 — always-on correctness (land before/with coding-agent Step 3)

### RF-06 · Generalize suspend/resume for `awaiting_subwork` {#rf-06}
- [ ] **P1 · M · loop** — **Step 3 blocker**

The resume pipeline is approval-shaped end to end: `Daemon.resumeRun` hardcodes `resumeApproval: true`
(`src/daemon/Daemon.ts:572`), the resume `Job` carries no payload, and `finishSuspendedTurn`
(`src/loop/AgentLoop.ts:305`) **re-executes** the pending step's tools. `awaiting_subwork` (reserved in
`StopReason`, named by the spec as "the one new bit of loop machinery the slice needs") is incompatible:
`start_coding_session` already ran — re-executing it would re-spawn the session. The result must be
**injected** as a tool_result from outside.

**Fix:** typed `SuspendKind` on the run + a resume job variant carrying externally-supplied tool results;
approval-resume becomes one case of the general mechanism (avoid forking a second resume path — the
two-mechanisms drift `reef-docs/02` warns about, and openhuman's documented loop-drift failure).
**Done when:** a fake `CodingAgentDriver` test suspends a manager run, injects a completion, and the run
resumes with the result in its transcript; approval-resume tests still pass.
**Source:** eval architecture (high, verified); spec §"Two ways to start a session".

### RF-07 · Durable `RunSource` {#rf-07}
- [ ] **P1 · S · daemon**

`runs` has no `source` column (`src/db/schema.ts:37-47`); `recover()` and post-restart resumes re-drive
with no options, so the loop defaults to `{kind:"message"}`. Consequences: source-scoped policy rules
silently stop matching, and a recovered proactive run's next gated tool **suspends forever for a human
who isn't there** — the exact hang approval-routing exists to prevent. (Restart also empties the
in-memory `runMeta` routing map.)

**Fix:** persist source on the run row; recovery/resume re-derive it; rebuild routing metadata from the
spine instead of only from live `run.started` events.
**Done when:** kill the daemon mid-proactive-run → restart → the resumed run still auto-denies/routes
gated tools per `proactiveApproval`, with a test.
**Source:** eval architecture + quality (high, verified).

### RF-08 · Crash recovery: repair dangling `tool_use` turns {#rf-08}
- [ ] **P1 · M · loop**

The assistant turn (with `tool_use` blocks) is durably appended (`src/loop/AgentLoop.ts:134`) *before*
tool execution (`:174`) and `commitStep`. A crash in that window leaves the session's last message a
`tool_use` with no `tool_result`; recovery re-drives the run and every subsequent model call 400s —
the session is permanently poisoned. Violates the #1 goal (`reef-docs/01`: recovery "never from guesswork").

**Fix:** on recovery (and on context assembly as a belt-and-braces), detect a trailing assistant turn with
unanswered `tool_use` and close it with synthetic error `tool_result`s ("interrupted by daemon restart"),
letting the model retry deliberately.
**Done when:** a test kills the loop between message-append and commit, recovers, and the session
completes a subsequent run.
**Source:** eval quality (high, verified).

### RF-09 · Compaction must fire for single-step (chat) runs {#rf-09}
- [ ] **P1 · S · loop**

`maybeCompact` reads the last committed step of the *current run* (`src/loop/compaction.ts:55-57`) and
only runs between loop iterations — a no-tool run commits its only step after the loop exits, so a fresh
run always sees zero steps and skips. Plain conversation = one-step runs = the session grows until it
exceeds the provider window, after which **every** run on that session fails. (RF-26 generalizes; this is
the minimal correctness fix.)

**Fix:** trigger on the session's last *recorded* usage (any run), not the current run's committed steps —
e.g. read the most recent step usage for the session at loop start.
**Done when:** a test drives a chat session past `triggerTokens` with single-step runs and observes
`context.compacted`.
**Source:** eval quality (high, verified).

### RF-10 · Router: surface real provider error causes {#rf-10}
- [ ] **P1 · S · model**

`VercelRouter.generateTurn` drains `fullStream` handling only text/reasoning deltas
(`src/model/router.ts:86-90`); `error` chunks are dropped and the awaited promises reject with ai-sdk's
generic `NoOutputGeneratedError`. A 401 (bad key), 429, overloaded, and context-overflow are
indistinguishable in `run.failed`, the TUI, and logs.

**Fix:** capture the error chunk (or pass `onError`) and rethrow the real cause; map context-overflow to
a typed error so RF-26 can catch it.
**Done when:** offline tests (RF-30) assert a stream error surfaces with its original message in
`run.failed`.
**Source:** eval quality (medium, verified inline 2026-06-12).

### RF-11 · Scheduler tick reentrancy guard {#rf-11}
- [ ] **P1 · S · daemon**

`Scheduler.start` fires `void this.onTick()` on a bare `setInterval` (`src/daemon/Scheduler.ts:19-24`),
and `tickTriggers` awaits each fired trigger's **entire run** inside its loop (`src/daemon/Daemon.ts:530`).
Two triggers due in one tick + first run >30s (routine for LLM runs) → the next tick double-fires the
second trigger.

**Fix:** skip the tick if one is in flight (single boolean). The deeper fix — don't await run completion
inside the tick — falls out of RF-23.
**Done when:** a test with two due triggers and a slow first run observes exactly one fire each.
**Source:** eval quality (medium, verified inline 2026-06-12).

### RF-12 · Approval integrity: action fingerprint + atomic resolve-once {#rf-12}
- [ ] **P1 · M · security**

The `approvalId` is simultaneously the broadcast notification id (SSE/webhook bus) and the sole
credential to resolve — anyone who can read events can approve actions. Separately, the expiry sweeper
racing a late human reply is a live double-resolve class (`sweepExpiredApprovals` vs TUI/HTTP resolve).

**Fix:** (1) approval records carry a fingerprint of the action (tool + canonical args [+ cwd for shell]);
(2) resolution is a CAS on the row — first decisive answer wins, later answers no-op with a clear reply;
(3) notifications carry the id for *reference*, but resolution from a remote surface requires the signed
one-shot token introduced in RF-19 (local TUI/socket stays as-is).
**Done when:** concurrent resolve + sweep in a test produce exactly one decision; remote resolution
without a token is rejected.
**Source:** eval security (high, verified); claude-code `createResolveOnce`, openclaw, letta AVOID.

### RF-13 · `allow-always`: persist it or remove it {#rf-13}
- [ ] **P1 · M · policy**

The TUI binds `A` to allow-always (`src/client/tui/App.tsx:273`), the protocol carries it, the daemon
echoes it — and nothing records a grant anywhere. It is silently allow-once; the next identical action
gates again. Either behavior is defensible; lying about it isn't.

**Fix:** minimal honest version: persist a generated `ConfigurablePolicy` rule (tool + argv-prefix for
shell, via the existing floor) through the policy/config machinery, marked `generatedBy: approval` for
auditability. Or drop the option until RF-18. Supersedes nothing; RF-18 builds on it.
**Done when:** answering `A` to a gated `git status` means the next `git status` auto-allows (with an
actions audit row), and the rule is visible in `policy.json`.
**Source:** eval architecture (medium, verified); rowboat three-scope approval.

### RF-14 · Process-group SIGTERM→SIGKILL for coding sessions {#rf-14}
- [ ] **P1 · S · coding-agent**

`src/coding/ptyClaude.ts` has no kill handling; Claude Code spawns grandchildren via Bash. The spec
promises "SIGINT → ~2s → SIGKILL with process-group kill" — make the driver deliver it, and apply the
same shape to `src/tools/shell.ts` (currently SIGKILLs only the direct child on timeout; bash's children
survive as orphans).

**Fix:** spawn detached (own process group); cancel = signal the negative pid, grace period (rowboat
uses 200ms for shell; the spec says ~2s for Claude Code), then SIGKILL the group; second cancel =
immediate force-kill.
**Done when:** a test (or smoke) spawns a child-spawning command, cancels, and verifies no orphan
survives.
**Source:** spec §error-handling; rowboat, nanoclaw.

### RF-15 · `pid` on coding_sessions + every-tick reaping {#rf-15}
- [ ] **P1 · S · coding-agent**

`coding_sessions` tracks status but not the OS process; recovery runs only at startup. A PTY child that
dies (or outlives a daemon crash) leaves a `running` row forever — and `claude` is resumable
(`--resume <uuid>`), so reconciliation is actually possible and valuable.

**Fix:** store pid (process-group id) at spawn; each scheduler tick, reconcile `running` rows whose
process is gone → `process_lost` (resumable-on-demand per the spec's Step-3 scope call); reap on startup
too.
**Done when:** kill -9 the daemon mid-session; restart; the row is `process_lost` within one tick and
the session is resumable.
**Source:** paperclip (recovery chain every tick), gbrain minions ledger.

### RF-16 · Idle-output hang detection (not wall-clock) {#rf-16}
- [ ] **P1 · M · coding-agent**

A legitimate Claude Code run takes 20+ minutes (wall-clock timeouts are wrong); no PTY output for N
minutes means hung (idle timeouts are right). The spec sketches output-idle → LLM-judge → surface; make
the timer architecture explicit: hard ceiling and idle timer as two distinct, separately-configurable
timeouts, idle refreshed by trace `pty.raw` events.

**Done when:** a stalled fake driver triggers the idle path and surfaces to the manager/operator; a slow
but chatty session doesn't.
**Source:** spec §error-handling; langgraph TimeoutPolicy (run vs idle), nanoclaw heartbeat SLA.

## P2 — approval arc completion

### RF-17 · Progress-ledger supervision for coding sessions {#rf-17}
- [ ] **P2 · M · coding-agent** (Step 3+)

Frame-level hang detection (RF-16) can't see *semantic* stalls — Claude Code busily looping without
progress. MagenticOne's shape: a cheap structured call per decision-point ("request satisfied? progress
being made? in a loop? next instruction?") with a stall counter that triggers re-plan/abort. Runs on the
cheap router (Z.ai/Ollama/haiku), like the planned judge fallback.

**Done when:** a session that loops (fixture/replay) is flagged within K decision points and the manager
is woken with the ledger verdict.
**Source:** autogen MagenticOne; hermes no-progress counters.

### RF-18 · Approval grants: once / session / always → policy.json {#rf-18}
- [ ] **P2 · M · policy**

The designed end state of proactive approval. Resolutions carry scope: `once` (today's behavior),
`session` (in-memory per-session allow set), `always` (persist a rule into `.reef/policy.json` — RF-13's
mechanism — optionally keyed by args-hash with TTL for exact-action grants, goose-style). Still subject
to the structural floor; every auto-allow writes an actions row. Kills "the same nightly cron re-notifies
forever."

**Done when:** approving a gated command with scope=always means the next identical proactive fire
runs unattended-but-audited; the user can revoke by editing policy.json.
**Source:** rowboat (trains the policy file), goose ToolPermissionStore, openclaw.

### RF-19 · One reply-capable surface {#rf-19}
- [ ] **P2 · M · surfaces**

Surfaces are outbound-only; a suspended proactive run can only be approved from the TUI/conch. Make one
surface bidirectional: signed one-shot approve/deny callback URLs in the webhook payload (HMAC token,
single-use via RF-12's CAS, bound to the approval fingerprint) — or a Telegram-bot surface with an
explicit pairing/admission gate. Depends on RF-01 (don't open the resolve endpoint to the LAN before it
binds/authenticates deliberately) and RF-12 (tokens).

**Done when:** an approval notification on a phone can resolve the approval; a replayed/forged callback
is rejected; the audit row records `via: surface:<name>`.
**Source:** reef's own stated end state; anythingllm Telegram pairing, khoj RequestUserAction, letta AVOID.

### RF-20 · Guardian: fail-closed LLM auto-reviewer tier {#rf-20}
- [ ] **P2 · M · policy** (optional, after RF-18)

A middle tier between auto-deny and wake-the-human: a dedicated review call (cheap router, strict JSON
schema) reconstructs the pending action's context and can auto-approve low-stakes gated actions
overnight; anything else falls through to routing/deny. Fail-closed: judge error/timeout → deny. Every
verdict writes an actions row naming the judge — no silent cached verdicts (goose's documented mistake).

**Done when:** a configured "guardian" policy action resolves a gated proactive tool without human wake,
visibly attributed in the audit log.
**Source:** codex guardian_subagent; goose AVOID (silent cached judge).

## P2 — platform robustness

### RF-21 · Prompt caching {#rf-21}
- [ ] **P2 · S · model**

Zero `cache_control` anywhere, in the highest-cache-hit workload imaginable (identical system prompt +
16-tool schema + growing transcript on every heartbeat/cron/watch wake). Via AI SDK `providerOptions`:
breakpoints on the system prompt + trailing messages (hermes "system_and_3"), behind a per-provider
`supportsCacheControl` bit (goose). Prereq discipline: stable content above a marker, volatile per-run
context appended below (openclaw sentinel, open-webui).

**Done when:** anthropic-kind requests carry cache_control breakpoints; usage logs show cache reads on
consecutive heartbeats.
**Source:** goose, hermes, open-webui, openclaw (4-way convergence).

### RF-22 · Untrusted-content envelope + sanitize at boundaries {#rf-22}
- [ ] **P2 · S · security**

File-watch payloads, watched-file content, webhook bodies, memory recalls, and PTY-scraped Claude Code
output enter prompts unmarked. Adopt one canonical wrapper (claude-code `wrapInSystemReminder` /
gstack datamark: "untrusted data, not instructions") applied at every injection site, plus a
`sanitizeForPrompt` (strip control chars, length-clamp) for short external strings like paths/titles
(gbrain). The sharpest exposure is proactive runs: injected content + tool authority + nobody watching.

**Done when:** every non-user-typed injection site routes through the one wrapper (grep-enforceable);
trigger payload tests assert the framing.
**Source:** claude-code, gstack, gbrain, open-webui (4-way convergence).

### RF-23 · Durable wake queue with coalescing {#rf-23}
- [ ] **P2 · L · daemon**

The `Inbox` is in-memory and globally serial; docs 04/05 commit to a durable, atomically-claimed queue.
Trigger fires can be lost in the enqueue→run window on crash; RF-11's race is a symptom. Shape
(paperclip-validated): every wake intent (trigger fire, watch event, resume, heartbeat, coding-session
wake) is a row whose status column is the state machine (`queued/claimed/coalesced/done`), claimed via
CAS `UPDATE … WHERE status='queued'`; a wake arriving for a busy session marks itself **coalesced** into
the in-flight run (merge, don't stack); the recovery chain (reap orphans, promote due work) runs every
tick. Pre-builds the multi-agent dispatch substrate (docs 05) and retires RF-11 properly.

**Done when:** kill -9 between trigger-advance and run-start loses nothing; a watch event during a
running session coalesces instead of double-running; inbox tests pass against the durable impl.
**Source:** eval architecture (verified); paperclip wakeup table; reef-docs 04/05.

### RF-24 · Soft loop termination + RemainingSteps {#rf-24}
- [ ] **P2 · S · loop**

Hitting `maxSteps` hard-breaks with no final assistant message — exactly wrong for proactive runs whose
outcome must be readable later (and for coding-session summaries). (1) At the ceiling, run one final
turn with no tools so the model must summarize state/blockers (`stop: "max_steps"` preserved). (2) Inject
remaining-budget into the loop ("N steps remaining") so the model can land gracefully instead of being
truncated.

**Done when:** a run that exhausts steps ends with a model-written summary; the unread view (RF-36) shows
it.
**Source:** anythingllm soft termination; langgraph RemainingSteps; hermes graceful-summary exit.

### RF-25 · Tool-loop guards {#rf-25}
- [ ] **P2 · M · loop**

Nothing detects a model stuck retrying a failing tool at 3am — it burns spend until `maxSteps`. Small
observer on tool events: same tool+args repeated N times → block that call; same tool failing M times →
halt run; alternating ping-pong pair → halt; plus a per-run total-call circuit breaker. Termination via
the existing AbortSignal seam; verdict recorded as a typed stop reason + actions row.

**Done when:** a test with a deterministically failing tool stops early with the typed reason instead of
running to the ceiling.
**Source:** hermes ToolCallGuardrails, openclaw loop detectors.

### RF-26 · Compaction hardening {#rf-26}
- [ ] **P2 · M · loop**

Builds on RF-09/RF-10: (1) catch typed context-overflow from the router mid-run → force compaction →
reissue (capped retries, letta's compact-and-reissue); (2) manual `/compact` TUI command; (3) pin the
original task verbatim in the summary preamble so long runs don't goal-drift post-compaction (khoj);
(4) authority framing on the summary ("background reference, not active instructions" + end-of-summary
trailer) — it crosses model boundaries under per-session `/model` switching (hermes).

**Done when:** an oversized single step recovers without failing the run; compacted sessions keep
answering the *current* message.
**Source:** letta, khoj, hermes, synthesis build-implications.

### RF-27 · BoundFs symlink containment {#rf-27}
- [ ] **P2 · M · security**

File-tool containment is lexical — symlinks inside the workspace can point out, and the tools follow
them. Resolve (`realpath`) before the boundary check; decide symlink-creation policy. Gains weight as
coding sessions run in arbitrary repos (nanoclaw's CVE class: trusted host consuming child-influenced
paths).

**Done when:** a symlink in the workspace targeting `~/.reef/secrets.json` is refused by read_file, with
a test.
**Source:** eval security (verified); nanoclaw AVOID.

### RF-28 · Webhook payload redaction + signing {#rf-28}
- [ ] **P2 · M · surfaces**

Approval notifications send command text verbatim to third-party relays (the configured webhook), and
nothing authenticates reef as the sender. Redact/truncate payloads (notification = "approval pending for
shell in session X", details fetched locally), and HMAC-sign outbound bodies (shared secret via
SecretStore) so receivers can verify origin. Prereq for RF-19.

**Done when:** webhook bodies contain no raw command text or secrets; signature verifies; tests cover
both.
**Source:** eval security (verified).

### RF-29 · Wire tests: socket protocol + HTTP interface {#rf-29}
- [ ] **P2 · M · testing**

`src/daemon/socket.ts` (NDJSON framing, partial chunks, all six control kinds, unsubscribe-on-close),
`src/interface/http.ts` (191 lines incl. auth gate + SSE), and `src/client/tui/connection.ts` are
imported by no test — every daemon test calls methods directly. This is the only path the real TUI uses;
a framing bug ships silently.

**Done when:** tests run a daemon on a temp socket/port and exercise framing (split JSON across chunks),
each request kind, auth-required-when-key-set, SSE event delivery, and disconnect cleanup.
**Source:** eval testing (high, verified).

### RF-30 · VercelRouter offline tests {#rf-30}
- [ ] **P2 · M · testing**

The entire model-API translation boundary (`toModelMessages`, stream draining, `toTurnStop`, `toUsage`,
tool mapping) has zero offline coverage — all tests fake at the `ModelRouter` interface above it; the
only real exercise is the key-gated live smoke. Use ai-sdk's mock language-model utilities to drive
`VercelRouter` through happy path, tool calls, stream errors (RF-10's fix), and abort.

**Done when:** a translation regression (e.g. tool_result ordering) fails offline.
**Source:** eval testing (high, verified).

### RF-31 · Loop failure + cancellation tests {#rf-31}
- [ ] **P2 · S · testing**

No test makes the router throw mid-run (asserting `run.failed` + status) and no test exercises
`Daemon.cancel`/AbortSignal (no AbortController appears anywhere in `tests/`). These are the paths that
run when things go wrong unattended.

**Done when:** tests cover router-throw → `run.failed` with cause (ties to RF-10), and cancel mid-step →
typed `cancelled` stop + no orphaned state.
**Source:** eval testing (high, verified).

### RF-32 · Inbox concurrency tests {#rf-32}
- [ ] **P3 · S · testing**

The serial inbox is the daemon's core ordering guarantee and is never exercised under contention
(concurrent submits, trigger + message interleaving, enqueue-during-drain). Cheap to write now; required
before RF-23 changes the implementation.

**Source:** eval testing (verified).

## P3 — ops, TUI, product

### RF-33 · launchd service + daemon state file {#rf-33}
- [ ] **P3 · M · ops**

"Always-on" currently means "until the terminal closes" — no plist, pid file, or auto-restart, though
reef-docs 02/09 explicitly intend launchd supervision. Ship: (1) a launchd plist + `reef service
install/start/stop/status` (per-OS switchboard later, macOS now — openhuman's shape); (2)
`~/.reef/daemon.json` (pid, socket path, http port, startedAt, build version) written atomically 0600 —
clients detect version drift and stale daemons (gstack's kill-and-respawn; ends "I rebuilt reef but the
old daemon is still running").

**Done when:** reboot → triggers fire without manual start; TUI warns on version drift.
**Source:** eval dx (high, verified); openhuman, gstack.

### RF-34 · Login-shell env hydration at startup {#rf-34}
- [ ] **P3 · S · ops**

Once launchd-spawned (RF-33), the daemon inherits a minimal PATH — the shell tool and the PTY spawn of
`claude` (nvm-installed) fail inscrutably. At startup, capture the login shell's env (`$SHELL -l -c
'node -p JSON.stringify(process.env)'`) and merge PATH-like vars. Interacts with RF-03: hydration feeds
the *daemon's* env; children still get the allowlist.

**Source:** rowboat ("the load-bearing line").

### RF-35 · TUI reconnect + config apply without double restart {#rf-35}
- [ ] **P3 · M · tui**

`Connection` connects once; on close it's dead (`src/client/tui/connection.ts:26-39`) — daemon restart
means TUI restart. And every config edit says "restart the daemon to apply" (3 surfaces), so the daily
loop is edit → kill daemon → relaunch daemon → relaunch TUI. Fix: reconnect-with-backoff (+ session
replay via existing `history`), and a `reload_config` control command (or SIGHUP) re-running the
fail-soft loadConfig/loadPolicy for hot-safe keys (providers, policy, surfaces).

**Done when:** restarting the daemon under an open TUI recovers within seconds; `provider add` is usable
without restarting the daemon.
**Source:** eval dx (high, verified).

### RF-36 · Unread-run tracking {#rf-36}
- [ ] **P3 · S · tui**

The whole point of an always-on agent is work done while you're away, and nothing answers "what ran since
I last looked." Add `readAt` (null = unread) on runs; sessions view shows an unread badge and a
`since-last-look` group; opening marks read. Pairs with RF-24 (every run ends with a readable summary).

**Source:** anythingllm readAt pattern.

### RF-37 · TUI views: actions audit + triggers {#rf-37}
- [ ] **P3 · M · tui**

The actions audit log (the recorded-authority payoff) and trigger state are invisible from the TUI/CLI —
inspecting either means curl or sqlite3. `/actions` (filterable by run/session, shows decision + reason +
outcome) and `/triggers` (list, next fire, last fire, enable/disable) views over existing daemon
methods/HTTP.

**Source:** eval dx (verified); reef-docs 01 observability goal.

### RF-38 · Head+tail tool-output truncation + spine pointer {#rf-38}
- [ ] **P3 · S · tools**

`src/tools/shell.ts` keeps the FIRST 100KB — head-only truncation hides the failure at the end of a long
build/test log from the model, and 100KB per result bloats context. Keep head + tail with a marker, store
the full output in the spine (or a file), and make the marker tell the model how to retrieve more.

**Source:** open-interpreter truncate_output; openhuman TokenJuice (the full rules-based compactor is a
follow-on if needed).

### RF-39 · Mid-run steering {#rf-39}
- [ ] **P3 · M · daemon**

Abort is the only mid-run action; a message for a busy session just queues behind the whole run. Add the
steer/queue/interrupt taxonomy: steer = inject as fresh user input at the next loop iteration; queue =
after the run; interrupt = today's cancel. Becomes acute with 20-minute coding sessions ("skip the
tests") — the spec's `send_feedback` is the coding-session variant of the same primitive.

**Source:** codex pending-input drain, hermes taxonomy, khoj interrupt queue.

### RF-40 · Wire the memory `primer()` seam (with synapse) {#rf-40}
- [ ] **P3 · M · memory**

`primer()` has zero callers — the loop never consults memory on the way in (docs 02/07 describe a path
that doesn't exist; the code honestly labels tools-only as "mechanism A"). Before building more: validate
the seam contract against the synapse backend (the seam exists *for* it), then wire primer at the
`getContext` call site with deterministic, cache-stable rendering (Letta block-style; honors docs 07's
cache constraint + RF-21's stable prefix). A consolidation/"dreaming" pass can then be ordinary scheduled
agent work (claude-code/khoj pattern) — co-design what reef owns vs synapse.

**Source:** eval architecture (low); letta memory blocks, claude-code/khoj consolidation; reef-docs 07.

### RF-41 · Docs honesty pass {#rf-41}
- [ ] **P3 · S · docs**

One sitting: (1) `reef-docs/10-open-questions.md` — ~half the entries are answered by code; move them
with dated notes per the doc's own protocol (the eval's architecture review has the full per-item list);
(2) `archive/README.md` still earmarks the headless adapters for resurrection — superseded by the PTY
spec (keep `types.ts`/`jsonl.ts` as reference; `archive/scripts/` + stray fixture deletable);
(3) README's "custom providers coming next" contradiction; (4) run-logger lines drop tool name/trigger
id, and routed proactive approvals still log as a deadlock warning — stale since slice B.

**Source:** eval architecture + dx (verified).

---

## Suggested sequence

1. **Now, small:** RF-01..05 (one sitting, two are one-liners) — plus RF-14/15 while `src/coding/` is hot.
2. **Before Step 3:** RF-06 (the blocker), RF-07, RF-08, RF-12.
3. **With Step 3:** RF-16, then RF-13 → RF-18 → RF-19 (the approval arc, also the proactive-approval end state).
4. **Anytime, independent:** RF-09/10/11, RF-21, RF-22, RF-24, RF-29..31, RF-33/34/35.
5. **Next structural milestone:** RF-23 (retires RF-11 properly, pre-builds multi-agent dispatch).
