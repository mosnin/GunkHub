import { readAuthTierConfig } from './auth-tier'
import { loadClerkTesting } from './clerk-testing'

/**
 * Playwright globalSetup.
 *
 * When the authenticated tier is configured, this mints the Clerk Testing
 * Token once for the whole run (see support/clerk-testing.ts for the
 * mechanism). When it is not configured this is a no-op: the unauthenticated
 * tier must keep running exactly as it does today, with no Clerk network calls
 * and no @clerk/testing dependency required.
 *
 * The zero-coverage FAILURE is deliberately NOT raised here. Throwing in
 * globalSetup aborts the whole run before a single test executes, which would
 * take the unauthenticated tier — the only e2e signal that exists today — down
 * with it. The failure is raised by auth-coverage.spec.ts instead, so the
 * report arrives as a test result alongside the unauth results.
 */
export default async function globalSetup(): Promise<void> {
  const config = readAuthTierConfig()
  if (!config.configured) {
    return
  }

  const { clerkSetup } = await loadClerkTesting()
  // clerkSetup() reads NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY
  // from process.env itself, and writes process.env.CLERK_FAPI +
  // process.env.CLERK_TESTING_TOKEN for setupClerkTestingToken() to consume.
  await clerkSetup({ publishableKey: config.publishableKey })
}
