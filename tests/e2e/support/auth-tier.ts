import * as path from 'node:path'

/**
 * Configuration detection for the AUTHENTICATED e2e tier.
 *
 * This module is the single source of truth for "is the authenticated tier
 * runnable right now?", and it is imported by three places that must agree:
 *
 *   - playwright.config.ts   — decides whether to create the authenticated
 *                              projects at all, and what env the webServer
 *                              gets (real credentials vs. dummies).
 *   - auth.setup.ts          — establishes the signed-in storage state.
 *   - auth-coverage.spec.ts  — FAILS the run when the tier is unconfigured,
 *                              so "no authenticated coverage" is reported as
 *                              information rather than as silence.
 *
 * It deliberately contains no Playwright imports so playwright.config.ts can
 * import it before the test runner has bootstrapped.
 */

/** Absolute path of the signed-in storage state produced by auth.setup.ts. */
export const AUTH_STORAGE_STATE_PATH = path.join(__dirname, '..', '.auth', 'authenticated-state.json')

/**
 * Escape hatch. Setting this to "1" downgrades the zero-coverage failure in
 * auth-coverage.spec.ts to a non-fatal annotation.
 *
 * This is an ACKNOWLEDGEMENT OF ZERO COVERAGE, not a fix. It exists so a team
 * can consciously accept the gap for a window of time; it must never be set
 * "to make CI green" and then forgotten. The suite still prints the full
 * zero-coverage report either way.
 */
export const ACK_NO_AUTH_COVERAGE_ENV = 'AFR_E2E_ACK_NO_AUTH_COVERAGE'

/**
 * Every env var the authenticated tier needs, with why it is needed.
 * Order here is the order they are reported in when missing.
 */
export const AUTH_TIER_ENV_VARS = [
  {
    name: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    why: 'Publishable key of a Clerk DEVELOPMENT instance (pk_test_…). Testing Tokens only work on development instances — clerkSetup() throws on a production key.',
  },
  {
    name: 'CLERK_SECRET_KEY',
    why: 'Secret key of the SAME Clerk development instance (sk_test_…). clerkSetup() exchanges it for a Testing Token via the Clerk Backend API.',
  },
  {
    name: 'NEXT_PUBLIC_CONVEX_URL',
    why: 'A real Convex deployment URL. Without it every page renders its empty/error state and the journey asserts nothing about real data.',
  },
  {
    name: 'E2E_CLERK_USER_USERNAME',
    why: 'Identifier (email or username) of a seeded Clerk test user. Clerk\'s documented name for this var in their Playwright guide.',
  },
  {
    name: 'E2E_CLERK_USER_PASSWORD',
    why: 'Password for that test user, used with the `password` first-factor strategy.',
  },
  {
    name: 'E2E_CLERK_ORG_ID',
    why: 'Clerk organization id (org_…) the test user belongs to. apps/web/src/lib/auth.ts throws "No organization selected" unless the SESSION has an ACTIVE org, so signing in is not sufficient — the org must be activated.',
  },
] as const

/**
 * Placeholder values that are present but meaningless. These are the dummies
 * playwright.config.ts and the `e2e` CI job supply for the unauthenticated
 * tier; treating them as "configured" would produce exactly the false signal
 * this tier exists to prevent.
 */
const KNOWN_PLACEHOLDERS = [
  'pk_test_Y2xlcmsuZTJlLmludmFsaWQk',
  'sk_test_dummy00000000000000000000000000000000000000000',
  'https://example-e2e-placeholder.convex.cloud',
  'pk_test_replace_me',
  'sk_test_replace_me',
]

/** The journeys the authenticated tier covers. Kept here so the zero-coverage
 * report can enumerate exactly what did NOT run. Must stay in sync with the
 * `test(...)` titles in authenticated.spec.ts. */
export const AUTHENTICATED_JOURNEYS = [
  'app shell renders for a signed-in user with an active organization',
  'dashboard renders real org data (not the no-runs zero state)',
  'runs list renders real runs (not the empty state)',
  'run detail renders the event trace for the run opened from the list',
  'event inspector renders a real payload for a selected event',
  'replay renders derived frames and declares itself a projection',
  'diff compares two real runs and reports a summary',
  'failure patterns list renders and links through to pattern detail',
  'resolution lifecycle round-trips through the server and survives a reload',
  'unknown run id renders the 404 page rather than a blank shell',
] as const

export interface AuthTierConfigured {
  readonly configured: true
  readonly publishableKey: string
  readonly secretKey: string
  readonly convexUrl: string
  readonly userIdentifier: string
  readonly userPassword: string
  readonly clerkOrgId: string
}

