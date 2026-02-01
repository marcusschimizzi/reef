# Findings & Decisions

## Requirements
- Build Reef MCP server (stdio transport) in TypeScript + Node.js.
- Implement MCP tools: spawn, status, kill (send/output/budgets future).
- Provide agent adapters for Claude Code and Codex in Phase 1.
- Use structured subprocess output parsing (stream-json for Claude, JSONL for Codex).

## Research Findings
- Non-interactive agent flags:
  - Claude Code: `claude -p "{task}" -y --output-format stream-json`
  - Codex: `codex exec --json --full-auto "{task}"`
- MCP server runs over stdio (JSON-RPC 2.0) with in-memory state.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Stdio transport | Clawdbot-native and requested |
| Adapters for Claude/Codex only | Scope limited to Phase 1 |
| Include thin persistence hook | Allow job state save/load without implementing full persistence |
| Default persistence path `./.reef/state.json` | Keeps data isolated under project-local directory |
| Persist running + recent completed jobs | Enable basic recovery and post-mortem output access |
| Retain last 20 completed jobs | Thin persistence; long-term history handled by Nacre |

## Design Priorities
- `needs_input` events are critical; always include question + options.
- `send` tool is a top priority for mid-task interaction.
- Support headless + headful agents (headless primary).
- Adapter pattern and event normalization hide agent-specific details.
- All events must include timestamps (required for output slicing).

## Phase 2 Integration Notes
- MCP stdio transport frames JSON-RPC messages as newline-delimited JSON.
- Initialize request requires `protocolVersion`, `capabilities`, and `clientInfo` fields.
- Protocol versions include `2025-11-25` (latest in SDK).
- Realistic fixtures require actual Claude stream-json and Codex JSONL samples from integration runs.

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| init-session.sh permission denied | Retried with escalated permissions |

## Resources
- /home/marcuss/Projects/lobstar-builds/reef/CONCEPT.md
- Fixture tests/fixtures/codex.jsonl uses JSONL lines with type fields like thread.started, turn.started, item.started/item.completed; includes command_execution payloads.
- Fixture tests/fixtures/claude-stream.jsonl includes JSONL lines with type values like system (subtype hook_started/init), assistant (message payload), and result entries.
- Both adapters parseOutput delegate to parseJsonLines and map payload.type through; interleaved stderr will surface as error events from parseJsonLines.
