// Shell-command safety for the approval policy. The hard floor for auto-allowing
// a command is a POSITIVE character whitelist, not a metacharacter blacklist — a
// blacklist forgets a vector, a whitelist can only admit what it names. Only the
// plainest commands (words, flags, paths) are eligible; anything carrying a
// chaining/redirection/substitution/quoting/escaping character (; && | > ` $( \
// " ' newline …) fails the whitelist and is never auto-allowed — it falls
// through to the normal gate. On top of that floor, an allowlist matches on the
// PARSED argv tokens (not a string/regex prefix), so `["git","diff"]` admits
// `git diff --stat` but not `git push` and not `git diff && rm -rf x`.

// Plain words, flags, paths, simple --flag=value. Deliberately excludes every
// shell-significant character (and quotes/backslash/tilde/glob) by omission.
const SAFE_COMMAND = /^[A-Za-z0-9 _./@=:-]+$/;

/** Is this command plain enough to even be considered for auto-allow? */
export function isStructurallySafe(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && SAFE_COMMAND.test(trimmed);
}

/** Tokenize a structurally-safe command into argv (whitespace split). */
export function argvOf(command: string): string[] {
  return command.trim().split(/\s+/);
}

/** Does argv begin with every token of `prefix`? An empty prefix never matches
 *  (it would admit everything — a footgun, refused here and at config load). */
export function argvHasPrefix(argv: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((tok, i) => argv[i] === tok);
}

/**
 * Eligible for auto-allow iff the command passes the structural whitelist AND
 * its parsed argv starts with one of the allowed prefixes. Both layers must
 * hold; the whitelist is the non-negotiable floor.
 */
export function commandMatchesAllowlist(command: string, prefixes: string[][]): boolean {
  if (!isStructurallySafe(command)) return false;
  const argv = argvOf(command);
  return prefixes.some((prefix) => argvHasPrefix(argv, prefix));
}
