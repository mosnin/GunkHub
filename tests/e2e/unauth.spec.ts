import { expect, test } from '@playwright/test'

/**
 * Unauthenticated smoke tier.
 *
 * Runs against apps/web with dummy Clerk/Convex env vars (see
 * playwright.config.ts) and NO live Convex deployment. Every assertion here
 * must hold true without a real backend — that's the point: it proves the
 * frontend boots, renders, and responds correctly even when its dependencies
 * are unreachable.
 *
 * Do not add assertions here that require a signed-in session or real
 * Convex data — see auth.spec.ts for the authenticated tier and why it is
 * currently skipped.
 */

// Fake Clerk domain / dev-mode noise that is expected in this harness and is
// not a product bug. Filtered narrowly (by message text AND, where relevant,
// by the failing resource's URL) so a genuine new console error — a broken
// import, a thrown render error, a real failed fetch to our own origin —
// still fails the test.
//
// Sources, in order below:
//   1. React DevTools suggestion — present in every non-production build.
//   2. The clerk-js bundle fails to load because CLERK_PUBLISHABLE_KEY
//      resolves to a fake, non-existent Frontend API domain
//      ("clerk.e2e.invalid" — see playwright.config.ts DUMMY_ENV). This is
//      the expected shape of running without a real Clerk instance, not an
//      app bug — real deployments load this file from a real Clerk domain.
//   3. Clerk's own client SDK (@clerk/clerk-js) logs this when it cannot
//      reach its Frontend API to bootstrap — the direct consequence of (2),
//      surfaced from our bundle rather than the network request itself.
//   4. /favicon.ico 404s — apps/web has no favicon file today (pre-existing
//      gap, not introduced by this suite; not this harness's file to fix,
//      flagged to the ui team separately).
const KNOWN_CONSOLE_TEXT_NOISE = ['Download the React DevTools', 'Clerk: Failed to load Clerk']
const KNOWN_CONSOLE_URL_NOISE = ['clerk.e2e.invalid', '/favicon.ico']

function isKnownNoise(text: string, locationUrl: string): boolean {
  return (
    KNOWN_CONSOLE_TEXT_NOISE.some((needle) => text.includes(needle)) ||
    KNOWN_CONSOLE_URL_NOISE.some((needle) => locationUrl.includes(needle))
  )
}

test.describe('landing page', () => {
  test('renders hero copy and primary CTAs with no unexpected console errors', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isKnownNoise(msg.text(), msg.location().url)) {
        consoleErrors.push(`${msg.text()} (${msg.location().url})`)
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    const response = await page.goto('/')
    expect(response?.status()).toBe(200)

    await expect(page.getByRole('heading', { name: /make agent failures explainable/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: /log in/i }).first()).toBeVisible()

    expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([])
  })

  test('CTA links point at the sign-up and sign-in routes', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: /get started/i }).first()).toHaveAttribute('href', '/sign-up')
    await expect(page.getByRole('link', { name: /log in/i }).first()).toHaveAttribute('href', '/sign-in')
  })
})

test.describe('routing', () => {
  test('/sign-in responds and renders (no real Clerk instance required to load the page shell)', async ({ page }) => {
    const response = await page.goto('/sign-in')
    expect(response?.ok()).toBeTruthy()
  })

  test('unknown routes render the styled 404 page, not the default Next.js error screen', async ({ page }) => {
    const response = await page.goto('/this-route-does-not-exist-abc123')
    expect(response?.status()).toBe(404)

    await expect(page.getByText('404', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /back to dashboard/i })).toBeVisible()
  })
})

test.describe('/api/health', () => {
  test('returns a JSON body with the expected shape (degraded/ok both acceptable — no live backend)', async ({ request }) => {
    const response = await request.get('/api/health')
    // Health reports 200 (ok) or 503 (degraded/down) depending on dependency
    // reachability — both are valid responses from this endpoint's contract.
    // What must NOT happen is a 500 or a non-JSON body.
    expect([200, 503]).toContain(response.status())

    const body = await response.json()
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      storage: {
        adapter: expect.stringMatching(/^(vercel|stub)$/),
        configured: expect.any(Boolean),
      },
      environment: expect.stringMatching(/^(production|development|test)$/),
      timestamp: expect.any(String),
    })
  })
})

test.describe('security headers', () => {
  test('every response carries the standard security header set', async ({ request }) => {
    const response = await request.get('/')
    const headers = response.headers()

    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['content-security-policy-report-only']).toContain("default-src 'self'")
    expect(headers['strict-transport-security']).toContain('max-age=')
    expect(headers['x-content-type-options']).toBe('nosniff')
  })
})
