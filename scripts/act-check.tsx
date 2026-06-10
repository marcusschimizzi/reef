import React from "react";
import { render } from "ink-testing-library";
import { Activity } from "../src/client/tui/components.js";
import { resolveTheme } from "../src/client/tui/theme.js";
const { lastFrame } = render(<Activity theme={resolveTheme("teal")} />);
process.stdout.write("[" + (lastFrame() ?? "") + "]\n");
