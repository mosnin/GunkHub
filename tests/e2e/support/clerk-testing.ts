import type { Page } from '@playwright/test'

/**
 * Loader for `@clerk/testing/playwright` — Clerk's OFFICIAL Playwright
 * integration. We follow it rather than inventing an auth bypass.
 *
 * How Clerk's approach works (verified against @clerk/testing@1.4.4's shipped
 * `dist/playwright/index.js`, the last line whose `@clerk/backend` dependency
 * shares a major with this repo's @clerk/backend@1.14.1):
 *
 *   1. `clerkSetup()` runs ONCE in Playwright's globalSetup. It reads
 *      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY, calls
 *      `createClerkClient().testingTokens.createTestingToken()` against the
 *      Clerk Backend API, and exports the result as `process.env.CLERK_FAPI`
 *      and `process.env.CLERK_TESTING_TOKEN`. It throws outright on a
 *      production secret key — Testing Tokens are development-instance only.
 *   2. `setupClerkTestingToken({ page })` installs a `page.route()` interceptor
 *      on `https://<CLERK_FAPI>/v1/**` that appends `__clerk_testing_token` to
 *      every Frontend API request, which is what bypasses bot protection.
 *   3. `clerk.signIn({ page, signInParams })` evaluates in the page against
 *      `window.Clerk.client.signIn` and then `window.Clerk.setActive({ session })`.
 *
 * WHY THIS IS A DYNAMIC IMPORT RATHER THAN A NORMAL ONE
 * `@clerk/testing` is not currently a dependency of this repo (it is not in
 * pnpm-lock.yaml). A static `import … from '@clerk/testing/playwright'` would
 * fail `pnpm typecheck` for everyone, including the many contributors who only
 * ever run the unauthenticated tier. Resolving it through a non-literal
 * specifier keeps the module out of the type graph until it is actually
 * installed, and lets us fail with an actionable message instead of an opaque
 * MODULE_NOT_FOUND.
 *
 * Adding the dependency is step 3 of tests/e2e/README.md § Unlocking the
 * authenticated tier.
 */

/** Minimal structural types for the three helpers we use. */
interface ClerkSignInParams {
  strategy: 'password'
  identifier: string
  password: string
}

interface ClerkTestingPlaywrightModule {
  clerkSetup: (options?: { publishableKey?: string; frontendApiUrl?: string; debug?: boolean }) => Promise<void>
  setupClerkTestingToken: (params: { page: Page }) => Promise<void>
  clerk: {
    signIn: (opts: { page: Page; signInParams: ClerkSignInParams }) => Promise<void>
    signOut: (opts: { page: Page }) => Promise<void>
    loaded: (opts: { page: Page }) => Promise<void>
  }
}

/** Split so TypeScript cannot statically resolve the specifier. */
const CLERK_TESTING_SPECIFIER = ['@clerk', 'testing', 'playwright'].join('/')

const INSTALL_HINT =
  `Cannot load "${CLERK_TESTING_SPECIFIER}" — the authenticated e2e tier needs Clerk's official ` +
  'Playwright integration, which is not installed in this repo.\n\n' +
  'Install it as a devDependency of the tests package, pinned to the Clerk v5-compatible line:\n' +
  '    pnpm --filter @agent-flight-recorder/tests add -D @clerk/testing@^1.4.4\n\n' +
  'Do NOT install @clerk/testing@2.x here: it depends on @clerk/backend ^3.x and targets clerk-js v6+, ' +
  'while apps/web pins @clerk/nextjs@5.7.6 (@clerk/backend 1.14.1, @clerk/clerk-react 5.12.0). ' +
  'Its browser helpers drive a window.Clerk API this app does not ship.\n\n' +
  'See tests/e2e/README.md § Unlocking the authenticated tier.'

let cached: ClerkTestingPlaywrightModule | undefined

/**
 * Load `@clerk/testing/playwright`, or throw a message that says exactly what
 * to install and why. Never returns a stub — a stubbed auth helper would let
 * the authenticated tier "pass" without ever authenticating.
 */
export async function loadClerkTesting(): Promise<ClerkTestingPlaywrightModule> {
  if (cached) return cached

  let loaded: unknown
  try {
    loaded = await import(CLERK_TESTING_SPECIFIER)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${INSTALL_HINT}\n\nUnderlying resolution error: ${detail}`)
  }

  const candidate = loaded as Partial<ClerkTestingPlaywrightModule>
  if (
    typeof candidate.clerkSetup !== 'function' ||
    typeof candidate.setupClerkTestingToken !== 'function' ||
    typeof candidate.clerk?.signIn !== 'function'
  ) {
    throw new Error(
      `"${CLERK_TESTING_SPECIFIER}" resolved but does not export the expected helpers ` +
        '(clerkSetup, setupClerkTestingToken, clerk.signIn). This usually means an incompatible ' +
        `major version is installed.\n\n${INSTALL_HINT}`,
    )
  }

  cached = candidate as ClerkTestingPlaywrightModule
  return cached
}

/**
 * Activate a Clerk organization on the current session.
 *
 * REQUIRED, and easy to miss: `clerk.signIn()` only calls
 * `setActive({ session })`. It never sets an active ORGANIZATION. But
 * `apps/web/src/lib/auth.ts` does:
 *
 *     if (!session.orgId) throw new Error('No organization selected')
 *
 * so every org-scoped service call fails for a signed-in user whose session has
 * no active org. Without this step the authenticated tier would sign in
 * successfully and then fail on every page with an error state — which is a
 * far more confusing failure than a missing credential.
 */
export async function activateOrganization(page: Page, clerkOrgId: string): Promise<void> {
  await page.evaluate(async (organizationId: string) => {
    const clerkGlobal = (window as unknown as {
      Clerk?: { setActive?: (opts: { organization: string }) => Promise<void> }
    }).Clerk
    if (!clerkGlobal?.setActive) {
      throw new Error('window.Clerk.setActive is unavailable — Clerk did not finish loading on this page.')
    }
    await clerkGlobal.setActive({ organization: organizationId })
  }, clerkOrgId)
}
