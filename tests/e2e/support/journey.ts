import { test as base, expect, type Page } from '@playwright/test'

/**
 * Shared helpers for the authenticated journey.
 *
 * The `serverErrors` / `pageErrors` auto-fixture is the safety net that matters
 * most for this repo. `convex/_generated/api.ts` is a hand-written `anyApi`
 * stub, so nothing type-checks the web↔backend seam: a renamed Convex function
 * or a changed argument shape compiles fine and fails only at runtime. Those
 * failures surface as a 500 from a route handler or a thrown render error —
 * both of which this fixture turns into a test failure even when the assertion
 * under test happens to still pass.
 */
export const test = base.extend<{ failureWatch: void }>({
  failureWatch: [
    async ({ page }, use) => {
      const serverErrors: string[] = []
      const pageErrors: string[] = []

      page.on('response', (response) => {
        if (response.status() >= 500) {
          serverErrors.push(`${String(response.status())} ${response.url()}`)
        }
      })
      page.on('pageerror', (error) => {
        pageErrors.push(error.message)
      })

      await use()

      expect(
        serverErrors,
        'The app returned 5xx responses during this journey. With convex/_generated/api.ts being an ' +
          'anyApi stub, a 500 here is the usual shape of a web↔Convex seam break:\n' +
          serverErrors.join('\n'),
      ).toEqual([])
      expect(pageErrors, `Uncaught errors were thrown in the page:\n${pageErrors.join('\n')}`).toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/**
 * Assert that a data-backed view is showing DATA, not one of its fallbacks.
 *
 * A silently-empty backend response is the failure mode this whole tier exists
 * to catch: the page renders, returns 200, and looks fine — it just says
 * "nothing here". Asserting the absence of the empty/error copy is what turns
 * that into a red test.
 */
export async function expectNotFallbackState(page: Page, context: string): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
    `${context}: the route-level error boundary rendered.`,
  ).toBeHidden()
  await expect(
    page.getByRole('heading', { level: 3, name: /^Failed to load/ }),
    `${context}: an ErrorState rendered instead of data.`,
  ).toBeHidden()
}

/**
 * Collect the run ids linked from the current page's run table.
 *
 * Reads hrefs rather than visible text because the visible text is a truncated
 * id and the href carries the real one.
 */
export async function collectRunIds(page: Page): Promise<string[]> {
  const hrefs = await page.locator('a[href^="/runs/"]').evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href') ?? ''),
  )
  const ids: string[] = []
  for (const href of hrefs) {
    const match = /^\/runs\/([^/?#]+)$/.exec(href)
    if (match && match[1] && !ids.includes(match[1])) {
      ids.push(match[1])
    }
  }
  return ids
}

/** Message used whenever the seeded deployment is missing data a journey needs. */
export function seedRequirement(what: string): string {
  return (
    `The authenticated tier needs ${what} in the seeded deployment, and found none.\n\n` +
    'This is NOT a reason to skip the assertion — an authenticated journey against an empty ' +
    'deployment proves nothing that the unauthenticated tier does not already prove. Seed the ' +
    'test deployment (scripts/seed.ts) against NEXT_PUBLIC_CONVEX_URL and re-run. ' +
    'See tests/e2e/README.md § Seeding the test deployment.'
  )
}
