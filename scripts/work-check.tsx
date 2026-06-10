import React from "react";
import { render } from "ink-testing-library";
import { WorkingOctopus } from "../src/client/tui/components.js";
import { resolveTheme } from "../src/client/tui/theme.js";
const { lastFrame } = render(<WorkingOctopus theme={resolveTheme("teal")} />);
process.stdout.write("MINI-OCTO frame0:\n" + (lastFrame() ?? "") + "\n");
