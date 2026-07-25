import path from 'path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Set root to the directory containing this config file so that include
    // patterns resolve correctly regardless of which package invokes vitest
    // (e.g. `packages/sdk` runs `vitest --config ../../tests/vitest.config.ts`).
    root: __dirname,
    include: ['unit/**/*.test.ts', 'unit/**/*.test.tsx', 'integration/**/*.test.ts'],
    // The DEFAULT stays `node`. Only files that actually render React opt into
    // jsdom, per-file, with a `@vitest-environment jsdom` docblock — see
    // tests/unit/patterns_a11y.test.tsx and CONTRIBUTING.md § Verification
    // gates. Flipping this global to `jsdom` would put ~67 node-environment
    // suites through a full DOM construction they have no use for, and would
    // silently give SDK/Convex/service tests browser globals (`window`,
    // `localStorage`, `fetch` off `window`) that their production runtime does
    // not have — a test that passes only because jsdom supplied a global is
    // worse than no test.
    environment: 'node',
    globals: true,
    // Gated on `typeof document` inside, so node-environment files do not pay
    // for the DOM harness. See tests/setup/global.ts.
    setupFiles: ['./setup/global.ts'],
  },
  // `.tsx` test files use the automatic JSX runtime, so no `import React` is
  // needed and the transform does not depend on a tsconfig lookup.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@agent-flight-recorder/contracts': path.resolve(__dirname, '../packages/contracts/src/index.ts'),
      '@agent-flight-recorder/sdk': path.resolve(__dirname, '../packages/sdk/src/index.ts'),
      '@agent-flight-recorder/cli': path.resolve(__dirname, '../packages/cli/src/index.ts'),
      '@agent-flight-recorder/mcp': path.resolve(__dirname, '../packages/mcp/src/index.ts'),
      // Mirrors apps/web/tsconfig.json's `"@/*": ["./src/*"]` path alias, so
      // tests can import apps/web service modules that themselves use `@/lib/...`
      // imports (e.g. services/api_v1.ts importing '@/lib/convexServer') without
      // every such test needing its own ad-hoc resolution workaround.
      '@': path.resolve(__dirname, '../apps/web/src'),
      // Next.js ROUTE files (`loading.tsx`, `page.tsx`) live in `apps/web/app`,
      // outside the `@/*` -> `src/*` alias. A test that renders a route file
      // needs to import it by a stable specifier rather than a `../../..`
      // relative path, which CLAUDE.md § Imports forbids.
      '@app': path.resolve(__dirname, '../apps/web/app'),
      // `@clerk/nextjs` is an apps/web-only dependency, so the bare specifier
      // is unresolvable from `tests/` — which silently made
      // `vi.mock('@clerk/nextjs/server', ...)` a no-op (the mock id never
      // matched the id the service under test resolved, so the REAL Clerk
      // module loaded and threw on its `server-only` import). Aliasing it
      // makes test and service resolve to the same module so vi.mock binds.
      // The stub THROWS by default — see tests/stubs/clerk-server.ts for why
      // it must not quietly return a signed-in user.
      '@clerk/nextjs/server': path.resolve(__dirname, './stubs/clerk-server.ts'),
      // `next` is an apps/web-only dependency, so `next/link` is unresolvable
      // from `tests/` for the same reason `@clerk/nextjs/server` is. Unlike
      // the Clerk stub this one does NOT throw: it is a faithful pass-through
      // to an `<a>`, because the components under DOM test render Links for
      // real content and their accessibility properties (href, tabIndex,
      // aria-*, accessible name) are exactly the props it forwards. See
      // tests/stubs/next-link.tsx for why the real component is not used.
      'next/link': path.resolve(__dirname, './stubs/next-link.tsx'),
    },
  },
})
