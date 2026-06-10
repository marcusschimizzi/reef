// Reef's TUI palette. Two themes ship; `REEF_THEME=purple` switches at launch so
// the look can be compared live in-terminal rather than chosen from a swatch.
// Colors are truecolor hex (Ink renders them where supported, degrading on
// 16-color terminals). Semantic names — not raw colors — are used everywhere in
// the UI, so re-theming is a single edit here.

export interface Theme {
  name: string;
  /** Primary brand color — wordmark, the agent's name, active accents. */
  primary: string;
  /** Secondary brand color — frames, the avatar body, panel borders. */
  secondary: string;
  /** Assistant message text. */
  assistant: string;
  /** The user's own text / label. */
  user: string;
  /** Tool calls and their machinery. */
  tool: string;
  /** Success (tool ok, connected). */
  ok: string;
  /** Warnings / approvals / attention. */
  warn: string;
  /** Errors / denials / failures. */
  error: string;
  /** De-emphasized text — hints, thinking, timestamps, separators. */
  muted: string;
}

// Coral-on-teal: an underwater-but-alive reef. Teal/aqua structure, coral accent.
const coral: Theme = {
  name: "coral",
  primary: "#ff8c69", // coral
  secondary: "#2dd4bf", // teal/aqua
  assistant: "#5eead4", // soft aqua
  user: "#e7e5d8", // warm foam
  tool: "#38bdf8", // shallow-water blue
  ok: "#34d399", // sea green
  warn: "#fbbf24", // sunlit amber
  error: "#fb7185", // warning coral-red
  muted: "#7d8a99", // sand-grey
};

// Purple direction: a deeper, more nocturnal reef glow.
const purple: Theme = {
  name: "purple",
  primary: "#c084fc", // bright violet
  secondary: "#8b5cf6", // amethyst
  assistant: "#d8b4fe", // soft lavender
  user: "#ece9f5", // pale foam
  tool: "#60a5fa", // periwinkle blue
  ok: "#34d399",
  warn: "#fbbf24",
  error: "#fb7185",
  muted: "#8b8298",
};

const THEMES: Record<string, Theme> = { coral, purple };

export function resolveTheme(name = process.env.REEF_THEME): Theme {
  return THEMES[name ?? ""] ?? coral;
}
