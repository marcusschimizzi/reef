// Reef's brand art for the launch banner: the octopus mascot ("boxy mantle"
// direction) and the REEF wordmark. Kept as plain strings so the Banner
// component owns all color; re-skinning never touches the art.

/** The octopus — rounded mantle, two eyes, a fan of eight tentacles. */
export const OCTOPUS = String.raw`
 ╭───────╮
 │ ◕   ◕ │
 │   ‿   │
 ╰┬┬┬┬┬┬┬╯
  ╵╵╵╵╵╵╵
`.replace(/^\n/, "");

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
