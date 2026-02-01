import type { AgentEvent, EventType } from "./types.js";

export function nowTimestamp(): string {
  return new Date().toISOString();
}

export function makeEvent(
  type: EventType,
  agentId: string,
  payload: Record<string, unknown>
): AgentEvent {
  return { timestamp: nowTimestamp(), type, agentId, payload };
}
