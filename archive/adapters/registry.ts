import type { AgentAdapter } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(name: string, adapter: AgentAdapter): void {
    this.adapters.set(name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
