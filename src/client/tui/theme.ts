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

// Violet is the brand color across every purple theme; they differ ONLY in the
// `secondary` accent, which is spent exceedingly sparingly (essentially just the
// git-branch tag — cf. Claude Code's teal branch badge). Pick the accent you
// like via REEF_THEME; the octopus and wordmark stay violet regardless.
const VIOLET = "#a78bfa";

// Periwinkle accent (the original).
const purple: Theme = {
  name: "purple",
  primary: VIOLET,
  secondary: "#818cf8", // periwinkle
  muted: "#8b8298",
  ok: "#34d399",
  warn: "#fbbf24",
  error: "#fb7185",
};

// Violet brand + teal accent (default) — the rare accent reads cool & distinct.
const teal: Theme = {
  name: "teal",
  primary: VIOLET,
  secondary: "#2dd4bf", // teal accent
  muted: "#8b8298",
  ok: "#34d399",
  warn: "#fbbf24",
  error: "#fb7185",
};

// Violet brand + indigo accent — a subtler, analogous accent.
const indigo: Theme = {
  name: "indigo",
  primary: VIOLET,
  secondary: "#6366f1", // indigo accent
  muted: "#8b8298",
  ok: "#34d399",
  warn: "#fbbf24",
  error: "#fb7185",
};

const THEMES: Record<string, Theme> = { coral, purple, teal, indigo };

export function resolveTheme(name = process.env.REEF_THEME): Theme {
  return THEMES[name ?? ""] ?? teal;
}

/** Lighten (amt > 0, toward white) or darken (amt < 0, toward black) a hex color
 *  by a fraction in [-1, 1] — used to derive sprite shading tones from a base. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const target = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const mix = (c: number): number => Math.round(c + (target - c) * p);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
