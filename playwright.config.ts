import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright smoke suite for apps/web.
 *
 * Scope: proves the frontend actually renders and responds in a real browser.
 * It runs against apps/web with NO live Convex deployment and NO real Clerk
 * credentials — dummy values are supplied below (and mirrored in the `e2e`
 * job of .github/workflows/ci.yml). See tests/e2e/auth.spec.ts for the tier
 * breakdown (unauthenticated vs. authenticated) and exactly what unlocking
 * the authenticated tier would require.
 *
 * Local sandbox: Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH
 * (/opt/pw-browsers) and `playwright install` must NOT be run — see
 * chromiumExecutablePath below. CI installs its own browser via
 * `playwright install --with-deps chromium` (no /opt/pw-browsers there), so
 * the executablePath override is conditional on the file actually existing.
 */

const PORT = 3000
const BASE_URL = `http://localhost:${PORT}`

// Local sandbox ships a prebuilt Chromium outside node_modules; CI installs
// its own. Only override executablePath when the sandbox binary is present,
// so the same config works in both environments without edits.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium'
const chromiumExecutablePath = fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined

// Dummy credentials — never real secrets. These satisfy env.ts's startup
// validation (NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / NEXT_PUBLIC_CONVEX_URL) and
// Clerk's own "missing secretKey" guard in clerkMiddleware, without talking to
// a real Clerk or Convex backend. Kept in sync with the `e2e` job's `env:`
// block in .github/workflows/ci.yml.
const DUMMY_ENV = {
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_Y2xlcmsuZTJlLmludmFsaWQk', // decodes to "clerk.e2e.invalid$"
  CLERK_SECRET_KEY: 'sk_test_dummy00000000000000000000000000000000000000000',
  NEXT_PUBLIC_CONVEX_URL: 'https://example-e2e-placeholder.convex.cloud',
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  // CI additionally writes an HTML report so a failure's trace/screenshots
  // are inspectable from the `playwright-report` artifact the `e2e` CI job
  // uploads (see .github/workflows/ci.yml) — local runs skip it to avoid the
  // "Serving HTML report" prompt after every run.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // clerkMiddleware (dev instance keys) redirects any request lacking the
    // `__clerk_db_jwt` "dev browser" cookie to the Frontend API for a
    // handshake — a real network round trip that a fake pk_test_ domain can
    // never complete. Pre-seeding this cookie via storageState satisfies
    // clerkMiddleware's `hasDevBrowserToken` check (see
    // @clerk/backend authenticateRequestWithTokenInCookie) so it skips
    // straight to serving the page instead of redirecting off-box. The value
    // is an arbitrary non-secret placeholder — Clerk never validates it
    // beyond presence for this branch. See tests/e2e/fixtures/README.md.
    storageState: path.join(__dirname, 'tests/e2e/fixtures/dev-browser-storage-state.json'),
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
          // Sandboxed/CI runners export HTTPS_PROXY for an outbound egress
          // proxy that only serves real external hosts. Chromium's own
          // environment-based proxy detection will otherwise route our
          // *localhost* webServer traffic through it too, producing
          // ERR_CONNECTION_RESET / ERR_CERT_AUTHORITY_INVALID. This suite only
          // ever talks to localhost, so force every launched browser to skip
          // proxy resolution entirely via an explicit CLI flag — passing this
          // as `--proxy-server` guarantees it wins over env-based detection,
          // which the higher-level `use.proxy` option was not reliably doing.
          args: ['--proxy-server=direct://', '--no-sandbox'],
        },
      },
    },
  ],
  // Build once, then `next start` against the production build — closer to
  // real deployment behavior than `next dev`, and avoids HMR/dev-overlay
  // noise in console-error assertions. `reuseExistingServer` lets a developer
  // point the suite at a server they already have running locally (dev or
  // start) without waiting for a rebuild.
  webServer: {
    command: 'pnpm --filter @agent-flight-recorder/web run build && pnpm --filter @agent-flight-recorder/web run start',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: DUMMY_ENV,
  },
})
