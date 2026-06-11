import { execFile } from "node:child_process";
import { summarize, type Notification, type Surface } from "./surface.js";

// A desktop-notification surface. macOS via `osascript display notification`;
// other platforms are a no-op for now (notify-send could be added behind the
// same shape). The exec fn is injectable so tests don't actually post a
// notification.

export type Exec = (cmd: string, args: string[]) => void;

const defaultExec: Exec = (cmd, args) => {
  // fire-and-forget; ignore errors (a missing binary must not break a run)
  execFile(cmd, args, () => {});
};

export class DesktopSurface implements Surface {
  readonly id = "desktop";

  constructor(
    private readonly exec: Exec = defaultExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async notify(n: Notification): Promise<void> {
    const { title, body } = summarize(n);
    if (this.platform === "darwin") {
      this.exec("osascript", ["-e", `display notification ${osa(body)} with title ${osa(title)}`]);
    }
    // non-darwin: no-op (no assumption about an installed notifier)
  }
}

/** Quote a string as an AppleScript string literal (newlines flattened). */
function osa(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ")}"`;
}
