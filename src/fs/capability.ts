import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// The filesystem-capability seam (reef-docs/06, reef-docs/08). Tools never
// resolve ambient absolute paths — they receive an FsCapability and address
// everything relative to it. Containment is a property of *how the handle was
// constructed*, not a check the tool has to remember to run. The "broker" today
// is allow-all (every run gets a handle at its workspace root); leases/grants
// and per-mode policy slot in behind this same interface later, with no change
// to any tool.

export interface FsCapability {
  /** Absolute path for a workspace-relative path; throws if it escapes the root. */
  resolve(relPath: string): string;
  read(relPath: string): Promise<string>;
  write(relPath: string, content: string): Promise<void>;
  list(relPath?: string): Promise<string[]>;
}

/** A capability bound to a single root directory. The binding is the guarantee. */
export class BoundFs implements FsCapability {
  constructor(private readonly root: string) {}

  resolve(relPath: string): string {
    const abs = resolve(this.root, relPath);
    const rel = relative(this.root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  async read(relPath: string): Promise<string> {
    return readFile(this.resolve(relPath), "utf8");
  }

  async write(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async list(relPath = "."): Promise<string[]> {
    return readdir(this.resolve(relPath));
  }
}
