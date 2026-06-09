// Loads ./.env into process.env if present (Node 20.12+ / 22 built-in — no dep).
// The Anthropic provider reads ANTHROPIC_API_KEY from the environment.
export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — fine; rely on the ambient environment.
  }
}
