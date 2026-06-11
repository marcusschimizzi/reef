import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ConfigView } from "../../src/client/tui/configView.js";
import { resolveTheme } from "../../src/client/tui/theme.js";

const theme = resolveTheme("coral");
const noop = (): void => {};

describe("ConfigView", () => {
  it("shows the scalar fields, providers, status, and the selection marker", () => {
    const { lastFrame } = render(
      <ConfigView
        theme={theme}
        defaultModel="ollama/llama3.1"
        policyFile=".reef/policy.json"
        providers={[{ id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/v1" }]}
        selected={0}
        editing={null}
        onEditChange={noop}
        onEditSubmit={noop}
        status="saved — restart the daemon to apply"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("configuration");
    expect(out).toContain("ollama/llama3.1");
    expect(out).toContain(".reef/policy.json");
    expect(out).toContain("zai");
    expect(out).toContain("openai-compatible");
    expect(out).toContain("saved");
    expect(out).toMatch(/❯ .*model/); // row 0 selected
    expect(out).toContain("built-in: anthropic, openai, ollama, openrouter");
  });

  it("renders the edit buffer in the selected field while editing", () => {
    const { lastFrame } = render(
      <ConfigView
        theme={theme}
        defaultModel="old-model"
        policyFile=""
        providers={[]}
        selected={0}
        editing="openrouter/new-model"
        onEditChange={noop}
        onEditSubmit={noop}
      />,
    );
    expect(lastFrame() ?? "").toContain("openrouter/new-model");
  });

  it("shows an empty-state hint and (unset) for blank scalars", () => {
    const { lastFrame } = render(
      <ConfigView
        theme={theme}
        defaultModel=""
        policyFile=""
        providers={[]}
        selected={0}
        editing={null}
        onEditChange={noop}
        onEditSubmit={noop}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("(unset)");
    expect(out).toContain("npm run config");
  });
});
