import { render } from "ink";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { reefHome } from "../core/paths.js";
import { App } from "./tui/App.js";

// The reef TUI entrypoint: gather a little session context, then hand off to the
// Ink app, which connects to the daemon over the unix socket and renders the
// native event stream.

const socketPath = join(reefHome(), "reef.sock");
const configPath = process.env.REEF_CONFIG_FILE || join(reefHome(), "config.json");

function gitBranch(): string | undefined {
  try {
    return (
      execSync("git branch --show-current", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

render(
  <App
    socketPath={socketPath}
    configPath={configPath}
    session={{
      cwd: process.cwd(),
      branch: gitBranch(),
      agentId: process.env.REEF_AGENT_ID || "reef",
    }}
  />,
);
