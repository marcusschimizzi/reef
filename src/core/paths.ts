import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where reef keeps its state — the SQLite db, the control socket, agent
// workspaces, and the config/policy files. Defaults to ~/.reef, deliberately
// cwd-INDEPENDENT: the daemon is a persistent personal service, not something
// scoped to the directory it was launched from (a project-local ./.reef would
// silently give you a different daemon per directory). Override with REEF_HOME
// — e.g. point it at a repo-local dir when developing reef itself. Every
// entrypoint (daemon, TUI, config CLI) resolves the home through here so they
// always agree on which .reef they're talking about.

export function reefHome(): string {
  return process.env.REEF_HOME ? resolve(process.env.REEF_HOME) : join(homedir(), ".reef");
}

export const reefPath = (...parts: string[]): string => join(reefHome(), ...parts);
