# 08 — Tools & Extensions

> **Status:** Early design. The trust posture and the tool/MCP/skill split are settled. The
> tool interface, the skill format, and the MCP integration shape are planning-time
> decisions.

## The trust posture, first

Everything in this document follows from one stance: **tools are the user's own code.**
There is no marketplace, no plugin discovery of untrusted third parties, no public skill
registry. The corpus was unambiguous that the marketplace pattern is the single
highest-risk piece of the personal-agent projects that adopted it — it was the source of
their worst supply-chain exposure. Reef eliminates the category.

This is what lets Reef's tool layer be *small*. The elaborate sandboxing, the capability
gating, the plugin lifecycle machinery in the larger projects exist to contain code the
operator did not write. Reef does not run code the operator did not write. The containment
that matters in Reef is not "is this tool safe" — it is "where can this tool reach," and
that is the broker's job (`06`), enforced by bound handles, not by sandboxing the tool
itself.

## Three extension surfaces

Reef distinguishes three things often lumped together:

- **Tools** — what an agent can *do* in a single action. First-party, authored in-repo.
  Functions with typed inputs and a description the model sees.
- **MCP** — the bridge to the external tool ecosystem. Reef is an MCP *client*: it consumes
  MCP servers so agents can use the existing ecosystem without Reef re-implementing every
  integration. Whether Reef also exposes itself as an MCP server is open (`10`).
- **Skills** — not code. Instructional content — "how to do this kind of task" — loaded into
  an agent's context when relevant. A skill describes procedure; a tool executes action.
  Skills are the user's own authored content, same trust posture as tools.

Keeping these three distinct matters because they have different lifecycles, different trust
stories, and different consumers. Conflating them is how extension systems become tangled.

## Tools

A tool is a function with a typed signature and a description. The signature defines what
the model must provide; the description is what the model reads to decide to call it. The
schema the model sees should be derivable from the signature, not maintained separately —
the corpus showed hand-maintained tool schemas drift from their implementations.

Tools that touch the filesystem do not take free paths. They are constructed around a
broker-issued grant (`06`) — bound to a path scope and a mode. This is the one hard rule of
the tool layer: a filesystem tool's reach is a property of how it was constructed for this
run, not a parameter it is trusted to use correctly.

Per-agent allowlists. An agent's record names the tools it may use; it cannot call outside
that set. This is configuration, not enforcement-by-prompt.

## MCP

MCP is how Reef gets the external ecosystem without owning it. An agent's allowlist can
include MCP-provided tools alongside first-party ones, and the loop should not need to care
which is which — an MCP tool and a first-party tool present the same way to the agent.

MCP servers are still external code, so they sit differently in the trust posture than
first-party tools: the user *chooses* to connect one, the way they would choose to install
any dependency. The containment story is the same as everything else — what an MCP tool can
reach is bounded by the grants the run holds, not by trusting the server.

## Skills

A skill is authored instructional content with enough metadata for the system to know when
it is relevant. The corpus's reference shape was lightweight — a document plus frontmatter,
discovered from known locations, with a clear precedence when the same skill exists in more
than one place.

The open questions — the skill format, how relevance is decided, whether skills are injected
automatically or selected explicitly — are planning-time. The settled part: skills are
content not code, they are the user's own, and they are distinct from tools.

## What Reef does not build

- **No sandboxing of tool execution.** Because tools are the user's code. If a specific tool
  needs isolation, it isolates itself internally — that is a property of that tool, not a
  layer Reef provides.
- **No plugin runtime, no plugin discovery, no plugin marketplace.** The extension surface
  is the repo. Adding a tool is adding code to Reef; adding a skill is adding content.
- **No capability-gating system for tools.** That machinery exists in the corpus to contain
  untrusted plugins. Reef's equivalent concern — reach — is the broker's, and the broker
  governs *resources*, not *tools*.

## What this document does not decide

The tool interface — its exact signature shape, how schemas are derived. The skill format
and how skill relevance is determined. The MCP integration's exact shape, and whether Reef
also acts as an MCP server. How first-party tools and MCP tools are unified in presentation
to the agent. These are planning-time and design-time decisions. What is fixed: tools are
the user's own code, the three surfaces (tools / MCP / skills) are distinct, filesystem
tools are bound to broker grants by construction, per-agent allowlists, and no
marketplace / no plugin runtime / no tool sandboxing.
