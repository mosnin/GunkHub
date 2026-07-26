import { expect, test as setup } from '@playwright/test'

import { readAuthTierConfig, AUTH_STORAGE_STATE_PATH } from './support/auth-tier'
import { activateOrganization, loadClerkTesting } from './support/clerk-testing'

/**
 * Establishes the signed-in browser state that authenticated.spec.ts reuses.
 *
 * playwright.config.ts only creates the project that runs this file when
 * readAuthTierConfig() reports `configured`, so the guard below should be
 * unreachable — it exists so that running this file directly fails with the
 * real reason rather than a null-reference deep inside Clerk.
 *
 * Signing in is three steps, and skipping the third is the classic mistake:
 *   1. setupClerkTestingToken — bypass bot protection on Frontend API calls.
 *   2. clerk.signIn          — password first factor, then setActive({session}).
 *   3. activateOrganization  — setActive({organization}). apps/web throws
 *      "No organization selected" without an ACTIVE org on the session.
 */
setup('authenticate a Clerk test user and activate their organization', async ({ page }) => {
  const config = readAuthTierConfig()
  if (!config.configured) {
    throw new Error(
      'auth.setup.ts ran without the authenticated tier being configured. Missing: ' +
        config.missing.join(', ') +
        '. See tests/e2e/README.md § Unlocking the authenticated tier.',
    )
  }

  const { clerk, setupClerkTestingToken } = await loadClerkTesting()

  await setupClerkTestingToken({ page })

  // clerk.signIn requires a already-loaded Clerk on a NON-protected page.
  // "/" is the public landing page and mounts ClerkProvider via app/providers.tsx.
  await page.goto('/')
  await clerk.loaded({ page })

  await clerk.signIn({
    page,
    signInParams: {
      strategy: 'password',
      identifier: config.userIdentifier,
      password: config.userPassword,
    },
  })

  await activateOrganization(page, config.clerkOrgId)

  // Prove the session is genuinely usable BEFORE saving it. A storage state
  // captured from a half-established session produces a whole suite of
  // confusing downstream failures, so pay the cost of one real protected
  // navigation here.
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/dashboard(\?|$)/)
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()

  // If the org did not activate, apps/web/src/lib/auth.ts throws
  // "No organization selected" and app/(app)/error.tsx renders this heading.
  // Catching it here names the actual cause instead of letting ten journeys
  // fail with an unrelated-looking error state.
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
    'The dashboard rendered its error boundary immediately after sign-in. If the message mentions ' +
      '"No organization selected", E2E_CLERK_ORG_ID is wrong or the test user is not a member of that org.',
  ).toBeHidden()

  await page.context().storageState({ path: AUTH_STORAGE_STATE_PATH })
})
