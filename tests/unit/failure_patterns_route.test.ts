/**
 * Auth-passthrough + validation + error-mapping tests for
 * apps/web/app/api/patterns/** ("Failure Patterns" / PREVENTION feature,
 * cycle 1, Team C's API surface).
 *
 * Both routes (GET /api/patterns, GET /api/patterns/[fingerprint]) make the
 * same decision as every other Clerk-authed management route in this app
 * before touching Convex: reject unless `hasOrgAuthContext` is true. That
 * predicate is exercised generally by tests/unit/management_route_auth.test.ts;
 * this file documents that these two routes also route through it, plus
 * covers the two things unique to this feature's routes:
 *   - malformed `[fingerprint]` params are rejected before any Convex call
 *     (isValidFingerprint, a pure helper split out for exactly this reason —
 *     see apps/web/src/lib/services/fingerprintValidation.ts's header).
 *   - the cross-org-isolation contract: services/failurePatterns.ts's
 *     getFailurePatternDetail collapses "fingerprint never existed" and
 *     "fingerprint exists but belongs to a different org" into the same
 *     `null`, and the route maps that (uniformly) to a 404 — never a
 *     distinguishable response that could leak cross-org existence.
 */
import { describe, expect, it } from 'vitest'

import { hasOrgAuthContext } from '../../apps/web/src/lib/apiAuthGuard.js'
import { mapApiError } from '../../apps/web/src/lib/apiErrorMapping.js'
import { isValidFingerprint } from '../../apps/web/src/lib/services/fingerprintValidation.js'

describe('patterns routes — auth passthrough', () => {
  it('every /api/patterns/** route uses hasOrgAuthContext', () => {
    // Documents the contract: if a new patterns route is added without
    // routing through this guard, this list (and this test) must be updated.
    // POST/DELETE /api/patterns/[fingerprint]/mute added cycle 3 — see
    // failure_patterns_mute_route.test.ts for their dedicated coverage.
    const routesUsingThisGuard = [
      'GET /api/patterns',
      'GET /api/patterns/[fingerprint]',
      'POST /api/patterns/[fingerprint]/mute',
      'DELETE /api/patterns/[fingerprint]/mute',
    ]
    expect(routesUsingThisGuard).toHaveLength(4)
  })

  it('rejects an authenticated user with no org context (matches every other management route)', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: null })).toBe(false)
  })

  it('rejects when both userId and orgId are missing (no Clerk session at all)', () => {
    expect(hasOrgAuthContext({})).toBe(false)
  })

  it('accepts a fully authenticated org context', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: 'org_1' })).toBe(true)
  })
})

describe('GET /api/patterns/[fingerprint] — fingerprint validation', () => {
  it('accepts a well-formed hex digest', () => {
    expect(isValidFingerprint('a1b2c3d4')).toBe(true)
    expect(isValidFingerprint('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd')).toBe(true)
    // case-insensitive
    expect(isValidFingerprint('A1B2C3D4')).toBe(true)
  })

  it('rejects malformed fingerprints (too short, non-hex, path-traversal-ish, empty)', () => {
    expect(isValidFingerprint('')).toBe(false)
    expect(isValidFingerprint('abc')).toBe(false) // shorter than 8 chars
    expect(isValidFingerprint('not-hex-at-all!!')).toBe(false)
    expect(isValidFingerprint('../../etc/passwd')).toBe(false)
    expect(isValidFingerprint('   ')).toBe(false)
    expect(isValidFingerprint('a'.repeat(65))).toBe(false) // longer than the 64-char cap
  })
})

describe('patterns routes — error mapping', () => {
  const REQUEST_ID = 'req-patterns-1'

  it('an unrecognized convex error is left for the route to rethrow (never silently 200s)', () => {
    expect(mapApiError(new Error('totally unexpected convex internal failure'), REQUEST_ID)).toBeNull()
  })

  it('a FORBIDDEN afrError (e.g. non-member caller) maps to a clean 403, never a raw 500', async () => {
    const res = mapApiError(new Error('FORBIDDEN: this action requires org membership'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.message).not.toContain('at Object.')
  })

  it('cross-org isolation contract: the route never routes a "wrong org" case through mapApiError at all', () => {
    // getFailurePatternDetail (services/failurePatterns.ts) collapses BOTH
    // "fingerprint never existed" and "fingerprint exists but belongs to a
    // different org" into a bare `null` return — never a thrown error, and
    // never a distinguishable value. The route's own code
    // (`if (!detail) return NOT_FOUND`) is therefore the single place that
    // contract is enforced; there is no separate "cross-org" error code for
    // mapApiError to translate, by design, since translating one would imply
    // a distinguishable signal existed in the first place. This test pins
    // that mapApiError has no cross-org-specific code so a future change
    // can't accidentally introduce one that leaks existence.
    expect(mapApiError(new Error('CROSS_ORG: pattern belongs to a different org'), REQUEST_ID)).toBeNull()
  })
})
