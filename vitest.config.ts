import { defineConfig, configDefaults } from "vitest/config";

// Live tests (tests/live/**) hit the real Anthropic API and spend credits. They are
// EXCLUDED from the default `npm test` (and therefore CI) so a contributor with
// ANTHROPIC_API_KEY in their env never silently makes a network call / spends money.
// Run them deliberately with `npm run test:live` (sets REEF_LIVE_TESTS=1).
const includeLive = !!process.env.REEF_LIVE_TESTS;

export default defineConfig({
  test: {
    exclude: includeLive
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, "tests/live/**"],
  },
});
