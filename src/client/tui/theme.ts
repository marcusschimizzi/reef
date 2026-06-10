// Reef's TUI palette. Two themes ship; `REEF_THEME=purple` switches at launch so
// the look can be compared live in-terminal rather than chosen from a swatch.
//
// Restraint is the rule: color is an ACCENT, not the body. Message text, tool
// names, and the like render in the terminal's own foreground (no color set);
// the palette is spent only on the brand (wordmark/avatar/agent label), on
// borders, on de-emphasis (muted), and on semantic state (ok/warn/error). Using
// semantic names everywhere — never raw colors — keeps re-theming a single edit.

export interface Theme {
  name: string;
  /** Brand accent — wordmark, the agent's name label, the working spinner. */
  primary: string;
  /** Secondary brand — frames/borders, the avatar, tool glyphs, the branch tag. */
  secondary: string;
  /** De-emphasized text — labels, hints, tool args/results, notices, status. */
  muted: string;
  /** Success — a tool completed, connected. */
  ok: string;
  /** Attention — approvals, warnings. */
  warn: string;
  /** Failure — denials, errors. */
  error: string;
}

// Coral-on-teal: an underwater-but-alive reef. Coral brand accent, teal structure.
const coral: Theme = {
  name: "coral",
  primary: "#ff8c69", // coral
  secondary: "#2dd4bf", // teal/aqua
  muted: "#7d8a99", // sand-grey
  ok: "#34d399", // sea green
  warn: "#fbbf24", // sunlit amber
  error: "#fb7185", // coral-red
};

// Purple direction: a deeper, more nocturnal reef glow.
const purple: Theme = {
  name: "purple",
  primary: "#c084fc", // bright violet
  secondary: "#8b5cf6", // amethyst
  muted: "#8b8298", // dusk-grey
  ok: "#34d399",
  warn: "#fbbf24",
  error: "#fb7185",
};

const THEMES: Record<string, Theme> = { coral, purple };

export function resolveTheme(name = process.env.REEF_THEME): Theme {
  return THEMES[name ?? ""] ?? coral;
}
