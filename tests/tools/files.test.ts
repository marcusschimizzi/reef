import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundFs } from "../../src/fs/capability.js";
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "../../src/tools/files.js";
import type { ToolContext } from "../../src/tools/types.js";

const dirs: string[] = [];
function ctx(): ToolContext {
  const dir = mkdtempSync(join(tmpdir(), "reef-files-"));
  dirs.push(dir);
  return { fs: new BoundFs(dir) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("file tools", () => {
  it("write → read → list round-trip", async () => {
    const c = ctx();
    await writeFileTool.run({ path: "notes/a.txt", content: "hello" }, c);
    expect(await readFileTool.run({ path: "notes/a.txt" }, c)).toEqual({
      path: "notes/a.txt",
      content: "hello",
    });
    expect(await listFilesTool.run({ path: "notes" }, c)).toEqual({
      path: "notes",
      entries: ["a.txt"],
    });
  });

  it("edit_file replaces a unique substring", async () => {
    const c = ctx();
    await writeFileTool.run({ path: "f.txt", content: "the quick brown fox" }, c);
    const res = await editFileTool.run(
      { path: "f.txt", old_string: "quick", new_string: "slow" },
      c,
    );
    expect(res).toEqual({ path: "f.txt", replacements: 1 });
    expect((await readFileTool.run({ path: "f.txt" }, c)).content).toBe("the slow brown fox");
  });

  it("edit_file rejects an ambiguous match unless replace_all", async () => {
    const c = ctx();
    await writeFileTool.run({ path: "f.txt", content: "a a a" }, c);
    await expect(
      editFileTool.run({ path: "f.txt", old_string: "a", new_string: "b" }, c),
    ).rejects.toThrow(/occurs 3 times/);

    const res = await editFileTool.run(
      { path: "f.txt", old_string: "a", new_string: "b", replace_all: true },
      c,
    );
    expect(res).toEqual({ path: "f.txt", replacements: 3 });
    expect((await readFileTool.run({ path: "f.txt" }, c)).content).toBe("b b b");
  });

  it("edit_file errors when old_string is absent", async () => {
    const c = ctx();
    await writeFileTool.run({ path: "f.txt", content: "hello" }, c);
    await expect(
      editFileTool.run({ path: "f.txt", old_string: "xyz", new_string: "q" }, c),
    ).rejects.toThrow(/not found/);
  });

  it("cannot escape the workspace (containment by construction)", async () => {
    const c = ctx();
    await expect(readFileTool.run({ path: "../../etc/passwd" }, c)).rejects.toThrow(
      /escapes workspace/,
    );
    await expect(
      writeFileTool.run({ path: "/tmp/evil.txt", content: "x" }, c),
    ).rejects.toThrow(/escapes workspace/);
  });
});
