// Loads ./.env into process.env if present (Node 20.12+ / 22 built-in — no dep).
// The Anthropic provider reads ANTHROPIC_API_KEY from the environment.
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — fine; rely on the ambient environment.
  }
}

// The curated set of parent env vars a spawned child legitimately needs: where to
// find binaries (PATH), the home dir (HOME — also where `claude` keeps its OAuth
// creds), locale, and terminal. Everything else — every API key and token the
// daemon holds — is withheld by default.
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "SHLVL", // shell-nesting depth — without it bash applies its "remote daemon" heuristic and sources ~/.bashrc non-interactively
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  // Network egress — NOT secrets, but the spawned `claude` (whose whole purpose is
  // reaching api.anthropic.com on-plan) and shell commands (git/npm/curl) break
  // silently without them behind a corporate proxy or custom CA.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Build the environment for a spawned child process from a curated ALLOWLIST of
 * the parent's vars — never the whole `process.env`. The daemon holds API keys and
 * tokens (it's the model-routing layer); a child it spawns (the `shell` tool's bash,
 * the PTY `claude`) has no business inheriting them. Only the vars a normal dev loop
 * needs cross the boundary; `LC_*` locale vars pass too. `extra` is merged last so a
 * caller can force values (e.g. TERM). Opt specific vars back in, per machine,
 * with `REEF_CHILD_ENV_ALLOW=NAME1,NAME2`.
 */
export function safeChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const optIn = (process.env.REEF_CHILD_ENV_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set<string>([...CHILD_ENV_ALLOWLIST, ...optIn]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allow.has(k) || k.startsWith("LC_")) env[k] = v;
  }
  return { ...env, ...extra };
}
