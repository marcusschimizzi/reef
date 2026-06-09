import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundFs } from "../../src/fs/capability.js";

const dirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "reef-fs-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BoundFs", () => {
  it("reads back what it writes, creating parent dirs", async () => {
    const fs = new BoundFs(tempRoot());
    await fs.write("nested/dir/file.txt", "hello");
    expect(await fs.read("nested/dir/file.txt")).toBe("hello");
    expect(await fs.list("nested/dir")).toEqual(["file.txt"]);
  });

  it("refuses paths that escape the root — containment by construction", () => {
    const fs = new BoundFs(tempRoot());
    expect(() => fs.resolve("../outside.txt")).toThrow(/escapes workspace/);
    expect(() => fs.resolve("a/../../outside.txt")).toThrow(/escapes workspace/);
    expect(() => fs.resolve("/etc/passwd")).toThrow(/escapes workspace/);
  });

  it("allows paths that stay within the root", () => {
    const root = tempRoot();
    const fs = new BoundFs(root);
    expect(fs.resolve("a/b.txt")).toBe(join(root, "a/b.txt"));
    expect(fs.resolve("./x")).toBe(join(root, "x"));
  });
});
