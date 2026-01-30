export type AgentType = "claude" | "codex";
export type SpawnMode = "headless" | "headful";

export type JobStatus =
  | "running"
  | "awaiting_input"
  | "completed"
  | "error"
  | "stale";

export interface Job {
  id: string;
  agent: AgentType;
  mode: SpawnMode;
  task: string;
  cwd: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
}

export type EventType =
  | "started"
  | "progress"
  | "tool_call"
  | "file_edit"
  | "needs_input"
  | "input_sent"
  | "error"
  | "completed";

export interface AgentEvent {
  timestamp: string;
  type: EventType;
  agentId: string;
  payload: Record<string, unknown>;
}
