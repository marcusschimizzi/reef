// Minimal markdown splitting for the transcript: separate fenced code blocks
// (``` … ```) from surrounding prose so the renderer can box the code. Pure and
// line-based, and tolerant of an unclosed fence — while a reply streams in, a
// half-arrived code block (opening fence, no close yet) is still rendered as
// code rather than leaking ``` into the prose.

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang?: string; code: string };

const FENCE = /^\s*```(.*)$/;

export function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let inCode = false;
  let lang: string | undefined;
  let buf: string[] = [];

  const flushText = (): void => {
    const joined = buf.join("\n");
    if (joined.trim() !== "") segments.push({ kind: "text", text: joined.replace(/^\n+|\n+$/g, "") });
    buf = [];
  };
  const flushCode = (): void => {
    segments.push({ kind: "code", lang, code: buf.join("\n") });
    buf = [];
    lang = undefined;
  };

  for (const line of text.split("\n")) {
    const fence = line.match(FENCE);
    if (fence) {
      if (!inCode) {
        flushText();
        inCode = true;
        lang = fence[1]?.trim().split(/\s+/)[0] || undefined;
      } else {
        flushCode();
        inCode = false;
      }
      continue;
    }
    buf.push(line);
  }
  if (inCode) flushCode(); // unclosed fence (still streaming) → render as code
  else flushText();

  return segments;
}
