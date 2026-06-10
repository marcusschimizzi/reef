// Reef's brand art. The octopus is a half-block pixel sprite — a small pixel
// grid drawn with ▀/▄ and per-cell fg+bg color, which doubles vertical
// resolution (the technique behind polished CLI mascots). 'o' = body,
// 'h' = highlight, 'e' = eye, '.' = empty.
//
// Variants explore different ARM stances over the same elongated mantle; switch
// with REEF_AVATAR to compare live. (The mantle shape is settled — `pixel`.)

export interface Avatar {
  rows: string[];
}

// Shared elongated mantle (rows 0–12) — the octopus head. Each variant appends
// its own tentacle stance.
const MANTLE = [
  "......oooooo......",
  ".....ohhhhhho.....",
  "....ohhhhhhhho....",
  "...ohhhhhhhhhho...",
  "..ohhhhhhhhhhhho..",
  "..oooooooooooooo..",
  "..oooooooooooooo..",
  "..oooeeooooeeooo..",
  "..oooeeooooeeooo..",
  "..oooooooooooooo..",
  "...oooooooooooo...",
  "...oooooooooooo...",
  "....oooooooooo....",
];

export const AVATARS: Record<string, Avatar> = {
  // Default — arms splay outward with a modest curl at the outer tips.
  pixel: {
    rows: [
      ...MANTLE,
      "..oo.oo.oo.oo.oo..",
      ".oo..oo.oo.oo..oo.",
      "oo...o..oo..o...oo",
      "o....oo.oo.oo....o",
      "oo....o....o....oo",
      ".......oo.oo......",
    ],
  },
  // Arms sweep wide to the edges, then hook back inward — a dramatic curl.
  "pixel-curl": {
    rows: [
      ...MANTLE,
      "..oo.oo.oo.oo.oo..",
      ".oo..oo.oo.oo..oo.",
      "oo...oo.oo.oo...oo",
      "oo..o...oo...o..oo",
      ".oo.....oo.....oo.",
      "..o.....oo.....o..",
    ],
  },
  // Arms hang close and straight — a calm, resting stance.
  "pixel-hang": {
    rows: [
      ...MANTLE,
      "...oo.oo.oo.oo....",
      "...o.oo.oo.oo.o...",
      "...o.o..oo..o.o...",
      "...o.o..oo..o.o...",
      "....o..o..o..o....",
      ".......oo.oo......",
    ],
  },
};

export const DEFAULT_AVATAR = "pixel";

export function resolveAvatar(name = process.env.REEF_AVATAR): Avatar {
  return AVATARS[name ?? ""] ?? AVATARS[DEFAULT_AVATAR]!;
}

/** The REEF wordmark in a chunky block font. */
export const WORDMARK = String.raw`
██████  ███████ ███████ ███████
██   ██ ██      ██      ██
██████  █████   █████   █████
██   ██ ██      ██      ██
██   ██ ███████ ███████ ██
`.replace(/^\n/, "").replace(/\n$/, "");

export const TAGLINE = "your always-on agent";

/** The input-prompt glyph. */
export const PROMPT = "❯";
