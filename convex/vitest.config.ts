import { defineConfig } from 'vitest/config'

// Dedicated config for backend tests that exercise the REAL Convex functions via
// the convex-test harness. Requires the edge-runtime environment (Convex's server
// runtime) and convex-test inlined so its import.meta.glob resolves this package's
// modules. Kept separate from tests/vitest.config.ts (node env, product-type tests).
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['**/*.test.ts'],
    globals: true,
  },
})
