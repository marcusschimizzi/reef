# 04 — State & Persistence

> **Status:** Early design. The two-substrate split and the pointer discipline are settled.
> Schemas, formats, and the database technology are planning-time decisions.

## The split

Reef keeps state in two substrates, and which substrate a piece of state lives in is decided
by one question: **who is the consumer, and what operation do they need?**

- If the consumer is the system itself — the dispatch substrate running a query, the broker
  checking a grant, recovery reasoning over what was in flight — the state is **database**
  state. It is queried, it is mutated atomically, it is reasoned over across agents.
- If the consumer is a human opening a file, or an agent's tool reading a document, or
  another agent picking up a handoff — the state is a **filesystem** artifact. The file *is*
  the interface.

This is not "database vs files" as a taste preference. It is a per-data-type assignment, and
getting it wrong in either direction is a known failure mode the corpus demonstrated.

## What lives in the database

The operational spine. Runs and their durable steps. Events. The dispatch queue. Agent
records. Leases and grants. Audit. Token and cost accounting. Anything the system queries to
make a decision or to recover.

The defining properties: it is *queried*, it is *mutated atomically*, and it is *reasoned
over across agents*. "What is running," "what can this agent touch," "what did this cost,"
"what was in flight when we crashed" — all database questions, all answerable without
touching the filesystem.

## What lives on the filesystem

Three kinds of artifact, all on disk for the same underlying reason — the consumer is
something other than the system's own decision-making:

- **Workspaces.** Where an agent does work that produces files — documents, code, build
  output. An agent's deliverables are a directory, not rows.
- **User-editable memory.** The human-readable, human-editable tier of memory (`07`). Its
  defining property is that the user can open it, read it, and edit it with a text editor,
  and the edit is just a file write. A database cannot give that property without a whole
  editing UI built on top; the file *is* the UI.
- **Inter-agent handoff artifacts.** When one agent produces something another consumes, a
  file in a known, brokered location is a simple, inspectable contract.

## The pointer discipline

This is the rule that keeps the split from becoming a mess: **the database holds the pointer
and the metadata; the file holds the content; neither duplicates the other.**

When a filesystem artifact matters to the system, the database carries a typed pointer row —
where it is, what produced it, its state, enough metadata to reason about it without reading
it. The system queries the row. The consumer reads the file. They never disagree, because
they are not storing the same thing.

A corollary worth stating explicitly: a file's *existence* or *completion* can be an event
in the database; a file's *content* never is. "Agent A finished the artifact agent B needs"
is a database event referencing a pointer. The bytes stay on disk.

## The failure mode this avoids

The corpus's sharpest persistence anti-patterns were all one disease: **the same fact living
authoritatively in two places.** One project split an extension registry across a JSON file
*and* database tables — two install paths, two trust models, flagged in its own docs as
debt. Another had a single database column carrying three different meanings depending on
context. Same root cause: the substrate boundary went blurry.

The discipline against it: **every piece of state has exactly one authoritative home.**
Database for operational state, filesystem for artifacts, a typed pointer connecting them
when they need to connect — and that pointer is a *reference*, never a copy. When something
could plausibly live in either place, that is the signal to decide deliberately and write
the decision down, not to let it land in both.

## Recovery

Because operational state is durable and queryable, recovery is not a special subsystem — it
is a query the daemon runs at startup and repeats on a regular tick. "Which runs were in
flight," "which leases are active but their run is gone," "which steps were pending" — all
answerable, all reconcilable, from durable records. There is no separate watchdog process;
the recovery pass is part of the daemon's normal cadence. The corpus's most resilient
projects all shared this: treat restarts as routine, rebuild every invariant from durable
state, every tick.

Filesystem artifacts participate in recovery through their pointer rows. An orphaned
workspace is not found by scanning the disk — it is found by querying for leases whose
backing run is in a terminal state. The disk is never the thing recovery has to interpret;
the pointers are.

## Reset and deletion

What "delete an agent" or "reset a workspace" means is a planning-time decision, but one
principle is settled: destructive operations on operational state should be deliberate and
recorded, not silent and immediate. Whether that means soft-deletion, archival, or
tombstoning is open; that the system can answer "what was here and what happened to it" is
not.

## What this document does not decide

The database technology. Schemas for any table. The on-disk layout of workspaces or memory
files. The serialization format of handoff artifacts. Whether deletion is soft or hard.
Whether the per-run event log is its own table or folded into another structure. These are
planning-time and design-time decisions. What is fixed: the two-substrate split, the
consumer-and-operation test for which substrate, the pointer discipline, one authoritative
home per fact, and recovery-as-a-query.
