import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { StateSnapshot } from "./types.js";

export class FileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StateSnapshot | null> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      return JSON.parse(raw) as StateSnapshot;
    } catch {
      return null;
    }
  }

  async save(snapshot: StateSnapshot): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    // Atomic write (best-effort): write to tmp then rename.
    // This prevents partial/corrupt state files if the process is killed mid-write.
    const tmpPath = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tmpPath, this.path);
  }
}
