import { summarize, type Notification, type Surface } from "./surface.js";

// A webhook surface: POST the notification as JSON to a configured URL — for
// Slack/Discord/ntfy/custom incoming webhooks, or your own relay. The body
// carries a `text` summary (which Slack and many services render) plus the
// structured notification. Best-effort: a failed POST is swallowed. The fetcher
// is injectable for tests.

export type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

export class WebhookSurface implements Surface {
  readonly id: string;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly fetcher: Fetcher = defaultFetcher,
    id = "webhook",
  ) {
    this.id = id;
  }

  async notify(n: Notification): Promise<void> {
    const { title, body } = summarize(n);
    const payload = { text: `${title}: ${body}`, notification: n };
    try {
      await this.fetcher(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers },
        body: JSON.stringify(payload),
      });
    } catch {
      // a surface failure must not affect the run
    }
  }
}
