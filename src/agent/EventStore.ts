import type { AgentEvent } from "../types.js";
import { MAX_EVENT_TAIL } from "../config.js";

export class EventStore {
  private readonly tails = new Map<string, AgentEvent[]>();

  append(jobId: string, event: AgentEvent): void {
    const list = this.tails.get(jobId) ?? [];
    list.push(event);
    if (list.length > MAX_EVENT_TAIL) list.shift();
    this.tails.set(jobId, list);
  }

  getSince(jobId: string, since?: string): AgentEvent[] {
    const list = this.tails.get(jobId) ?? [];
    if (!since) return list;
    return list.filter((event) => event.timestamp > since);
  }

  snapshot(): Record<string, AgentEvent[]> {
    return Object.fromEntries(this.tails.entries());
  }
}
