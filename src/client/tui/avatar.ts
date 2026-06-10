// Reef's brand art. The octopus is a switchable registry (REEF_AVATAR=…) so the
// directions can be compared live in-terminal. Line variants are colored as a
// whole; the `pixel` variant is a half-block sprite — a small pixel grid drawn
// with ▀/▄ and per-cell fg+bg color, which doubles vertical resolution (the
// technique behind polished CLI mascots). 'o' = body, 'e' = eye, '.' = empty.

export interface LineAvatar {
  kind: "line";
  art: string;
}
export interface PixelAvatar {
  kind: "pixel";
  rows: string[];
}
export type Avatar = LineAvatar | PixelAvatar;

const line = (art: string): LineAvatar => ({
  kind: "line",
  art: art.replace(/^\n/, "").replace(/\n$/, ""),
});

export const AVATARS: Record<string, Avatar> = {
  // Half-block colored sprite — the default. Tall elongated mantle (the octopus
  // signature, vs a crab's wide flat body), a highlight sheen up top, and
  // tentacles that splay wider than the head and curl at the tips.
  // 'o' body · 'h' highlight · 'e' eye · '.' empty. 20 px tall → 10 text rows.
  pixel: {
    kind: "pixel",
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
      "..oo.oo.oo.oo.oo..",
      ".oo..oo.oo.oo..oo.",
      "oo...o..oo..o...oo",
      "o....oo.oo.oo....o",
      "oo....o....o....oo",
      ".......oo.oo......",
    ],
  },
  // Variant: rounder, wider, shorter mantle (a fuller dome).
  "pixel-dome": {
    kind: "pixel",
    rows: [
      ".....oooooooo.....",
      "...oohhhhhhhhoo...",
      "..ohhhhhhhhhhhho..",
      ".oohhhhhhhhhhhhoo.",
      ".oooooooooooooooo.",
      ".oooooooooooooooo.",
      ".oooeeoooooeeoooo.",
      ".oooeeoooooeeoooo.",
      ".oooooooooooooooo.",
      "..oooooooooooooo..",
      "...oooooooooooo...",
      "....oooooooooo....",
      "..oo.oo.oo.oo.oo..",
      ".oo..oo.oo.oo..oo.",
      "oo...o..oo..o...oo",
      "o....oo.oo.oo....o",
      "oo....o....o....oo",
      ".......oo.oo......",
    ],
  },
  // Variant: narrower, taller mantle (most elongated head).
  "pixel-tall": {
    kind: "pixel",
    rows: [
      ".......oooo.......",
      "......oooooo......",
      ".....ohhhhhho.....",
      "....ohhhhhhhho....",
      "...ohhhhhhhhhho...",
      "...oohhhhhhhhoo...",
      "...oooooooooooo...",
      "...oooooooooooo...",
      "...ooeeoooeeooo...",
      "...ooeeoooeeooo...",
      "...oooooooooooo...",
      "...oooooooooooo...",
      "....oooooooooo....",
      "..oo.oo.oo.oo.oo..",
      ".oo..oo.oo.oo..oo.",
      "oo...o..oo..o...oo",
      "o....oo.oo.oo....o",
      "oo....o....o....oo",
      ".......oo.oo......",
    ],
  },
  domed: line(`
   ▁▁▁▁
  ╱◕  ◕╲
  ▏ ‿  ▕
  ╲┳┳┳┳╱
   ╹╹╹╹`),
  curling: line(`
  ╭──────╮
  │ ◕  ◕ │
  ╰┬┬┬┬┬┬╯
  ╲╱╲╱╲╱╲
   ╰╯ ╰╯`),
  kawaii: line(`
  ╭⌒⌒⌒╮
 ( ◕  ◕ )
  ╰╮╭╮╭╯
   ╰╯╰╯`),
  block: line(`
  ▟▀▀▀▀▀▙
  ▌ ◕  ◕ ▐
  ▙▄▄▄▄▄▟
   ▎▎ ▎▎ ▎▎`),
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
