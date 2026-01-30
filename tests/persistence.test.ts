import { describe, expect, it } from "vitest";
import { FileStore } from "../src/persistence/fileStore.js";

describe("FileStore", () => {
  it("round-trips snapshot", async () => {
    const store = new FileStore("./.reef/test-state.json");
    const snapshot = { jobs: [], completed: [], eventTails: {} };
    await store.save(snapshot);
    const loaded = await store.load();
    expect(loaded).toEqual(snapshot);
  });
});
