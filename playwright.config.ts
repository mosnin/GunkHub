import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineConfig, devices } from '@playwright/test'

import { AUTH_STORAGE_STATE_PATH, readAuthTierConfig } from './tests/e2e/support/auth-tier'

/**
 * Playwright suite for apps/web, in two tiers.
 *
 * UNAUTHENTICATED TIER (always runs, unchanged)
 * Proves the frontend actually renders and responds in a real browser with NO
 * live Convex deployment and NO real Clerk credentials — dummy values are
 * supplied below (and mirrored in the `e2e` job of .github/workflows/ci.yml).
 *
 * AUTHENTICATED TIER (runs when credentials are present)
 * Drives the signed-in product: run trace, event inspector, replay, diff,
 * failure patterns, resolution lifecycle. Gated on readAuthTierConfig(); see
 * tests/e2e/README.md for what to provision. When it is NOT configured,
 * tests/e2e/auth-coverage.spec.ts FAILS the run with a zero-coverage report
 * rather than skipping quietly.
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

const authTier = readAuthTierConfig()

// THE CONFIG-LEVEL BLOCKER THIS BRANCH FIXES.
//
// Playwright spawns the webServer with `{ ...process.env, ...webServer.env }`
// (playwright/lib/plugins/webServerPlugin.js) — the config's `env` WINS over
// the ambient environment. So before this change, exporting a real
// CLERK_SECRET_KEY / NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / NEXT_PUBLIC_CONVEX_URL
// had no effect whatsoever: DUMMY_ENV overwrote all three and `next start`
// always came up pointed at a fake Clerk domain and a placeholder Convex URL.
// Provisioning credentials alone would NOT have unblocked the authenticated
// tier; this passthrough is what makes them take effect.
const WEB_SERVER_ENV = authTier.configured
  ? {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: authTier.publishableKey,
      CLERK_SECRET_KEY: authTier.secretKey,
      NEXT_PUBLIC_CONVEX_URL: authTier.convexUrl,
    }
  : DUMMY_ENV

// The dev-browser cookie fixture that lets the UNAUTHENTICATED tier reach the
// app at all (see tests/e2e/fixtures/README.md). It is scoped to that tier
// only: against a real Clerk development instance the handshake completes for
// real, and a hand-seeded placeholder token has no business being in the jar.
const DEV_BROWSER_STORAGE_STATE = path.join(__dirname, 'tests/e2e/fixtures/dev-browser-storage-state.json')

const chromiumUse = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
    // Sandboxed/CI runners export HTTPS_PROXY for an outbound egress proxy
    // that only serves real external hosts. Chromium's own environment-based
    // proxy detection will otherwise route our *localhost* webServer traffic
    // through it too, producing ERR_CONNECTION_RESET /
    // ERR_CERT_AUTHORITY_INVALID. Forcing `--proxy-server=direct://` as a CLI
    // flag guarantees it wins over env-based detection, which the higher-level
    // `use.proxy` option was not reliably doing.
    //
    // NOTE for the authenticated tier: Clerk's Frontend API is an EXTERNAL
    // host, so a sandbox that requires the egress proxy for external traffic
    // cannot run that tier with this flag. On a normal CI runner (no forced
    // proxy) `direct://` is simply "no proxy" and external hosts resolve fine.
    args: ['--proxy-server=direct://', '--no-sandbox'],
  },
}

type ProjectConfig = NonNullable<Parameters<typeof defineConfig>[0]['projects']>[number]

const projects: ProjectConfig[] = [
  {
    // Unchanged from before this branch: same browser, same storage state,
    // same specs. This is the only e2e signal that exists today and it keeps
    // passing exactly as it did.
    name: 'chromium',
    testMatch: /unauth\.spec\.ts$/,
    use: { ...chromiumUse, storageState: DEV_BROWSER_STORAGE_STATE },
  },
  {
    // Always present, in both configured and unconfigured runs, so the run
    // always states its authenticated coverage explicitly. Needs no browser
    // state — it asserts about the shape of the run, not about the app.
    name: 'auth-coverage',
    testMatch: /auth-coverage\.spec\.ts$/,
    use: { ...chromiumUse, storageState: undefined },
  },
]

if (authTier.configured) {
  projects.push(
    {
      name: 'authenticated-setup',
      testMatch: /auth\.setup\.ts$/,
      // Starts from a clean jar: the real Clerk handshake issues its own
      // __clerk_db_jwt, and the placeholder fixture would only get in the way.
      use: { ...chromiumUse, storageState: undefined },
    },
    {
      name: 'authenticated',
      testMatch: /authenticated\.spec\.ts$/,
      dependencies: ['authenticated-setup'],
      use: { ...chromiumUse, storageState: AUTH_STORAGE_STATE_PATH },
    },
  )
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
  // Mints the Clerk Testing Token once per run when the authenticated tier is
  // configured; a no-op otherwise, so the unauthenticated tier needs neither
  // @clerk/testing nor any Clerk network access. It deliberately does not
  // throw when unconfigured — aborting globalSetup would take the passing
  // unauthenticated tier down with it. auth-coverage.spec.ts raises that
  // failure instead, as a test result.
  globalSetup: require.resolve('./tests/e2e/support/global-setup'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // storageState is set PER PROJECT rather than here, because the two tiers
    // need different jars: the unauthenticated tier needs the placeholder
    // dev-browser cookie (see tests/e2e/fixtures/README.md — without it,
    // clerkMiddleware 307s every request to a fake Clerk domain and nothing
    // renders), while the authenticated tier needs the real signed-in state
    // that auth.setup.ts produces.
  },
  projects,
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
    env: WEB_SERVER_ENV,
  },
})