export interface AuthTierUnconfigured {
  readonly configured: false
  /** Names of vars that are unset, empty, or set to a known placeholder. */
  readonly missing: readonly string[]
  /** Names of vars that are set to something real. */
  readonly present: readonly string[]
  /** Non-fatal problems worth reporting even when nothing is missing. */
  readonly warnings: readonly string[]
}

export type AuthTierConfig = AuthTierConfigured | AuthTierUnconfigured

function readVar(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (KNOWN_PLACEHOLDERS.includes(value)) return undefined
  return value
}

/**
 * Determine whether the authenticated tier can run.
 *
 * A var counts as missing when it is unset, empty, or still holding one of the
 * documented placeholder values.
 */
export function readAuthTierConfig(): AuthTierConfig {
  const missing: string[] = []
  const present: string[] = []
  const warnings: string[] = []

  const values = new Map<string, string>()
  for (const spec of AUTH_TIER_ENV_VARS) {
    const value = readVar(spec.name)
    if (value === undefined) {
      missing.push(spec.name)
    } else {
      present.push(spec.name)
      values.set(spec.name, value)
    }
  }

  // Testing Tokens are a development-instance feature. A production key is
  // "present" but unusable, so surface it as a hard miss rather than letting
  // clerkSetup() fail later with a less actionable message.
  const publishableKey = values.get('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')
  const secretKey = values.get('CLERK_SECRET_KEY')
  if (publishableKey !== undefined && !publishableKey.startsWith('pk_test_')) {
    warnings.push(
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not a pk_test_ key. Clerk Testing Tokens only work on DEVELOPMENT instances; a pk_live_ key cannot drive this tier.',
    )
  }
  if (secretKey !== undefined && !secretKey.startsWith('sk_test_')) {
    warnings.push(
      'CLERK_SECRET_KEY is not an sk_test_ key. clerkSetup() throws on a production secret key ("Testing Tokens only work in development instances").',
    )
  }
  const orgId = values.get('E2E_CLERK_ORG_ID')
  if (orgId !== undefined && !orgId.startsWith('org_')) {
    warnings.push('E2E_CLERK_ORG_ID does not look like a Clerk organization id (expected an "org_…" value).')
  }

  if (missing.length > 0 || warnings.length > 0) {
    return { configured: false, missing, present, warnings }
  }

  return {
    configured: true,
    // Non-null assertions are unnecessary: missing.length === 0 proves every
    // var resolved, and the `?? ''` is unreachable but keeps this total.
    publishableKey: publishableKey ?? '',
    secretKey: secretKey ?? '',
    convexUrl: values.get('NEXT_PUBLIC_CONVEX_URL') ?? '',
    userIdentifier: values.get('E2E_CLERK_USER_USERNAME') ?? '',
    userPassword: values.get('E2E_CLERK_USER_PASSWORD') ?? '',
    clerkOrgId: orgId ?? '',
  }
}

/**
 * Render the human-readable zero-coverage report.
 *
 * This is the text a developer sees when the authenticated tier did not run.
 * It has to answer, without any further digging: what did NOT get tested, why
 * not, and exactly what to provision.
 */
export function renderZeroCoverageReport(config: AuthTierUnconfigured): string {
  const lines: string[] = []

  lines.push('AUTHENTICATED E2E COVERAGE: 0 of ' + String(AUTHENTICATED_JOURNEYS.length) + ' journeys executed.')
  lines.push('')
  lines.push('This run exercised the UNAUTHENTICATED tier only. Everything behind Clerk auth —')
  lines.push('the entire product — was not loaded by a browser in this run. Treat a green e2e')
  lines.push('result as covering the marketing surface and nothing else.')
  lines.push('')
  lines.push('Journeys with ZERO coverage:')
  for (const journey of AUTHENTICATED_JOURNEYS) {
    lines.push('  ✗ ' + journey)
  }
  lines.push('')

  if (config.missing.length > 0) {
    lines.push('Missing or placeholder environment variables:')
    for (const name of config.missing) {
      const spec = AUTH_TIER_ENV_VARS.find((entry) => entry.name === name)
      lines.push('  - ' + name)
      if (spec) lines.push('      ' + spec.why)
    }
    lines.push('')
  }

  if (config.present.length > 0) {
    lines.push('Already configured: ' + config.present.join(', '))
    lines.push('')
  }

  if (config.warnings.length > 0) {
    lines.push('Configuration problems:')
    for (const warning of config.warnings) {
      lines.push('  ! ' + warning)
    }
    lines.push('')
  }

  lines.push('To provision: see tests/e2e/README.md § Unlocking the authenticated tier.')
  lines.push('')
  lines.push(
    'To consciously accept zero authenticated coverage for now, set ' +
      ACK_NO_AUTH_COVERAGE_ENV +
      '=1. That silences the failure but NOT this report — it records the gap, it does not close it.',
  )

  return lines.join('\n')
}
