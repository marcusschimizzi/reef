# 10 — Open Questions

> **Status:** Early design. This is the running list of decisions deliberately *not* made.
> It is as load-bearing as the rest of the set: it marks where project planning should
> expect to do design work, not execution. Each entry states the question, why it is
> deferred, and the considerations in play — not an answer.

## How this list works

An entry is here because deciding it now would be premature — it depends on something not
yet built, or it is genuinely the user's call as another piece of their work firms up, or
the corpus left it as a real fork rather than a converged answer. When an entry is decided,
it should move into the relevant document and leave a dated note here.

---

## Loop & runs

**The closed set of stop-reasons.** `03` fixes that termination is typed and closed; the
membership is open. Considerations: it must cover normal completion, ceiling, cancellation,
suspension-for-approval, budget stop — but the full set will surface from building the loop,
not from enumerating up front.

**Static vs adaptive per-run ceiling.** A static iteration cap is simple and predictable; an
adaptive budget (token, cost, or time) is more flexible and more bookkeeping. The corpus had
both. Decidable once the loop exists and real runs show their shape.

**Whether tool results stream.** Streaming inside the loop adds real complexity (partial
tool calls, mid-stream error handling). The interface surface may not need it. Deferred
until the interface surface's needs are concrete.

## State & persistence

**The database technology.** `04` fixes that the spine is a queryable database; which one is
open. Considerations: single-process embedding vs a real server, the local-inference
hardware target, operational simplicity for a one-person system.

**Deletion semantics.** Soft-delete, archive, or tombstone — `04` only fixes that
destructive operations are deliberate and recorded. The choice interacts with the audit
story and with how "reset an agent" should feel.

**The per-run event log's shape.** Whether it is its own structure or folded into the
step/run records. Rowboat's event-replay model is a pattern worth drawing on within the
daemon-DB spine; how much of it to adopt is open.

## Multi-agent

**Task representation on the dispatch queue.** What a queued unit of work actually is, how
priority works, how a scheduled trigger differs structurally from an event trigger. Planning-
time; depends on building the substrate.

**Delegation-graph representation and depth bounds.** `05` fixes that the graph is tracked
and that budget and bounds follow it. How the graph is represented, and how deep delegation
may go, is open — likely surfaces from building the manager-agent pattern.

**One manager-agent or many; manager-agent tool surface.** Whether a given setup uses the
manager pattern at all is configuration. Whether the system should support multiple
manager-agents, and the exact tool surface a manager gets, is open.

## The broker

**The final set of lease shapes.** `06` anticipates agent-home / ephemeral / shared /
external. Whether that set is complete, or whether building reveals a fifth shape or
collapses two, is open.

**How broker policy is expressed.** Deterministic and inspectable is settled (`06`); the
form — a rules file, a typed config, something else — is open.

**How broker policy is changed and versioned.** Flagged in `06` as probably needing to be
recorded and versioned, since it is the most security-sensitive configuration in the system.
Not yet decided. Interacts with the audit story.

**How external resources are addressed and bounded.** An external lease governs access to
something Reef does not own — a repo, a directory. How those are named, and how the bound is
expressed (a path prefix, a mode, an expiry), is open.

## Memory

**How much of the structured tier Reef builds.** `07` commits to a competent default, not an
elaborate one — but "competent" needs a line. This is partly the user's call as the hybrid
backend's shape firms up: the less the custom backend leaves to Reef, the thinner Reef's
default can be.

**The memory seam's exact contract.** `07` sketches recall / record / lifecycle / optional
explicit tools. The precise method set and types are open — and properly co-designed with
the user's backend, since that backend is a first-class implementation of the seam.

**Per-agent vs shared memory.** `07` and `05` both flag that in a multi-agent system some
memory may belong above the individual agent. Whether the structured tier is purely
per-agent, also shared, or both — open. Affects where the hybrid backend plugs in.

**Whether agents curate their own memory, and how.** `07` fixes that *if* they do, curation
runs as ordinary scheduled agent work, not a separate loop. Whether Reef's agents curate at
all, how aggressively, and whether there is a consolidation/"dreaming" pass — open.

## Tools & extensions

**The tool interface.** Signature shape, how the model-facing schema is derived. Planning-
time.

**The skill format and relevance mechanism.** `08` fixes skills as authored content distinct
from tools; the format, and how the system decides a skill is relevant (automatic injection
vs explicit selection), is open.

**Whether Reef is also an MCP server.** `08` commits to Reef as an MCP client. Whether it
also exposes itself as an MCP server — relevant if anything outside Reef should reach its
agents as tools — is open and depends on whether that need is real.

## Workspaces

**Brokered vs direct workspace writes — confirmed brokered; the open part is persistent-
workspace lifecycle.** When an agent returns to its home lease across runs, that workspace
is durable mutable state. Open: whether it is versioned (the corpus's git-worktree answer
makes this nearly free), how it migrates if the agent's definition changes, how it is
reclaimed. `06` fixes the lease model; the persistent-home lifecycle within it is open.

## Cross-cutting

**The eval / replay story.** Flagged early in the investigation as the field-wide gap — no
corpus project ships an eval harness as a first-class primitive. Reef's daemon-DB spine plus
brokered workspaces make a session-replay harness *possible* (durable inputs, snapshot-able
workspace state). Whether Reef builds one, and what "the agent got better" even means for a
personal agent whose work has no ground-truth pass/fail — open, and worth a deliberate
decision rather than letting it default to nothing.

**Observability depth.** `02` fixes that tracing is wired from the start. How much — the
corpus had everything from structured logs to full APM stacks — is open, and for a local-
first one-person system the lighter end is probably right, but it is not decided.

**Interface surface transport.** `02` fixes that the surface is local-bound and is an
interface onto the daemon, not a UI Reef ships. The transport — and whether it offers an
OpenAI-compatible dialect so existing tooling can reach Reef's agents — is open.

**The schedule/trigger model.** Scheduled wakes and event-driven wakes both funnel into the
one dispatch queue (`05`), but the model for *defining* a schedule or *registering* a
trigger source is open.
