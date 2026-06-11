import React from "react";
import { render } from "ink-testing-library";
import { ConfigView } from "../src/client/tui/configView.js";
import { resolveTheme } from "../src/client/tui/theme.js";
const theme = resolveTheme(process.argv[2]);
const { lastFrame } = render(
  <ConfigView theme={theme} defaultModel="ollama/llama3.1" policyFile=".reef/policy.json"
    providers={[{ id: "zai", kind: "openai-compatible", baseURL: "https://api.z.ai/api/paas/v4" }, { id: "opencode", kind: "openai-compatible", baseURL: "https://opencode.ai/zen/v1" }]}
    selected={0} editing={null} onEditChange={() => {}} onEditSubmit={() => {}}
    status="saved — restart the daemon to apply" />
);
console.log(lastFrame());
