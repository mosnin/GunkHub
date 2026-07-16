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
    },
  },
})
