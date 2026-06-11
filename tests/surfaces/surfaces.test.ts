import { afterEach, describe, expect, it } from "vitest";
import { DesktopSurface } from "../../src/surfaces/desktop.js";
import { WebhookSurface } from "../../src/surfaces/webhook.js";
import { buildSurfaces } from "../../src/surfaces/index.js";
import type { Notification } from "../../src/surfaces/surface.js";

const approval: Notification = {
  kind: "approval",
  approvalId: "a1",
  runId: "r1",
  sessionKey: "reef:reef:trigger-x",
  agentId: "reef",
  action: "shell(npm run deploy)",
};

describe("DesktopSurface", () => {
  it("posts an osascript notification on macOS", async () => {
    const calls: Array<[string, string[]]> = [];
    await new DesktopSurface((cmd, args) => calls.push([cmd, args]), "darwin").notify(approval);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("osascript");
    expect(calls[0]![1].join(" ")).toMatch(/display notification.*npm run deploy/);
  });

  it("is a no-op on non-macOS (no assumed notifier)", async () => {
    const calls: unknown[] = [];
    await new DesktopSurface(() => calls.push(1), "linux").notify(approval);
    expect(calls).toHaveLength(0);
  });
});

describe("WebhookSurface", () => {
  it("POSTs a JSON body carrying a text summary and the structured notification", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { ok: true, status: 200 };
    };
    await new WebhookSurface("https://hook.example/x", { "x-test": "1" }, fetcher).notify(approval);
    expect(seen[0]!.url).toBe("https://hook.example/x");
    expect(seen[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.text).toMatch(/npm run deploy/);
    expect(body.notification).toMatchObject({ approvalId: "a1", action: "shell(npm run deploy)" });
  });

  it("swallows a failed POST (a surface must not break the run)", async () => {
    const fetcher = async () => {
      throw new Error("network down");
    };
    await expect(new WebhookSurface("https://x", {}, fetcher).notify(approval)).resolves.toBeUndefined();
  });
});

describe("buildSurfaces", () => {
  const saved = process.env.TEST_WEBHOOK_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEST_WEBHOOK_URL;
    else process.env.TEST_WEBHOOK_URL = saved;
  });

  it("builds desktop and webhook surfaces, resolving urlEnv from the environment", () => {
    process.env.TEST_WEBHOOK_URL = "https://hook.example/from-env";
    const surfaces = buildSurfaces([
      { kind: "desktop" },
      { kind: "webhook", url: "https://hook.example/literal" },
      { kind: "webhook", urlEnv: "TEST_WEBHOOK_URL" },
    ]);
    expect(surfaces.map((s) => s.id)).toEqual(["desktop", "webhook", "webhook"]);
  });

  it("skips (and logs) a webhook with no resolvable url", () => {
    delete process.env.TEST_WEBHOOK_URL;
    const logs: string[] = [];
    const surfaces = buildSurfaces([{ kind: "webhook", urlEnv: "TEST_WEBHOOK_URL" }], (m) => logs.push(m));
    expect(surfaces).toHaveLength(0);
    expect(logs.some((l) => l.includes("skipped"))).toBe(true);
  });
});
