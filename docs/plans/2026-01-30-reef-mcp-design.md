# Reef MCP Orchestrator Phase 1 Design

## Goal
Build a stdio MCP server in TypeScript/Node.js that spawns and manages coding agents via adapters, exposes spawn/status/send/output/kill tools, normalizes events, and persists thin state snapshots for recovery.

## Scope
- Adapters: Claude Code + Codex (Phase 1).
- Transport: MCP over stdio (JSON-RPC 2.0).
- State: in-memory with thin file snapshot persistence at `./.reef/state.json`.
- Persistence is recovery-only (no process resurrection).
- Keep last 20 completed jobs for post-mortem access.

## Non-Goals
- Full history retention beyond the last 20 jobs (handled by Nacre).
- Headful agent implementation (schema and adapter slots only).
- Budget tracking and cross-agent routing (future phase).

## Requirements & Priorities
- `needs_input` is the most critical event and must always include the question and any options.
- `send` is a first-class tool; it clears awaiting_input and logs input_sent.
- Adapter pattern is the single source of agent-specific flags and parsing quirks.
- Headless is primary, but headful is supported in the model.
- All events carry timestamps; output slicing is timestamp-cursor based.

## Architecture Overview
Reef is a stdio MCP server that routes tool calls into an AgentManager. Each agent run is a Job with a lifecycle and an event stream. Adapters encapsulate agent-specific spawn flags, output parsing, and input sending. The AgentManager maintains a bounded recent completed list (last 20). A thin persistence hook serializes snapshots to disk for recovery of metadata and recent events, not process resurrection.

## Core Components
- **McpServer**: JSON-RPC 2.0 stdio server; maps MCP tools to AgentManager calls.
- **AgentManager**: Owns Job lifecycle, event collection, persistence snapshots.
- **AdapterRegistry**: Maps agent names to adapter implementations.
- **EventStore**: Append-only per-job event streams; supports timestamp slicing.
- **PersistenceHook**: `load()` and `save(snapshot)`; default JSON file at `./.reef/state.json`.

## Data Flow
### spawn
1. MCP `spawn` → AgentManager.spawn.
2. Adapter builds command (headless or headful) and spawns process.
3. Job created with metadata + `started` event.
4. Adapter parses output, emits normalized events with timestamps.
5. AgentManager appends events, updates status, snapshots state.

### send
1. MCP `send` → AgentManager.send.
2. Adapter sends input (stdin for headless; keystrokes for headful).
3. On success: clear `awaiting_input`, emit `input_sent` event.
4. Any output is parsed and appended as normalized events.

### status
- Return concise job status plus `awaiting_input` flag and lastOutput summary.

### output
- Return events sliced by `since` timestamp cursor.

### kill
- Terminate process; emit `completed` or `error` with final output.
- Move job into recent completed list (bounded to 20).

## Event Model
All events carry a timestamp. The canonical shape:

```ts
interface AgentEvent {
  timestamp: string; // ISO-8601
  type: "started" | "progress" | "tool_call" | "file_edit" | "needs_input" | "input_sent" | "error" | "completed";
  agentId: string;
  payload: Record<string, unknown>;
}
```

`needs_input` payload must include:
- `question: string`
- `options?: string[]`

## Job Lifecycle
- `running` → `awaiting_input` when a `needs_input` event is emitted.
- `awaiting_input` → `running` after successful `send` (and `input_sent` event).
- `running` → `completed` or `error` when process exits.
- `stale` indicates history-only jobs loaded from persistence without an attached process.

## Persistence
- Default file: `./.reef/state.json`.
- Snapshot includes:
  - active jobs metadata
  - recent completed jobs (last 20)
  - tail of events per job (bounded)
- Recovery loads jobs as `stale`; no auto-resume.
- Persistence failures are logged but do not block MCP responses.

## Headless vs Headful
- Headless is primary (subprocess + stdin/stdout parsing).
- Headful is modeled via `SpawnMode` and an adapter hook for UI-based drivers.
- Headful may initially return “not supported yet” while keeping schema intact.

## Error Handling
- Parser failures produce `error` events with a bounded raw-line detail.
- Errors do not crash the server; they mark the job and continue.
- Snapshot writes are best-effort.

## Testing Strategy (Phase 1)
- Adapter parsing tests with fixtures (Claude stream-json, Codex JSONL).
- AgentManager tests for state transitions, awaiting_input behavior, send clearing, and persistence pruning at 20.
- MCP tool smoke tests through in-memory stdio harness (no external binaries).

## Open Questions
- When to promote headful adapters from schema-only to real implementations.
- Whether to add a server-level event stream for monitoring multiple jobs.
