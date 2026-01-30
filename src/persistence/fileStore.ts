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
    await fs.writeFile(this.path, JSON.stringify(snapshot, null, 2), "utf8");
  }
}
