# 06 — The Broker

> **Status:** Early design. The broker's role, the no-bypass rule, and the propose/dispose
> split are settled. Lease shapes, policy expression, and the grant schema are planning-time
> decisions.

## What the broker is

The broker is the single component through which all filesystem authority is granted,
recorded, and enforced. An agent never picks where it can read or write. It *requests*
access; the broker applies deterministic policy and either issues a recorded grant or denies
with a reason. Workspace access, access between agents, access to resources outside any
workspace — all of it, one mechanism.

The broker is to *authority* what the dispatch substrate is to *scheduling*: the
deterministic chokepoint. And like the dispatch substrate, it holds no intelligence — it
checks what is permitted, it does not reason about what is wise.

## The no-bypass rule

**No caller has a bypass.** Not the manager-agent, not a worker agent, not the deterministic
orchestrator itself. The orchestrator requests leases the same way an agent does; the only
difference between callers is what policy says each may *get*, never whether they must ask.

This is the rule the whole governance story rests on. The moment one privileged path skips
the broker "because it is trusted," the completeness of the audit trail is gone and the
containment guarantee is gone with it. Every grant that exists, exists because a request was
made and the broker recorded its decision. That completeness is what makes "what can touch
this resource" a *trustworthy* answer and not just a usually-correct one.

## Leases and grants

The unifying object is not "a workspace" — it is a **scoped grant of authority**. The
broker's records answer: who may touch what, in what mode, for how long, on whose authority.

A **lease** is a resource the broker is governing access to. A **grant** is a specific
agent's specific access to a lease — its mode, its path scope. A simple persistent workspace
has one implicit grant; a shared workspace has many explicit ones. Modeling grants as
first-class and separate from leases, from the start, is what lets every lease shape fit
without a later migration.

The lease shapes Reef anticipates — *anticipates*, not commits to a final list:

- **Agent home** — persistent, scoped to an agent, no expiry. The **default** for a
  persistent agent. Where its memory artifacts, notes, and accumulated work live. Created
  when the agent is defined; reclaimed only when the agent is removed.
- **Ephemeral** — scoped to a single run, expires at run end. For one-off agents or special
  short-lived tasks. The exception, not the default.
- **Shared** — scoped to a *set* of agents, with its own lifecycle independent of any one
  run. The substrate for agent-to-agent collaboration. Each agent's access into it is its
  own grant — a shared workspace where everyone can write everything is the multi-agent
  version of a race condition, so grants within a shared lease carry per-agent mode and path
  scope.
- **External** — scoped to a resource the system does *not* own: a git repository, a
  directory on the user's machine, a mounted volume. The lease is not "space we provisioned"
  but "brokered access to something that exists independently," in a defined mode, with
  defined bounds.

All four go through the same broker, get the same recorded-grant treatment, and are swept by
the same recovery pass. The uniformity is the point: one mechanism, four shapes.

## Why this is attractive — governance, observability, security

The same three properties recur, and the external lease shows them most clearly:

- **Governance.** Access to a resource is a decision with a record. The broker decided agent
  X gets read on this repo for this run, under this policy. Revoking is a state transition,
  not a hunt through which agent holds which path.
- **Observability.** "What can touch this resource right now" is a query over active grants —
  not a filesystem scan and an inference.
- **Security.** Containment extends past Reef's own workspaces to the things it does not own,
  which is where the real blast radius is. Brokered access means an agent's file tools are
  *constructed bound* to the granted path in the granted mode. Read-only means the tool
  physically cannot write. This is enforcement by construction — not a guard that can be
  commented out, the way the corpus showed guards rot.

## Enforcement is in the handle, not in a check

When a run starts, its file-touching tools are built around the broker-issued grant. The
agent does not receive a base path it is trusted to respect — it receives tools that resolve
every path under the grant and cannot express anything outside it. Path containment is a
property of how the tool was constructed, not a rule the model has to follow and a reviewer
has to remember to enforce.

This is the difference the corpus made vivid: a containment *check* is a thing that can be
disabled, forgotten, or shipped commented-out. A bound *handle* has nothing to disable.

## Propose / dispose, applied to authority

A manager-agent can *request* a shared lease and request grants for the agents it
coordinates. It cannot create them. The request is a typed message — itself a recordable
object. The broker receives it, evaluates it against deterministic policy (may this manager
mint shared leases at all? are these agents within its authority to grant? is the requested
mode within its tier?), and either provisions and records, or denies with a reason. Request,
decision, and resulting grants are all in the log.

So the manager-agent's tool is not `create_shared_workspace` — it is `request_lease`, and it
can come back a grant or a denial. The manager-agent is an agent; its tool calls are
requests that can fail. It does not get a privileged API; it gets a tool that talks to the
broker, and the broker is unmoved by who is calling.

This is what bounds a compromised manager-agent. It is still an LLM — it can be
prompt-injected, it can be confused. If it could mint grants directly, a compromised manager
is a compromised system. Through the broker, it can only request, and its blast radius is
exactly what policy permits it to request. The trust boundary moves from "the manager-agent
behaves well" to "the broker's policy is correct" — and a deterministic policy you can read
and test is a far better thing to have to trust than an LLM's judgment.

## Policy is deterministic and inspectable

The broker is not reasoning about whether a request is *reasonable* — that is the
requester's job, and it is fine for that to be LLM judgment. The broker checks whether a
request is *permitted*, and that must be deterministic rules: which caller tiers may mint
which lease kinds; that no caller may be granted write into another agent's home; that
external grants above read-only require an explicit policy entry; that expiry is capped
regardless of what is requested. Intelligent proposal, rigid disposal — and the rigidity is
the guarantee.

Broker policy is itself a piece of state with a lifecycle. Who may change it, and whether
that change is recorded and versioned, is a real question — and because it is the most
security-sensitive configuration in the system, the answer is probably yes to both. That is
flagged in `10`, not settled here. The *now* commitment is only that policy is
deterministic, inspectable, and lives somewhere definite — not scattered through broker code.

## The broker in the daemon-DB picture

The broker's decisions are database writes. It recovers from database state. A crash
mid-decision leaves an inspectable request record, not a half-issued grant. The broker is on
the critical path — if it is down, no work needing a workspace can start — and that is the
correct failure mode: an authority component should fail closed. It earns the same
durability discipline as the rest of the daemon-DB spine (`04`).

Because the broker is the only thing that mutates lease and grant state, the lease and grant
records plus the request log are a *complete* account. There is no "and sometimes things
were created another way" caveat. That completeness is what makes the observability and
containment claims real rather than aspirational.

## What this document does not decide

The final set of lease shapes. How policy is expressed. The lease and grant schema. How a
bound file handle is implemented. How external resources are addressed. How broker policy is
changed and versioned. These are planning-time and design-time decisions. What is fixed: one
broker, no bypass for anyone, lease-and-grant as the model, enforcement in the handle not in
a check, propose/dispose for authority, deterministic inspectable policy, and the broker as a
durable component of the daemon-DB spine.
