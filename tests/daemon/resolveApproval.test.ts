import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/Daemon.js";
import { parseApprovalDecision } from "../../src/protocol/events.js";
import type { AgentRecord } from "../../src/core/types.js";
import type { ModelRouter, ModelTurn, ModelTurnInput } from "../../src/model/router.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-resolve-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Returns the scripted turns, then completes for any further calls (so a resume
// that re-drives the loop never throws "out of turns").
class FakeRouter implements ModelRouter {
  constructor(private readonly turns: ModelTurn[]) {}
  async generateTurn(input: ModelTurnInput): Promise<ModelTurn> {
    const turn = this.turns.shift() ?? {
      stop: "completed" as const,
      content: [{ type: "text" as const, text: "ok" }],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    for (const b of turn.content) if (b.type === "text") input.onTextDelta?.(b.text);
    return turn;
  }
}

const gatedAgent: AgentRecord = {
  id: "reef",
  name: "Reef",
  systemPrompt: "be helpful",
  model: "fake",
  toolAllowlist: ["shell"],
};

function daemonWithPendingApproval(): Daemon {
  const dir = tempDir();
  const daemon = new Daemon({
    dbPath: join(dir, "reef.db"),
    workspaceDir: join(dir, "ws"),
    router: new FakeRouter([
      // the gated tool call → suspends for approval; the resume completes via the fallback
      {
        stop: "tool_use",
        content: [{ type: "tool_use", id: "c1", name: "shell", input: { command: "echo hi" } }],
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]),
  });
  daemon.registerAgent(gatedAgent);
  return daemon;
}

/** Drain the serial inbox: a fresh submit queues behind the fire-and-forget resume,
 *  so awaiting it guarantees the resume finished before teardown removes the dir. */
async function drain(daemon: Daemon): Promise<void> {
  await daemon.submit({ sessionKey: "__drain__", agentId: "reef", message: "x" });
}

async function pendingApprovalId(daemon: Daemon): Promise<string> {
  await daemon.submit({ sessionKey: "s1", agentId: "reef", message: "run a command" });
  const id = daemon.runsAwaitingApproval()[0]?.approvals[0]?.id;
  if (!id) throw new Error("expected a pending approval");
  return id;
}

describe("parseApprovalDecision (whitelist)", () => {
  it("accepts exactly the three canonical decisions", () => {
    expect(parseApprovalDecision("allow-once")).toBe("allow-once");
    expect(parseApprovalDecision("allow-always")).toBe("allow-always");
    expect(parseApprovalDecision("deny")).toBe("deny");
  });

  it("fails closed (deny) for anything outside the vocabulary", () => {
    for (const bad of ["", "denied", "DENY", "Deny", "deny ", " allow-once", "allow", "yes", "no", "reject", "{}", "1"]) {
      expect(parseApprovalDecision(bad)).toBe("deny");
    }
  });
});

describe("daemon.resolveApproval whitelists untrusted decision strings", () => {
  it("treats a non-deny garbage string as a denial, not an allow (fail-closed)", async () => {
    const daemon = daemonWithPendingApproval();
    const id = await pendingApprovalId(daemon);

    const ok = daemon.resolveApproval(id, "garbage");
    expect(ok).toBe(true);
    // the fail-open bug: any non-"deny" string used to map to status "allowed"
    expect(daemon.spine.getApproval(id)?.status).toBe("denied");

    await drain(daemon);
    daemon.close();
  });

  it("denies on empty and mis-cased decision strings too", async () => {
    for (const bad of ["", "DENY", "allow"]) {
      const daemon = daemonWithPendingApproval();
      const id = await pendingApprovalId(daemon);
      daemon.resolveApproval(id, bad);
      expect(daemon.spine.getApproval(id)?.status, `decision=${JSON.stringify(bad)}`).toBe("denied");
      await drain(daemon);
      daemon.close();
    }
  });

  it("still allows on a valid allow-once / allow-always", async () => {
    for (const good of ["allow-once", "allow-always"]) {
      const daemon = daemonWithPendingApproval();
      const id = await pendingApprovalId(daemon);
      daemon.resolveApproval(id, good);
      expect(daemon.spine.getApproval(id)?.status, `decision=${good}`).toBe("allowed");
      await drain(daemon);
      daemon.close();
    }
  });
});
