import { test } from '@playwright/test'

/**
 * Authenticated smoke tier — SKIPPED, gap documented deliberately rather than
 * hidden.
 *
 * Why this is skipped:
 *
 * apps/web gates every app page (/dashboard, /projects, /agents, /runs,
 * /settings, /diff) behind Clerk's clerkMiddleware `auth().protect()` (see
 * apps/web/middleware.ts). To drive any of these pages end-to-end we need a
 * request that Clerk's middleware recognizes as an authenticated session.
 *
 * Investigated and ruled out for this Clerk version (@clerk/nextjs@5.7.6):
 *   - Clerk's Playwright testing-token helpers (`@clerk/testing`,
 *     `clerkSetup()` / `setupClerkTestingToken()`) bypass Cloudflare Turnstile
 *     bot detection, but they still require a REAL Clerk instance and a real
 *     CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY pair — the testing token is
 *     minted by Clerk's backend API, not synthesized locally. A dummy key
 *     (as used in the unauth tier) cannot mint one.
 *   - There is no "keyless"/offline mode in this Clerk version that issues a
 *     verifiable session without talking to clerk.com.
 *   - Faking a session by hand-crafting a Clerk session cookie/JWT is
 *     explicitly out of scope: the task instructions for this harness forbid
 *     faking auth by patching app code or forging credentials, and a
 *     hand-rolled cookie would not be validated by Clerk's real JWKS anyway
 *     (clerkMiddleware verifies signatures against Clerk's actual keys).
 *
 * What would unlock this tier:
 *   1. A real Clerk **test** instance (not production) with:
 *        - CLERK_SECRET_KEY (test instance secret key)
 *        - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (matching publishable key)
 *      provisioned as CI secrets (mirrors the existing pattern used by the
 *      `integration-test` job's CONVEX_TEST_URL / TEST_API_KEY secrets).
 *   2. A CONVEX_TEST_URL Convex deployment seeded with an org/user matching
 *      the Clerk test-instance identity, so pages that read Convex data
 *      (dashboard, projects, runs) have something real to render instead of
 *      hitting the "no backend" empty/error state.
 *   3. Add `@clerk/testing` as a devDependency, call `clerkSetup()` in a
 *      Playwright global-setup file, and use
 *      `setupClerkTestingToken({ page })` + Clerk's `signIn.create()` testing
 *      helpers (or a `POST /v1/client/sign_ins` call with a test-instance
 *      password strategy) to establish a session before each authenticated
 *      test.
 *   4. Wire `CLERK_SECRET_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` /
 *      `CONVEX_TEST_URL` into the `e2e` CI job's `env:` block, conditioned on
 *      the secrets being present (same `if: secrets.X != ''` pattern already
 *      used by `integration-test`), and remove `test.skip` below.
 *
 * Until then, this file exists so the gap is visible in the suite itself
 * rather than silently absent.
 */

test.describe('authenticated app pages', () => {
  test.skip(
    true,
    'Requires a real Clerk test instance (CLERK_SECRET_KEY + matching publishable key) plus a seeded ' +
      'CONVEX_TEST_URL deployment — see the comment at the top of this file for exactly what to provision.',
  )

  test('signed-in user lands on /dashboard and sees the app shell', async ({ page }) => {
    await page.goto('/dashboard')
  })
})
