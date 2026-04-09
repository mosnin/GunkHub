import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
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
