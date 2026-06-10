// Minimal markdown splitting for the transcript: separate fenced code blocks
// (``` … ```) from surrounding prose so the renderer can box the code. Pure and
// line-based, and tolerant of an unclosed fence — while a reply streams in, a
// half-arrived code block (opening fence, no close yet) is still rendered as
// code rather than leaking ``` into the prose.

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang?: string; code: string };

/** An inline run of prose with optional emphasis. */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Parse one line of prose into styled spans: inline code (backticks), bold
 * (double star or double underscore), and italic (single star or underscore).
 * Underscore-italic requires word boundaries so snake_case identifiers aren't
 * mangled. Unterminated markers (mid-stream) fall through as literal text
 * rather than swallowing the rest of the line.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) spans.push({ text: plain });
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;

    if ((m = rest.match(/^`([^`]+)`/))) {
      flush();
      spans.push({ text: m[1]!, code: true });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*\*([^*]+?)\*\*/)) || (m = rest.match(/^__([^_]+?)__/))) {
      flush();
      spans.push({ text: m[1]!, bold: true });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\*([^*\s](?:[^*]*[^*\s])?)\*/))) {
      flush();
      spans.push({ text: m[1]!, italic: true });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^_([^_\s](?:[^_]*[^_\s])?)_/))) {
      const prev = i > 0 ? text[i - 1]! : " ";
      const after = text[i + m[0].length] ?? " ";
      if (!/\w/.test(prev) && !/\w/.test(after)) {
        flush();
        spans.push({ text: m[1]!, italic: true });
        i += m[0].length;
        continue;
      }
    }

    plain += text[i];
    i += 1;
  }
  flush();
  return spans;
}

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
