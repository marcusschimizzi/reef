// Reef's brand art. The octopus is a half-block pixel sprite — a small pixel
// grid drawn with ▀/▄ and per-cell fg+bg color, which doubles vertical
// resolution (the technique behind polished CLI mascots). 'o' = body,
// 'h' = highlight, 'e' = eye, '.' = empty.
//
// The settled octopus: elongated mantle, two eyes, arms splaying out with a curl
// at the tips and an OPEN center (no straight-down central arm — that read as a
// "nose"). Kept in a registry so new arm stances can be added + compared via
// REEF_AVATAR when we refine further.

export interface Avatar {
  rows: string[];
}

export const AVATARS: Record<string, Avatar> = {
  pixel: {
    rows: [
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
      "..oo.oo....oo.oo..",
      ".oo..oo....oo..oo.",
      "oo...o......o...oo",
      "o....oo....oo....o",
      "oo....o....o....oo",
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
