# 07 — Memory

> **Status:** Early design. The two-tier split and the pluggable seam are settled. The
> structured tier's internals, the file tier's format, and the seam's exact contract are
> planning-time decisions — and the structured tier is the part most likely to be supplied
> by the user's own backend rather than built.

## Two tiers, two substrates, two consumers

Memory in Reef is not one system. It is two tiers, split by the same consumer-and-operation
test that governs all state (`04`):

- **Structured tier** — in the database. Queryable, agent-curated, versioned. This is the
  memory a manager-agent or a worker searches across, the memory the system reasons over.
  Its consumer is the system.
- **File tier** — on disk. User-editable, human-readable. Tacit knowledge, notes, the things
  the user wants to open in an editor and correct by hand. Its consumer is the human (and,
  by reading, the agent).

They are not competing designs. The corpus showed both — richly-versioned database memory at
one pole, plain editable files at the other — and the resolution is that they serve
different consumers and Reef wants both. An agent's home lease (`06`) is where its file-tier
memory lives; the structured tier lives in the daemon-DB spine.

## The structured tier

What the corpus's strongest version of this looked like: memory as a *version-controlled
record*, not as current-state-only. Edits checkpoint; a bad edit can be walked back; the
edit history is itself inspectable. That is the reference shape — memory you can rewind,
because an agent curating its own memory will sometimes curate it wrongly, and because "why
does this memory look like this" should be answerable.

But the structured tier is also **the part of Reef most likely not to be built by Reef.**
The user is independently building a hybrid memory backend. The design intent is that that
backend *is* the structured tier — plugged in behind the seam below — rather than Reef
shipping an elaborate memory engine the user then has to displace. Reef may ship a
*competent* default structured tier so the system is whole without the custom backend; it
should not ship an elaborate one.

## The file tier

Plain files in the agent's home lease. Human-readable, human-editable, and versioned at the
file level so a hand-edit or an agent-edit can be walked back — the corpus's reference here
is per-file history, the kind of thing a version-control tool gives you over a directory of
notes.

The file tier's defining property is the one a database cannot give: the user opens it, the
user edits it, the edit is a file write, no UI required. The file *is* the interface. That
is why it is a tier and not just a cache.

## The pluggable seam

Memory is reached through a defined interface — not a hardcoded engine wired through the
loop. The interface is small on purpose. Conceptually it is: *recall* (given the current
situation, return relevant context to bring into the model call) and *record* (given what
just happened, persist it). Plus lifecycle. Plus, optionally, explicit memory tools an agent
can call deliberately rather than relying only on automatic recall.

The seam's reasons:

- **The user's hybrid backend plugs in here.** Implementing the interface is how the custom
  structured tier becomes Reef's structured tier — without touching Reef's core.
- **It keeps memory from tangling into the loop.** The loop consults the seam on the way in
  and writes to it on the way out. It does not know what is behind the seam.
- **It allows the two tiers to be composed behind one interface.** The loop sees "memory";
  whether that is the structured tier, the file tier, or both composed is behind the seam.

The corpus's lesson on pluggability was specifically that the seam earns its keep when a
*second* implementation exists behind it — pluggability designed before a second
implementation tends to be wrong. Reef has the second implementation by construction: a
default plus the user's backend. The seam is justified from day one.

## Where recall happens, and the cache cost

The loop consults memory when assembling context for a model call. One constraint is settled
because the corpus was consistent on it: dynamic recalled content should not be injected in a
way that breaks the model provider's prompt caching. The stable parts of a prompt are worth
keeping stable; recalled content, which changes per call, goes where it does not invalidate
the cached prefix. The exact mechanics are planning-time, but the constraint — *recall must
not silently destroy prompt-cache economics* — is a real one to design within.

## Curation and the learning loop

If Reef's agents curate their own memory — promote things from conversation into the
structured tier, consolidate, refine — that curation is *work*, and work runs through the
ordinary machinery: it is an agent run, on the one loop, on the dispatch substrate, not a
hidden background mechanism with its own code path. The corpus's caution here was direct:
the projects that gave background consolidation its own separate loop saw it drift from the
foreground loop. Whatever consolidation Reef does, it does as ordinary scheduled agent work.

Whether Reef's agents curate memory at all, how aggressively, and whether there is a
"dreaming"-style consolidation pass — these are open (`10`). The structural commitment is
only that if it happens, it happens on the shared substrate, not beside it.

## In the multi-agent picture

The structured tier is queryable, which is what lets a manager-agent reason over what is
known. Whether memory is purely per-agent, or whether some memory lives at a shared or
orchestrator altitude, is genuinely open — the corpus suggested that in multi-agent settings
some consolidation belongs above the individual agent. That has consequences for where the
user's hybrid backend plugs in: it might be per-agent, it might be shared, it might be both.
Flagged in `10`.

## What this document does not decide

The structured tier's schema or query model. Whether Reef's default structured tier is
minimal or merely competent. The file tier's on-disk format. The exact contract of the
seam — its method set, its types. Whether memory is per-agent or also shared. Whether agents
curate memory and how. These are planning-time decisions, and several of them are properly
the user's to make as the hybrid backend's shape firms up. What is fixed: two tiers split by
consumer, a small pluggable seam with the custom backend as a first-class implementation
behind it, recall that respects prompt-cache economics, and curation-as-ordinary-work.
