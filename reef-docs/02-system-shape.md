# 02 — System Shape

> **Status:** Early design. Describes the major subsystems and how they relate. Boundaries
> are firm; internals are not.

## The shape in one paragraph

Reef is a single long-lived daemon. Inside it: a **dispatch substrate** that decides what
runs when, a single **agent loop** that every agent run goes through, a **broker** that
mediates all authority grants, a **state layer** split between a queryable database and
filesystem artifacts, a **memory subsystem** behind a pluggable seam, a **tool layer**
including MCP, and an **interface surface** the user's existing chat/management UI talks to.
The database is the operational source of truth; the loop advances it; the broker guards it;
everything recovers from it.

## Why a single daemon

The corpus showed multi-process designs pay an operational tax — separate supervisors,
inter-process coordination, more failure modes — for isolation a single human on dedicated
hardware doesn't need. A single process with internal task supervision gets crash-isolation
between agents (one agent's failure doesn't take the daemon down) without the tax. The outer
process is supervised by the OS (launchd on the reference hardware); inside, the daemon
supervises its own agents.

## The subsystems

### Dispatch substrate

Decides *what runs when*. Every reason an agent might wake — a message from the user, a
scheduled trigger, an inbound event, another agent handing off work — funnels into one
queue. Claiming work off that queue is atomic. The substrate is deterministic code: it
routes, it does not reason. (Detailed in `05`.)

### The agent loop

The one place an agent run actually executes — model call, tool calls, repeat, until a
typed termination. There is exactly one implementation, parameterized per agent. Every
agent, including any manager-agent, runs through it. Loop progress is committed to the
database per step. (Detailed in `03`.)

### The broker

Mediates *all* authority. Workspace access, grants between agents, access to resources
outside any workspace — every one is a lease or grant the broker issued, recorded, and
enforces. Callers request; the broker applies deterministic policy and disposes. No caller
has a bypass. (Detailed in `06`.)

### State layer

Two substrates, one discipline. The **database** holds operational state — runs, steps,
events, the queue, agent records, leases and grants, audit. The **filesystem** holds
artifacts — workspaces, user-editable memory, handoff artifacts. The database carries typed
pointers to filesystem artifacts; neither substrate stores what the other is authoritative
for. (Detailed in `04`.)

### Memory subsystem

Two tiers. A **structured tier** in the database — queryable, agent-curated, versioned — and
a **file tier** on disk — user-editable, human-readable. Memory is reached through a defined
seam so an alternate backend (the user's custom hybrid layer) can take the structured tier's
place without touching Reef's core. (Detailed in `07`.)

### Tool layer

What agents can *do*. First-party tools authored in-repo, plus MCP for the external tool
ecosystem. Per-agent tool allowlists. No marketplace, no untrusted plugin discovery — the
trust posture is that tools are the user's own code. (Detailed in `08`.)

### Interface surface

How the outside reaches the daemon. The user's existing chat/management UI is the primary
client. The surface is local-bound by default. It is an interface *onto* the daemon, not a
UI Reef ships.

### Observability

Not a separate subsystem so much as a property the others are built to have. Because
operational state is in a queryable database and every authority decision is a recorded
broker action, "what is happening / what happened / what can happen" is answerable by
querying — not by scraping logs. Structured tracing is wired through the loop and the broker
from the start, because the corpus is consistent that retrofitting it is how the long tail
of silent failures stays invisible.

## How they relate — the path of one agent run

A wake reason enters the **dispatch substrate** and becomes queued work. The substrate
atomically claims it and starts a run. Before the run executes, the **broker** ensures the
agent has its workspace lease and whatever grants the run needs. The run goes through the
**agent loop**: each step calls the model, the model may call **tools**, the loop commits a
durable step record to the **state layer** before continuing. The loop consults the **memory
subsystem** on the way in and writes to it on the way out. Tool calls that touch the
filesystem resolve through broker-issued, path-bound handles. The run reaches a typed
termination; its final state is durable. Every interesting thing that happened is now a row
or an event another part of the system — or the user's UI — can query.

## What holds it together

Three properties, repeated across subsystems, are what make the whole coherent:

- **Durable-state-is-truth.** No subsystem keeps authoritative state only in memory. The
  loop's progress, the broker's grants, the queue's contents — all durable. Recovery is
  always "rebuild from the database," never "reconstruct from inference."
- **One mechanism per concern.** One loop. One dispatch queue. One broker. One pointer
  discipline between DB and disk. The corpus's clearest anti-patterns were all *the same
  concern handled two ways* — two loops that drifted, two extension registries on two
  substrates, one column meaning three things. Reef resists that by construction.
- **Propose / dispose.** Intelligence proposes; deterministic code disposes. A manager-agent
  proposes a decomposition; the dispatch substrate disposes. An agent requests a grant; the
  broker disposes. The pattern recurs because it is how Reef gets to have LLM flexibility
  and a hard governance boundary at the same time.

## What this document does not decide

The internal structure of any subsystem. The technology behind the database. The transport
of the interface surface. How tasks are represented on the queue. These are planning-time
and design-time decisions; this document only fixes the subsystems' existence, their
responsibilities, and their boundaries.
