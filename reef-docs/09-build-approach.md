# 09 — Build Approach

> **Status:** Early design. The own-vs-vendor line and the foundational technology
> commitments are settled. Phasing is directional, not a project plan.

## Own the shell; vendor the rest

Reef writes the parts that are *its* point of view, and depends on libraries for the parts
that are someone else's job. The line:

**Reef owns:** the agent loop, the dispatch substrate, the broker, the state layer's
discipline (the DB/filesystem split and the pointer rows), the memory seam, the agent-record
model, the interface surface. These are the orchestration shell — small, opinionated, and
the reason Reef exists.

**Reef vendors:** model-provider routing (so Reef does not maintain a normalizer across
providers), MCP protocol handling, the database engine and its access layer, scheduling
primitives, observability/tracing infrastructure, and the local-inference path. These are
the boring, large, fast-moving 80% — the corpus showed that owning them is how a personal
project drowns.

The discipline that keeps the line honest: if Reef finds itself writing a provider-specific
response normalizer, or re-implementing a protocol, or maintaining quirks for more than a
couple of providers — that is the signal it has crossed from shell into infrastructure, and
the line has slipped. The shell is small on purpose.

## Foundational technology commitments

Only the few that are genuinely foundational — everything else is planning-time:

- **A single daemon process**, OS-supervised (launchd on the reference Mac Mini hardware).
- **A real queryable database** for the operational spine. Which one is planning-time; that
  the spine is a database and not files is settled (`04`).
- **The filesystem** for artifacts, under broker-issued leases (`06`).
- **A vendored provider-routing layer** rather than Reef's own multi-provider abstraction.
- **MCP** as the external-tool bridge (`08`).
- **Structured tracing wired from the start**, not retrofitted.

The implementation language, the specific database, the specific libraries — planning-time.
The corpus had strong examples in several languages; none of those choices is forced by the
design.

## Phasing — directional only

This is not a project plan. It is the *order the structural pieces depend on each other*, so
planning has a spine to start from.

**The unretrofittable core comes first.** The corpus's clearest lesson about sequencing:
some choices cannot be added later without rebuilding. The daemon-DB spine, the durable
step, the single loop, and the dispatch substrate are in this category — they are the
shape, and the shape has to be present before there is anything to hang on it. The broker is
nearly as foundational: authority-by-construction cannot be retrofitted onto a system that
started with ambient access.

**A single agent on the real spine, before multiple agents.** One agent, running the one
loop, on the real durable spine, reachable from the user's interface — this proves the core
is right before multi-agent complexity is added. It is not a throwaway prototype; it is the
core, exercised by one agent.

**The memory seam early, even if the backend is later.** The seam (`07`) should exist before
much is built on top of it, because it shapes how the loop assembles context. The user's
hybrid backend behind it can come whenever it is ready — that is the point of a seam — but
the seam itself is structural.

**Multiple agents and the broker's multi-agent shapes, then.** Once one agent is solid on
the spine, a second agent, shared leases, grants between agents, and the manager-agent
pattern are the next layer. They rest on the spine being correct.

**Orchestration intelligence last.** The manager-agent pattern is valuable but it is the
*least* unretrofittable thing — it is an agent on a substrate, and the substrate is what has
to be right first. Decomposition intelligence is built when there is a correct multi-agent
substrate for it to be intelligent *about*.

What is deliberately not here: task counts, time estimates, a feature-by-feature breakdown.
Those are project-planning outputs. This section only fixes dependency order.

## When to stop — the discipline against over-building

The corpus is full of systems that grew past what their shape needed. Reef's defenses
against that, stated as commitments:

- **The non-goals (`01`) are load-bearing.** Multi-tenancy, marketplace, hosted operation,
  framework-generality — each is a category of structure Reef does not build. When a feature
  starts to want one of those, that is a signal to stop, not to expand scope.
- **One mechanism per concern.** When something seems to need a second loop, a second
  queue, a second registry — the corpus says find the missing parameter on the first one
  instead. A second mechanism is almost always drift.
- **Competent beats elaborate.** A competent memory tier, a small tool set, a
  bounded-but-correct multi-agent model. The priorities (`00`) put reliability and
  maintainability first; an elaborate subsystem that one person cannot hold violates the
  priorities even if each piece is individually nice.
- **The scope is the north star, not a general audience.** Reef is built for one concrete
  use case — several discrete agents, one human, coordinating. Anticipating use cases the
  user does not have is how the shell stops being small.

## What this document does not decide

The implementation language. The specific database, provider-routing library, MCP library,
or tracing stack. The actual project plan — phases, tasks, estimates, milestones. What is
fixed: the own-vs-vendor line, the handful of foundational technology commitments, the
dependency order of the structural pieces, and the explicit commitments against
over-building.
