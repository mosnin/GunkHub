/**
 * Test stub for `@clerk/nextjs/server`.
 *
 * WHY THIS EXISTS: `@clerk/nextjs` is a dependency of `apps/web` only, so it
 * lives in `apps/web/node_modules` and the bare specifier
 * `@clerk/nextjs/server` is NOT resolvable from `tests/`. That made
 * `vi.mock('@clerk/nextjs/server', ...)` in a test file a silent no-op: the
 * mock registered under an id that never matched the id the service module
 * resolved, so the REAL Clerk module loaded and blew up on its `server-only`
 * import ("This module cannot be imported from a Client Component module").
 *
 * Aliasing the specifier to this file (see tests/vitest.config.ts) makes it
 * resolvable, so both the test and the service under test resolve to the same
 * module and `vi.mock` binds correctly.
 *
 * DELIBERATELY THROWS rather than returning a fake signed-in user. A stub
 * that quietly returned `{ userId, orgId }` would make every auth-dependent
 * test look authenticated by default — exactly the kind of silent pass that
 * hides a missing auth check. A test that needs an authenticated caller must
 * say so explicitly with its own `vi.mock('@clerk/nextjs/server', ...)`.
 */

export function auth(): never {
  throw new Error(
    'tests/stubs/clerk-server.ts: @clerk/nextjs/server is stubbed in tests. ' +
      "Add an explicit vi.mock('@clerk/nextjs/server', () => ({ auth: () => ({ userId, orgId }) })) " +
      'to this test to supply the auth context it needs.',
  )
}

export function currentUser(): never {
  throw new Error(
    'tests/stubs/clerk-server.ts: @clerk/nextjs/server is stubbed in tests. ' +
      "Add an explicit vi.mock('@clerk/nextjs/server', ...) to this test.",
  )
}
