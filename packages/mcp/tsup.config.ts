import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  // The published bin must be directly executable: an MCP client spawns
  // `afr-mcp` as a subprocess, not via `node dist/index.js`.
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
})
