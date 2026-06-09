# 05 — Multi-Agent Model

> **Status:** Early design. The dispatch/decomposition split and the agent-as-record model
> are settled. Task representation, the manager-agent's exact tool surface, and graph
> representation are planning-time decisions.

## Agents are records

An agent is a durable record, not a process or a script. Its purpose, configuration, system
prompt, tool allowlist, memory binding, and workspace policy are data. Creating an agent is
writing a record; changing one is editing it. The agent loop (`03`) runs *against* these
records — it is the verb; the agent record is the noun.

This is why "add a discrete agent" is a configuration act. There is no per-agent code. The
single parameterized loop plus a new record is a new agent.

## Two things "orchestration" actually means

The word bundles two separable concerns, and the corpus's consistent lesson is to keep them
separate:

- **Dispatch** — *who runs when.* This is deterministic code. Every wake reason funnels into
  one queue; claiming work off it is atomic; recovery is a query over it. The dispatch
  substrate routes; it does not reason. No project in the corpus put an LLM in the dispatch
  path, and Reef does not either.
- **Decomposition** — *how a piece of work becomes sub-tasks for different agents.* This is
  the part that may want judgment, and judgment may mean an LLM. But the answer is not "make
  the orchestrator an LLM" — it is "decomposition is done by an *agent*, on the same
  substrate as every other agent."

Keeping these apart is the **propose/dispose** pattern: intelligence proposes, deterministic
code disposes. It recurs deliberately — here for work decomposition, in `06` for authority
grants — because it is how Reef gets LLM flexibility *and* a hard, legible boundary.

## The dispatch substrate

One queue. Every reason an agent wakes — user message, scheduled trigger, inbound event, a
handoff from another agent — becomes an entry on it. Claiming an entry is atomic, so two
workers never take the same work. Per-agent serialization sits in front: an agent claims its
next work only when it has no run in flight.

The substrate is small on purpose. It routes and it recovers; it holds no intelligence. Its
correctness properties — atomic claim, per-agent serialization, every wake is one queue
entry, recovery is a query — are what the rest of the multi-agent model rests on.

How a task is represented on the queue, how priority works, how a scheduled trigger differs
from an event trigger — planning-time decisions. That there is *one* queue and claiming is
*atomic* — settled.

## The manager-agent pattern

When work needs intelligent decomposition, a **manager-agent** does it. A manager-agent is
an ordinary agent — same loop, same substrate, same durability, same governance. What makes
it a manager is its *tools*: it can request that work be dispatched to other agents, and it
can observe the state of runs it spawned.

It is explicitly **not** a privileged orchestrator. It does not mutate the queue directly,
it does not have a special API, it cannot reach past the broker. It *requests* — and those
requests are ordinary tool calls that can be denied. The deterministic substrate disposes.

This is the resolution to "is the orchestrator deterministic or an LLM": both, at different
layers. Deterministic dispatch substrate; an ordinary agent on top that happens to
decompose. They are kept as separate layers, and the manager-agent's authority is bounded by
what the substrate and broker permit it — not by its own good behavior. A confused or
compromised manager-agent can only ever *request*; its blast radius is exactly its permitted
request surface.

## Communication is through shared artifacts, not messages

Agents do not send each other messages directly. The corpus is consistent that direct
agent-to-agent messaging is the pattern that spirals — A→B→A loops, hard to debug, hard to
recover. Instead, agents coordinate through **durable shared artifacts**: a shared workspace,
a handoff artifact, an entry on a work queue. The shared artifact *is* the communication
channel.

This makes coordination inspectable (you can look at the shared state), crash-recoverable
(the state is durable), and loop-resistant (a shared work surface does not invite the
ping-pong that direct messaging does). It also means orchestration and communication ride
the *same substrate* — the database and the brokered filesystem — rather than being two
systems.

The mechanics of shared workspaces and the grants into them are `06`'s subject. The point
here: when agent A hands work to agent B, that is A's run completing and emitting a handoff
artifact plus a queue entry — a thing the system did and recorded — not a message A sent that
B happened to receive.

## The delegation graph

When a manager-agent decomposes work, the resulting runs form a graph — the manager's run,
the sub-agent runs it spawned, anything they spawned in turn. Two things must follow that
graph:

- **Budget.** The cost ceiling is on the whole graph for one piece of work, not per-run
  (`03`). A delegation tree must not be able to burn cost in a shape no single run's cap
  would catch.
- **A bound on depth or cycles.** Propose/dispose helps — a manager cannot directly spawn,
  it requests — but the substrate still needs a limit so a manager-agent that keeps
  requesting decomposition cannot recurse without end.

How the graph is represented, how budget is threaded through it, how depth is bounded — all
planning-time decisions. That the graph is a real thing the system tracks, and that budget
and bounds follow it — settled.

## Capability containment between agents

The moment there is more than one agent, "what can each one touch" is a security boundary,
not housekeeping. When agent A dispatches to agent B, B's authority is a deliberate subset —
B does not inherit A's ambient access. This is enforced by the broker (`06`): B's grants are
B's, issued and recorded, not inherited. The corpus's sharpest multi-agent CVE was exactly
an agent inheriting authority it was never meant to have. Reef closes that by construction —
authority is granted, never ambient.

## What this document does not decide

How tasks are represented on the queue. Priority and scheduling policy. The manager-agent's
exact tool surface. How the delegation graph is represented or how deep it may go. Whether
there is one manager-agent or many, or whether any given setup uses the manager pattern at
all. These are planning-time and configuration-time decisions. What is fixed: agents are
records, dispatch is deterministic and decomposition is an agent, one atomic queue,
communication through shared artifacts, budget and bounds follow the graph, and authority
between agents is granted not inherited.
