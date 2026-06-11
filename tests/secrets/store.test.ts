import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../../src/secrets/store.js";

const dirs: string[] = [];
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "reef-secrets-"));
  dirs.push(dir);
  return join(dir, "nested", "secrets.json"); // exercises mkdir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("round-trips secrets by id and deletes them", () => {
    const store = new FileStore(tmpPath());
    expect(store.get("zai")).toBeUndefined();
    store.set("zai", "sk-zai-123");
    store.set("opencode", "sk-oc-456");
    expect(store.get("zai")).toBe("sk-zai-123");
    expect(store.get("opencode")).toBe("sk-oc-456");
    store.delete("zai");
    expect(store.get("zai")).toBeUndefined();
    expect(store.get("opencode")).toBe("sk-oc-456"); // unaffected
  });

  it("writes the secrets file with 0600 permissions", () => {
    const path = tmpPath();
    const store = new FileStore(path);
    store.set("zai", "sk-zai-123");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reports the file backend", () => {
    expect(new FileStore(tmpPath()).backend).toBe("file");
  });
});
