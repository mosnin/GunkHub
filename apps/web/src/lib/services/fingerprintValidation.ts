/**
 * fingerprintValidation.ts — pure validator for the `[fingerprint]` route
 * param on GET /api/patterns/[fingerprint] ("Failure Patterns" / PREVENTION
 * feature, cycle 1).
 *
 * Deliberately dependency-free (no `next/server`, no `@clerk/nextjs/server`,
 * no Convex import) so it is unit-testable without any Next.js/Clerk/Convex
 * runtime — mirrors why apiAuthGuard.ts is split out the same way (see that
 * file's header comment and tests/unit/management_route_auth.test.ts).
 *
 * A fingerprint hash is a hex digest (SHA-256-shaped in practice, but this
 * stays permissive on length so it does not silently break if Team A's
 * fingerprinting scheme, convex/insights.ts, changes digest width later).
 * The point of validating at all is to reject obviously-malformed input
 * (path-traversal-ish segments, empty strings, whitespace) with a clean 400
 * before it ever reaches Convex — not to pin down the exact hash algorithm.
 */
const FINGERPRINT_PATTERN = /^[a-f0-9]{8,64}$/i

export function isValidFingerprint(value: string): boolean {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}
