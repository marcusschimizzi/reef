import type { Run, RunStatus, SessionSummary, Trigger } from "../core/types.js";
import type { Spine } from "../db/spine.js";

// The self-introspection seam — read-only queries an agent can run against its
// own operational state (runs, sessions, triggers). The observability the TUI
// and HTTP surface, cashed in as agent-facing capability so reef can debug and
// reason about itself from the inside (the self-hosting payoff). Bound to one
// agent, so an agent only ever sees its own work.

export interface IntrospectionCapability {
  runs(opts?: { status?: RunStatus; limit?: number }): Run[];
  sessions(): SessionSummary[];
  triggers(): Trigger[];
}

export class DaemonIntrospection implements IntrospectionCapability {
  constructor(
    private readonly spine: Spine,
    private readonly agentId: string,
  ) {}

  runs(opts: { status?: RunStatus; limit?: number } = {}): Run[] {
    return this.spine.listRuns(opts).filter((r) => r.agentId === this.agentId);
  }

  sessions(): SessionSummary[] {
    return this.spine.listSessions().filter((s) => s.agentId === this.agentId);
  }

  triggers(): Trigger[] {
    return this.spine.listTriggers(this.agentId);
  }
}
