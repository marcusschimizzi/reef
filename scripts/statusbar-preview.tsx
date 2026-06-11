import React from "react";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/client/tui/components.js";
import { resolveTheme } from "../src/client/tui/theme.js";
const t = resolveTheme("teal");
console.log(render(<StatusBar theme={t} status="idle" usage={{inputTokens:1240,outputTokens:380}} agentId="reef" model="zai-coding/glm-4.6" />).lastFrame());
