# 03 — The Agent Loop

> **Status:** Early design. The loop's structural properties are settled; its internals
> (step representation, exact termination set) are planning-time decisions.

## The one-loop rule

There is exactly one agent-loop implementation. Every agent run goes through it — a
user-facing agent, a background agent, a manager-agent decomposing work, a sub-agent doing a
piece of it. They differ by *configuration* — system prompt, tool allowlist, memory binding,
workspace — not by *code path*.

This is the corpus's clearest convergence and its clearest cautionary tale. The projects
that kept one parameterized loop stayed coherent and observable. The project that grew a
second loop for a different execution path saw the two drift — and the drift silently
disabled a budget control on the most-trafficked path. The one-loop rule is not a
simplification to revisit under pressure; it is a hard invariant. When orchestration and
sub-agents arrive, they run the same loop. If something feels like it needs a second loop,
that is the signal to find what configuration knob is missing instead.

## What the loop does

One run is: assemble context, then repeat { call the model; if it asked for tools, run them
and feed results back } until a typed termination, then finalize. Tool calls within a single
model turn that are independent may run in parallel.

That is the whole shape. Everything else in this document is about three things: making each
iteration *durable*, making termination *typed*, and making the loop *the same one* for
every kind of agent.

## The durable step

**Loop progress is committed to the database per step, not held in memory.** Before the
model call, a step record exists in the database in a pending state. After the call and its
tools, that record is updated with what happened. The next iteration begins only once the
previous step is durable.

The corpus showed the full range here — in-memory counters at one end, full event-replay
from a durable log at the other. Reef takes the durable-step position because the first
priority is reliability: a crash mid-run must leave an *inspectable record*, not a guess.
With a durable step, recovery is a query — "which steps were pending when we died" — and the
answer is exact. The cost is one database write per step. For a reliability-first system
that cost is clearly worth paying, and it is the single most important upgrade over a naive
in-memory loop.

This also means the loop's state *is* database state. The loop does not hold authoritative
progress in process memory that a crash could lose. It advances durable records.

## Typed termination

A run does not just "finish." It terminates for a *named reason*, and the set of reasons is
a closed, typed set — not an open-coded scatter of `break` statements.

The corpus contrast was direct: projects with a typed termination enum could reason about,
observe, and handle each ending; the project with open-coded breaks could not. The framing
that makes this clean: **errors are inputs to the loop; stop-reasons are outputs of it.** An
error mid-step is something the loop handles and possibly continues from. A stop-reason is
how the loop declares it is done. Keeping those distinct — and making the stop-reasons a
closed set — is what makes the loop legible.

The exact membership of that set is a planning-time decision. It will certainly include at
least: the model finished and asked for nothing more; a ceiling was hit; the run was
cancelled from outside; the run is suspended awaiting an approval; the run hit a budget
limit. The point here is the *discipline* — closed, typed, named — not the specific list.

## Bounding a run

A run is bounded two ways, and both matter more in a multi-agent system than in a
single-agent one:

- **A per-run ceiling** on iterations or equivalent — a backstop against a run that will not
  converge. Whether this is a static cap or something adaptive is a planning-time decision;
  that *a* backstop exists is not.
- **A budget that spans the work, not just the run.** When a manager-agent decomposes work
  across sub-agents, the thing that needs a ceiling is the whole *graph* of runs for that
  piece of work — not each run in isolation. A per-run cap alone lets a delegation tree burn
  through cost in a shape no single cap would catch. The budget primitive must be threadable
  through a dispatch tree. (How the tree is represented is `05`'s concern; that the budget
  follows it is the loop's.)

## Suspension and resumption

Some terminations are not endings. A run that needs an approval, or is waiting on something
external, *suspends* — it terminates the loop with a "waiting" stop-reason, leaving its state
durable, and a later event resumes it. Because the step is already durable and the
termination is typed, suspension is not a special mechanism — it is a stop-reason plus the
ordinary recovery path. The loop does not block a process waiting; it returns, and the
durable record is what gets picked back up.

This matters for the broker (`06`): an agent that requests a grant requiring a decision does
not hang — it suspends, and resumes when the decision arrives.

## Cancellation and side-channel control

A run can be stopped from outside — by the user, by a budget hard-stop, by the daemon
shutting down. Because the loop checks for this between steps and the step is durable,
cancellation is clean: the loop notices, terminates with the cancellation stop-reason, and
the durable record is consistent. There is no need to kill a process mid-write.

Graceful daemon shutdown is the same mechanism applied broadly: stop claiming new work, let
in-flight steps reach their durable commit, suspend or finalize, exit. Recovery on the next
start picks up exactly where the durable records left off.

## The worker model

Each agent is single-task-at-a-time; the system as a whole is concurrent. One agent does not
run two of its own tasks simultaneously — that is how the corpus's cleaner projects sidestep
"two turns corrupted the same history." But many agents run at once. The dispatch substrate
(`05`) is globally concurrent; per-agent serialization sits in front of it. The loop itself
does not need to know this — it runs one run — but the loop's correctness *depends* on the
guarantee that two runs of the same agent are not racing the same durable state.

## What this document does not decide

How a step is represented in the database. The exact closed set of stop-reasons. Whether the
per-run ceiling is static or adaptive. How context is assembled for the model call (that
draws on `07`). Whether tool results stream. These are planning-time and design-time
choices. What is fixed here: one parameterized loop, a durable step, typed termination,
graph-spanning budget, suspension-as-stop-reason, and per-agent serialization.
