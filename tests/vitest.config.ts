import path from 'path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Set root to the directory containing this config file so that include
    // patterns resolve correctly regardless of which package invokes vitest
    // (e.g. `packages/sdk` runs `vitest --config ../../tests/vitest.config.ts`).
    root: __dirname,
    include: ['unit/**/*.test.ts', 'integration/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@agent-flight-recorder/contracts': path.resolve(__dirname, '../packages/contracts/src/index.ts'),
      '@agent-flight-recorder/sdk': path.resolve(__dirname, '../packages/sdk/src/index.ts'),
      '@agent-flight-recorder/cli': path.resolve(__dirname, '../packages/cli/src/index.ts'),
      // Mirrors apps/web/tsconfig.json's `"@/*": ["./src/*"]` path alias, so
      // tests can import apps/web service modules that themselves use `@/lib/...`
      // imports (e.g. services/api_v1.ts importing '@/lib/convexServer') without
      // every such test needing its own ad-hoc resolution workaround.
      '@': path.resolve(__dirname, '../apps/web/src'),
      // `@clerk/nextjs` is an apps/web-only dependency, so the bare specifier
      // is unresolvable from `tests/` — which silently made
      // `vi.mock('@clerk/nextjs/server', ...)` a no-op (the mock id never
      // matched the id the service under test resolved, so the REAL Clerk
      // module loaded and threw on its `server-only` import). Aliasing it
      // makes test and service resolve to the same module so vi.mock binds.
      // The stub THROWS by default — see tests/stubs/clerk-server.ts for why
      // it must not quietly return a signed-in user.
      '@clerk/nextjs/server': path.resolve(__dirname, './stubs/clerk-server.ts'),
    },
  },
})
