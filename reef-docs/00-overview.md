# Reef — Design Overview

> **Status:** Early design. This document set grounds project planning. It is deliberately
> high-level and structural. It states *what* and *why*, mostly not *how*. Anything that
> reads as an implementation prescription should be treated as a placeholder for a later
> decision, not a commitment.

## What Reef is

Reef is a self-hosted, always-on personal agent system. It runs as a single daemon on
dedicated hardware (the reference target is a Mac Mini) and hosts multiple discrete agents
that own different types of work, with coordination and communication between them mediated
by the system rather than improvised by the agents.

It is **not** a control plane for orchestrating other people's agents (that is Paperclip's
altitude), and it is **not** a single monolithic assistant. It sits one layer down from the
former and one layer up from the latter: a personal, multi-agent substrate for one human.

## Origin and what informs this

Reef is the Phase 2 output of a structured investigation into ~16 open-source agent
codebases (the `agent-investigations` corpus). The design draws on primary-source reading of
those projects — Letta, Paperclip, Rowboat, Claude Code, Codex, Goose, Hermes, OpenClaw,
openhuman, and others — with specific patterns adopted, specific anti-patterns explicitly
avoided, and the reasoning recorded. Where this doc set makes a structural claim, it is
usually because the corpus showed the same pattern converging across multiple projects, or
showed the cost of its absence.

## Design priorities, in order

1. **Reliability & maintenance.** The system must run unattended and recover from crashes
   without losing state. This priority dominates; when a choice trades reliability for
   capability, reliability wins.
2. **Performance & speed.** Responsive on the reference hardware. Local-inference-friendly.
3. **Feature breadth & extensibility.** Capable, but only where capability doesn't
   undermine the first two priorities.
4. **Privacy / local-first.** Fully self-hostable; no required dependence on hosted
   services.

## Foundational stances

These are the load-bearing commitments. Everything in the rest of the doc set follows from
them. They are settled enough to plan against; the documents that elaborate them are not.

- **Single daemon, many agents, one loop.** One long-lived process. Multiple agents run
  inside it. There is exactly one agent-loop implementation, parameterized per agent — never
  a second loop for orchestration, sub-agents, or background work. (See `02`, `03`.)
- **Daemon-DB spine for operational state.** Runs, steps, events, the dispatch queue, agent
  records, leases, audit — all live in a queryable database. The database *is* the state;
  the loop advances it. (See `04`.)
- **Filesystem for artifacts.** Workspaces, user-editable memory, and inter-agent handoff
  artifacts live on disk. The DB holds typed pointers to them; neither substrate duplicates
  the other. (See `04`, `06`.)
- **Durable unit of progress.** Loop progress is committed to the DB per step, not held in
  memory. A crash mid-run leaves an inspectable record, not a guess. (See `03`.)
- **Deterministic dispatch, intelligent decomposition — kept separate.** *Who runs when* is
  deterministic code. *How work is decomposed across agents* may be an LLM agent — but it is
  an ordinary agent on the same substrate, not a privileged orchestrator. (See `05`.)
- **Everything authority-related goes through the broker.** Workspace access, inter-agent
  grants, access to external resources — all mediated by a single broker with deterministic
  policy and no bypass for any caller. Agents (including manager-agents) *request*; the
  broker *disposes*. (See `06`.)
- **Own the loop; vendor the rest.** Reef writes the orchestration shell, the agent loop,
  the broker, the memory seam. It depends on libraries for provider routing, MCP, storage
  primitives, scheduling, and observability. (See `09`.)

## What this doc set covers

| Doc | Title | Scope |
|-----|-------|-------|
| `00` | Overview | This document. |
| `01` | Goals & non-goals | What Reef is for, what it explicitly will not be, success criteria. |
| `02` | System shape | The daemon, the major subsystems, how they relate. |
| `03` | The agent loop | The one loop, the durable step, termination, the worker model. |
| `04` | State & persistence | The DB-DB/filesystem split, what lives where, the pointer-row discipline. |
| `05` | Multi-agent model | Agents as records, dispatch substrate, the manager-agent pattern, communication. |
| `06` | The broker | Leases, grants, policy, external-resource access, the no-bypass rule. |
| `07` | Memory | The two memory tiers, the pluggable seam, where a custom hybrid backend fits. |
| `08` | Tools & extensions | Tool model, MCP, skills, the trust posture. |
| `09` | Build approach | Own-vs-vendor, phasing, what gets built first, when to stop. |
| `10` | Open questions | Decisions deliberately deferred, with the considerations for each. |

## How to read this

`01`–`02` establish scope and shape. `03`–`06` are the structural core and should be read in
order. `07`–`08` are subsystem detail. `09` is the bridge to project planning. `10` is the
running list of what we have *not* decided — it is as important as the rest, because it
marks where planning should expect to do design work rather than execution.

## What this doc set deliberately avoids

No schemas. No file layouts. No API signatures. No technology choices beyond the few named
in `09` as foundational. No phase-by-phase task breakdowns. Those belong to project planning,
which this set is meant to *ground*, not pre-empt. Where a document gestures at a mechanism,
it is to make a structural point legible — not to commit to that mechanism.
