import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  // The published bin must be directly executable (`afr` on PATH).
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
})
