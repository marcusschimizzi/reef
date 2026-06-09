# Archive

Material from reef's first incarnation as an **MCP server / agent-orchestration helper layer**,
kept after the pivot to reef-as-an-always-on-agent-daemon (see `reef-docs/` for the new design and
`.claude/plans/` for the pivot plan).

Nothing here is wired into the current build. It is retained because it is either useful to
resurrect or is prior context worth not losing. Everything is also in git history.

## Contents

- `adapters/` — the old external-agent CLI adapters (`Claude`/`Codex`/`OpenCode`) plus the JSONL
  stream parser and adapter registry. **Earmarked for resurrection** in a later phase as the
  implementation of an "external agent" *tool* — i.e. reef driving Claude Code / Codex as one tool
  in its belt, rather than as its core. `adapters/jsonl.ts` in particular is a reusable
  newline-delimited JSON stream parser.
- `docs/` — the original MCP-era design & implementation plans.
- `CONCEPT.md`, `findings.md`, `progress.md`, `task_plan.md` — MCP-era notes and status logs.
- `scripts/` — `reefctl.mjs` / `reefwatch-once.mjs`, CLI wrappers for the old MCP tool surface.
- `test.jsonl` — stray fixture data.

The MCP server itself (`server.ts`, `mcp/`, `agent/AgentManager.ts`, the persistence and core type
modules) was removed rather than archived — it's the part the pivot explicitly discards, and it
lives in git history if ever needed.
