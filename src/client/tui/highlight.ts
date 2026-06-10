// A lightweight, dependency-free syntax tokenizer for the code-block renderer.
// Ink colors per-<Text>, not via embedded ANSI, so we tokenize into typed spans
// the component maps to theme colors. This is a *tasteful* highlight (comments,
// strings, numbers, a cross-language keyword set) — not a real grammar. It is
// line-based and tolerant of unterminated strings (a reply may stream in).

export type TokenClass = "comment" | "string" | "number" | "keyword" | "plain";

export interface Token {
  text: string;
  cls: TokenClass;
}

// A pragmatic union across the languages reef tends to write.
const KEYWORDS = new Set([
  "const", "let", "var", "function", "fn", "def", "lambda", "return", "yield",
  "async", "await", "if", "else", "elif", "for", "while", "do", "switch", "case",
  "match", "break", "continue", "class", "struct", "interface", "enum", "type",
  "impl", "trait", "extends", "implements", "new", "this", "self", "super",
  "import", "from", "export", "use", "mod", "package", "public", "private",
  "protected", "static", "final", "mut", "pub", "try", "catch", "except",
  "finally", "raise", "throw", "typeof", "instanceof", "in", "of", "is", "as",
  "and", "or", "not", "void", "null", "nil", "None", "True", "False", "true",
  "false", "with", "pass", "del", "global", "where", "then", "fi", "done",
  "echo", "local", "namespace", "readonly",
]);

// Languages whose line comments start with '#'. Others use '//'.
const HASH_LANGS = new Set([
  "py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "rb", "ruby",
  "toml", "ini", "r", "perl", "pl", "makefile", "dockerfile", "conf",
]);

export function usesHashComments(lang?: string): boolean {
  return lang ? HASH_LANGS.has(lang.toLowerCase()) : false;
}

export function tokenizeLine(line: string, opts: { hash?: boolean } = {}): Token[] {
  const tokens: Token[] = [];
  const push = (text: string, cls: TokenClass): void => {
    if (text) tokens.push({ text, cls });
  };

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);

    // Line comment to end-of-line.
    if (rest.startsWith("//") || (opts.hash && rest.startsWith("#"))) {
      push(rest, "comment");
      break;
    }

    // String literal (single/double/backtick); closing quote optional (streaming).
    const str = rest.match(/^(['"`])(?:\\.|(?!\1)[^\\])*\1?/);
    if (str) {
      push(str[0], "string");
      i += str[0].length;
      continue;
    }

    // Number (int/float/exponent, or 0x/0b/0o).
    if (/^\d/.test(rest)) {
      const num = rest.match(/^0[xXbBoO][0-9a-fA-F_]+|^\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?/);
      if (num) {
        push(num[0], "number");
        i += num[0].length;
        continue;
      }
    }

    // Identifier / keyword.
    const ident = rest.match(/^[A-Za-z_$][\w$]*/);
    if (ident) {
      push(ident[0], KEYWORDS.has(ident[0]) ? "keyword" : "plain");
      i += ident[0].length;
      continue;
    }

    // Anything else — punctuation, whitespace — one char at a time.
    push(rest[0] as string, "plain");
    i += 1;
  }

  return tokens;
}
