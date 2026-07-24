/**
 * Cycle 3 (PREVENTION, close mute — Team C's API/services surface) tests for
 * `POST`/`DELETE /api/patterns/[fingerprint]/mute`.
 *
 * These routes were REMOVED in cycle 2 because the underlying Convex
 * mutation didn't exist yet — a throwing stub is worse than no route at all
 * (see this file's header in git history / the cycle-2 removal note). Team A
 * has now landed `failure_patterns:mutePattern`/`unmutePattern` as org-scoped,
 * ADMIN-GATED, AUDITED mutations; this route rebuild supplies the org-scoped
 * auth context and maps Convex's errors, but does not re-implement the admin
 * check or the audit write itself.
 *
 * Same pure, dependency-free style as failure_patterns_route.test.ts (no
 * Next.js/Clerk/Convex runtime needed):
 *   - fingerprint validation is shared with the GET detail route
 *     (fingerprintValidation.ts) — malformed fingerprints must be rejected
 *     before any Convex call, for mute/unmute exactly like for GET.
 *   - a non-admin caller's Convex `FORBIDDEN: ...` throw maps to a clean 403,
 *     never a raw 500 (mirrors PUT/DELETE /api/alerts/[id]'s admin gate).
 *   - the cross-org-isolation contract: mutePattern/unmutePattern
 *     (services/failurePatterns.ts) return `null` for BOTH "fingerprint
 *     never existed" and "fingerprint belongs to a different org" — the
 *     route maps that uniformly to a 404, so mute/unmute can never be used
 *     to probe another org's fingerprint existence (same posture as
 *     GET /api/patterns/[fingerprint]).
 */
import { describe, expect, it } from 'vitest'

import { hasOrgAuthContext } from '../../apps/web/src/lib/apiAuthGuard.js'
import { mapApiError } from '../../apps/web/src/lib/apiErrorMapping.js'
import { isValidFingerprint } from '../../apps/web/src/lib/services/fingerprintValidation.js'

describe('POST/DELETE /api/patterns/[fingerprint]/mute — auth passthrough', () => {
  it('rejects an authenticated user with no org context', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: null })).toBe(false)
  })

  it('rejects when there is no Clerk session at all', () => {
    expect(hasOrgAuthContext({})).toBe(false)
  })

  it('accepts a fully authenticated org context', () => {
    expect(hasOrgAuthContext({ userId: 'user_1', orgId: 'org_1' })).toBe(true)
  })
})

describe('POST/DELETE /api/patterns/[fingerprint]/mute — fingerprint validation', () => {
  it('accepts a well-formed hex digest (same validator as GET /api/patterns/[fingerprint])', () => {
    expect(isValidFingerprint('a1b2c3d4')).toBe(true)
    expect(isValidFingerprint('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd')).toBe(true)
  })

  it('rejects malformed fingerprints before any Convex mutation would be attempted', () => {
    expect(isValidFingerprint('')).toBe(false)
    expect(isValidFingerprint('abc')).toBe(false)
    expect(isValidFingerprint('not-hex-at-all!!')).toBe(false)
    expect(isValidFingerprint('../../etc/passwd')).toBe(false)
    expect(isValidFingerprint('a'.repeat(65))).toBe(false)
  })
})

describe('POST/DELETE /api/patterns/[fingerprint]/mute — admin-gate error mapping', () => {
  const REQUEST_ID = 'req-mute-1'

  it('a FORBIDDEN afrError (non-admin caller) maps to a clean 403, never a raw 500', async () => {
    const res = mapApiError(new Error('FORBIDDEN: only org admins can mute a failure pattern'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.message).not.toContain('at Object.')
  })

  it('an UNAUTHORIZED afrError maps to 401', async () => {
    const res = mapApiError(new Error('UNAUTHORIZED: no active session'), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
  })

  it('an unrecognized convex error is left for the route to rethrow (never silently 200s)', () => {
    expect(mapApiError(new Error('totally unexpected convex internal failure'), REQUEST_ID)).toBeNull()
  })
})

describe('POST/DELETE /api/patterns/[fingerprint]/mute — cross-org isolation contract', () => {
  it('mapApiError has no dedicated cross-org code — the route\'s own null-check is the single enforcement point', () => {
    // mutePattern/unmutePattern (services/failurePatterns.ts) collapse BOTH
    // "fingerprint never existed" and "fingerprint exists in a different org"
    // into a bare `null` return, exactly like getFailurePatternDetail. There
    // is deliberately no separate "cross-org" error code for mapApiError to
    // translate — introducing one would itself be a distinguishable signal.
    // This test pins that so a future change can't accidentally add one.
    expect(mapApiError(new Error('CROSS_ORG: pattern belongs to a different org'), 'req-mute-2')).toBeNull()
  })
})
