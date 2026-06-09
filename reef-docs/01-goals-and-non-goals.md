# 01 — Goals & Non-Goals

> **Status:** Early design. Scope-setting document. Goals are directional, not contractual.

## The problem Reef solves

One person wants several discrete, always-on agents that own different kinds of work — and
wants them to coordinate without the coordination being improvised, opaque, or unsafe. The
existing options force a bad trade: the lightweight personal-assistant projects don't have a
real multi-agent or governance story, and the projects that *do* have one are control planes
built for orchestrating many agents at organizational scale, carrying multi-tenancy,
company-scoped governance, and attack surface that a single human running their own hardware
doesn't need and shouldn't pay for.

Reef is the missing middle: a personal-scale, multi-agent substrate that takes the
*reliability and governance primitives* proven out by the larger systems and leaves their
*organizational framing* behind.

## Goals

**Run unattended and recover cleanly.** The daemon stays up on dedicated hardware. Crashes
are routine events the system is designed for, not exceptional ones — recovery rebuilds
state from durable records, never from guesswork. This is the first priority and it
constrains everything else.

**Host multiple discrete agents that own different work.** Agents are first-class,
long-lived, and individuated — each with its own purpose, configuration, memory, and
workspace. Adding or changing an agent is a configuration act, not a code change.

**Mediate coordination and communication between agents.** When agents hand work to each
other or share results, the system brokers it. Coordination is visible, recorded, and
governable — not a filesystem convention two agents happen to share.

**Make authority explicit and bounded.** What an agent can touch — its own workspace,
another agent's, an external repo — is a grant the system issued and recorded, enforced by
construction rather than by guard code. A compromised or confused agent is bounded by what
the broker permitted it, not by its own good behavior.

**Be observable.** "What is each agent doing, what has it done, what can it touch, what did
it cost" is answerable by querying the system, without inspecting the filesystem or reading
logs by hand.

**Stay self-hostable and local-first.** No required dependence on any hosted service. Local
inference is a first-class path, not an afterthought. The user owns their data and can read
the parts of it that are meant to be human-readable.

**Support a custom memory layer.** The user is independently building a hybrid memory
backend. Reef must expose a clean seam for it — memory is a pluggable subsystem behind a
defined interface, not a hardcoded engine.

**Be maintainable by one person.** The system is small enough that one person can hold it in
their head, own its orchestration logic, and depend on libraries for the parts that are
someone else's job to maintain.

## Non-goals

**Not a control plane for third-party agents.** Reef hosts the user's own agents. It is not
a BYO-runtime orchestrator wrapping heterogeneous external agent CLIs. The corpus shows that
choice (delegating the inner loop to external adapters) is correct for a control plane and
wrong for what Reef is.

**Not multi-tenant.** One human. No companies, no per-tenant scoping, no cross-tenant
isolation. This is not a feature cut to revisit later — it is a deliberate elimination of an
entire category of structure and attack surface. The corpus is unambiguous that most of the
serious CVEs in the control-plane projects landed exactly on multi-tenancy seams Reef won't
have.

**Not a hosted product.** No SaaS edition, no managed offering, no public-facing multi-user
deployment. Reef runs on hardware its single user controls.

**Not a marketplace ecosystem.** No public skill or plugin marketplace, no plugin discovery
of untrusted third-party code. Tools and agents are authored by the user, in the user's
repo. The corpus shows the marketplace pattern is the single highest-risk piece of the
personal-agent projects that adopted it.

**Not a chat UI or a framework.** Reef is the daemon and its substrate. The user already has
a chat/management surface; Reef exposes an interface for it to talk to. Reef is also not a
library for other people to build agents on — it is a system, with a point of view.

**Not aiming for feature parity with anything.** Reef is not chasing OpenClaw's channel
breadth or Hermes' learning loop or Letta's memory richness as targets. It adopts specific
primitives from each where they serve the priorities, and ignores the rest.

## Success criteria

Reef is succeeding if:

- It runs for long stretches unattended, and when it does crash or restart, it comes back
  with no lost or corrupted state and no manual reconciliation.
- The user can stand up a new discrete agent by writing configuration, and it participates
  in the system — dispatch, coordination, governance, observability — with no special-casing.
- Two agents can collaborate on shared work, and afterward the user can reconstruct exactly
  how: who was granted what, who did what, in what order, from the system's own records.
- The user's custom memory backend plugs in behind the memory seam without touching Reef's
  core.
- The user can answer "what can this agent touch and why" from the system's records, and the
  answer is complete — there is no access path the system didn't broker and record.
- One person can maintain it — extend it, debug it, reason about its failure modes — without
  it having outgrown what one person can hold.

## What success explicitly does not require

- Many agents. Reef should be *correct* with two agents and *not collapse* with a dozen.
  Scale beyond that is not a goal.
- Sophistication in any one subsystem beyond what the priorities call for. A competent memory
  tier beats an elaborate one. A small tool set beats a large one.
- Anticipating use cases the user doesn't have. The north star is concrete; Reef is built
  for it, not for a hypothetical general audience.
