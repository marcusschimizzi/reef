import { DesktopSurface } from "./desktop.js";
import { WebhookSurface } from "./webhook.js";
import type { Surface } from "./surface.js";

export type { Surface, Notification, ApprovalNotification } from "./surface.js";
export { summarize } from "./surface.js";
export { DesktopSurface } from "./desktop.js";
export { WebhookSurface } from "./webhook.js";

/** User config for one surface (validated by the config schema). */
export type SurfaceConfig =
  | { kind: "desktop" }
  | { kind: "webhook"; url?: string; urlEnv?: string; headers?: Record<string, string> };

/**
 * Build the configured surfaces. A webhook's URL is taken literally or from
 * `urlEnv` (keeping a secret Slack-style URL out of the config file); a webhook
 * with neither is skipped with a log line rather than failing the daemon.
 */
export function buildSurfaces(
  configs: SurfaceConfig[],
  log: (message: string) => void = () => {},
): Surface[] {
  const surfaces: Surface[] = [];
  for (const c of configs) {
    if (c.kind === "desktop") {
      surfaces.push(new DesktopSurface());
    } else if (c.kind === "webhook") {
      const url = c.url ?? (c.urlEnv ? process.env[c.urlEnv] : undefined);
      if (!url) {
        log(`webhook surface skipped — no url (set "url", or "urlEnv" pointing at a set env var)`);
        continue;
      }
      surfaces.push(new WebhookSurface(url, c.headers));
    }
  }
  if (surfaces.length) log(`surfaces enabled: ${surfaces.map((s) => s.id).join(", ")}`);
  return surfaces;
}
