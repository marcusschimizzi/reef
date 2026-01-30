import type { AgentEvent, Job } from "../types.js";

export interface StateSnapshot {
  jobs: Job[];
  completed: Job[];
  eventTails: Record<string, AgentEvent[]>;
}
