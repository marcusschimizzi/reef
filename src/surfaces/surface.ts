// Surfaces — reef's outbound channels to the human. A Surface delivers a
// notification out-of-band to wherever the user actually is (a desktop
// notification, a webhook → Slack/ntfy/…, later conch push), so a proactive run
// that needs approval can *reach out* rather than silently deny. The seam is
// deliberately general (a Notification union, not just approvals): the same
// channel is how the agent will message the user for other reasons later. A
// surface failure must never break a run — notify is best-effort.

export interface ApprovalNotification {
  kind: "approval";
  approvalId: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  /** Human-readable action, e.g. "shell(npm run deploy)". */
  action: string;
  detail?: unknown;
}

// Only the approval kind today; the union leaves room for "message" etc.
export type Notification = ApprovalNotification;

export interface Surface {
  readonly id: string;
  /** Deliver a notification. Best-effort: implementations swallow their errors. */
  notify(n: Notification): Promise<void>;
}

/** A short title/body for a notification — shared by the concrete surfaces. */
export function summarize(n: Notification): { title: string; body: string } {
  return {
    title: "reef needs approval",
    body: `${n.action} · approve in your reef UI (session ${n.sessionKey})`,
  };
}
