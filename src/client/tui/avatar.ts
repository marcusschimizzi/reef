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
  // Half-block colored sprite — the default, most "mascot"-like.
  pixel: {
    kind: "pixel",
    rows: [
      "....oooooo....",
      "..oooooooooo..",
      ".oooooooooooo.",
      "oooooooooooooo",
      "ooeeooooooeeoo",
      "ooeeooooooeeoo",
      "oooooooooooooo",
      ".oooooooooooo.",
      "..oooooooooo..",
      "..oo.oo.oo.oo.",
      "..o..o..o..o..",
      "..o..o..o..o..",
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
