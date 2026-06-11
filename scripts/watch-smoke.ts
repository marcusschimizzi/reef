import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/Daemon.js";
import type { AgentRecord } from "../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../src/model/router.js";

// Exercises the REAL node:fs watch path end-to-end (the unit tests stub the
// factory): create a watch on a temp dir, touch a file, confirm a run fires with
// the changed path threaded in. Offline — a trivial router, no model call.
// Run: npx tsx scripts/watch-smoke.ts

class EchoRouter implements ModelRouter {
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const last = input.messages.at(-1);
    const text = last?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "";
    return { stop: "completed", content: [{ type: "text", text: `saw: ${text}` }], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const dir = mkdtempSync(join(tmpdir(), "reef-watch-smoke-"));
// Keep the workspace OUTSIDE the watched dir, else the daemon's own mkdir would
// self-trigger the watch (the feedback case cooldownMs guards in real use).
const watched = join(dir, "src");
mkdirSync(watched);
const daemon = new Daemon({
  dbPath: join(dir, "reef.db"),
  workspaceDir: join(dir, "ws"),
  router: new EchoRouter(),
});
daemon.registerAgent({ id: "reef", name: "Reef", systemPrompt: "x", model: "fake", toolAllowlist: [] } satisfies AgentRecord);

let fired = false;
daemon.subscribe((e) => {
  if (e.type === "run.started" && e.source?.kind === "trigger") {
    fired = true;
    process.stdout.write(`run.started source=${JSON.stringify(e.source)}\n`);
  }
});

// Realistic bounds: debounce coalesces the OS's save burst into one fire;
// cooldown prevents a second fire (incl. any self-triggered fs noise).
const trigger = daemon.ensureWatch({ agentId: "reef", path: watched, input: "Source changed — react.", debounceMs: 150, cooldownMs: 3000 });
daemon.start();
process.stdout.write(`watching ${dir} (trigger ${trigger.id}, nextFireAt=${trigger.nextFireAt})\n`);

// Touch a file to trigger a change event.
setTimeout(() => writeFileSync(join(watched, "main.ts"), "// changed\n"), 100);

setTimeout(() => {
  const msgs = daemon.spine.getMessages(trigger.sessionKey);
  const user = msgs.find((m) => m.role === "user");
  const text = user?.content.map((b) => (b.type === "text" ? b.text : "")).join("") ?? "(none)";
  process.stdout.write(`\nfired=${fired}\nwake message: ${text}\n`);
  daemon.close();
  rmSync(dir, { recursive: true, force: true });
  // A real fs.watch fire is the smoke's bar; exact path-threading (and the
  // debounce/cooldown logic) is asserted deterministically in the unit tests.
  process.exit(fired ? 0 : 1);
}, 1200);
