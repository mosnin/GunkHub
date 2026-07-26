/**
 * Resolution lifecycle (docs/adr/006-failure-resolution.md, cycle 1 — Team
 * C's API/services surface) tests for:
 *   - POST   /api/patterns/[fingerprint]/acknowledge
 *   - POST   /api/patterns/[fingerprint]/resolve
 *   - DELETE /api/patterns/[fingerprint]/resolve (reopen)
 *
 * Same pure, dependency-free style as failure_patterns_mute_route.test.ts (no
 * Next.js/Clerk/Convex runtime needed):
 *   - fingerprint validation is shared with GET/mute (fingerprintValidation.ts)
 *     — malformed fingerprints must be rejected before any Convex call.
 *   - resolve's optional `{ note?, ref? }` body is validated client-side too
 *     (resolutionFieldValidation.ts) — oversized/malformed values are
 *     rejected with a clear error before any Convex call, mirroring Convex's
 *     own MAX_RESOLUTION_NOTE_LENGTH/MAX_RESOLUTION_REF_LENGTH (2048 chars
 *     each) ceiling.
 *   - acknowledge/resolve/reopen are MEMBER-gated (not admin, unlike
 *     mute/unmute) — a non-member/insufficient-role caller's Convex
 *     `FORBIDDEN: ...` throw still maps to a clean 403, never a raw 500.
 *   - cross-org isolation: all three services collapse "fingerprint never
 *     existed" and "fingerprint belongs to a different org" into the same
 *     `null` -> generic 404, identical to every other fingerprint-scoped
 *     route in this family.
 */
import { describe, expect, it } from 'vitest'

import { hasOrgAuthContext } from '../../apps/web/src/lib/apiAuthGuard.js'
import { mapApiError } from '../../apps/web/src/lib/apiErrorMapping.js'
import { isValidFingerprint } from '../../apps/web/src/lib/services/fingerprintValidation.js'
import {
  isValidationError,
  MAX_RESOLUTION_NOTE_LENGTH,
  MAX_RESOLUTION_REF_LENGTH,
  MAX_RESOLUTION_VERSION_ID_LENGTH,
  validateResolveBody,
} from '../../apps/web/src/lib/services/resolutionFieldValidation.js'

describe('acknowledge/resolve/reopen — auth passthrough', () => {
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

describe('acknowledge/resolve/reopen — fingerprint validation', () => {
  it('accepts a well-formed hex digest (same validator as GET/mute)', () => {
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

describe('resolve body validation — note/ref', () => {
  it('accepts an empty/absent body (resolve with no note or ref is allowed)', () => {
    expect(validateResolveBody(undefined)).toEqual({})
    expect(validateResolveBody(null)).toEqual({})
    expect(validateResolveBody({})).toEqual({})
  })

  it('accepts a well-formed note and/or ref', () => {
    expect(validateResolveBody({ note: 'Fixed by pinning the tool version' })).toEqual({
      note: 'Fixed by pinning the tool version',
    })
    expect(validateResolveBody({ ref: 'https://github.com/org/repo/pull/123' })).toEqual({
      ref: 'https://github.com/org/repo/pull/123',
    })
    expect(validateResolveBody({ note: 'n', ref: 'r' })).toEqual({ note: 'n', ref: 'r' })
  })

  it('rejects a non-object body', () => {
    const result = validateResolveBody('not an object')
    expect(isValidationError(result)).toBe(true)
  })

  it('rejects an array body', () => {
    const result = validateResolveBody([])
    expect(isValidationError(result)).toBe(true)
  })

  it('rejects a non-string note', () => {
    const result = validateResolveBody({ note: 12345 })
    expect(isValidationError(result)).toBe(true)
  })

  it('rejects a non-string ref', () => {
    const result = validateResolveBody({ ref: { url: 'https://example.com' } })
    expect(isValidationError(result)).toBe(true)
  })

  it('rejects a note over MAX_RESOLUTION_NOTE_LENGTH', () => {
    const result = validateResolveBody({ note: 'a'.repeat(MAX_RESOLUTION_NOTE_LENGTH + 1) })
    expect(isValidationError(result)).toBe(true)
  })

  it('accepts a note at exactly MAX_RESOLUTION_NOTE_LENGTH (boundary)', () => {
    const note = 'a'.repeat(MAX_RESOLUTION_NOTE_LENGTH)
    expect(validateResolveBody({ note })).toEqual({ note })
  })

  it('rejects a ref over MAX_RESOLUTION_REF_LENGTH', () => {
    const result = validateResolveBody({ ref: 'a'.repeat(MAX_RESOLUTION_REF_LENGTH + 1) })
    expect(isValidationError(result)).toBe(true)
  })

  it('accepts a ref at exactly MAX_RESOLUTION_REF_LENGTH (boundary)', () => {
    const ref = 'a'.repeat(MAX_RESOLUTION_REF_LENGTH)
    expect(validateResolveBody({ ref })).toEqual({ ref })
  })

  it('treats ref as opaque text — a URL-shaped ref is never parsed or transformed', () => {
    const url = 'https://example.com/some/path?with=query&and=fragments#hash'
    expect(validateResolveBody({ ref: url })).toEqual({ ref: url })
  })
})

describe('acknowledge/resolve/reopen — member-gate error mapping (not admin-gated)', () => {
  const REQUEST_ID = 'req-resolution-1'

  it('a FORBIDDEN afrError (insufficient-role caller) maps to a clean 403, never a raw 500', async () => {
    const res = mapApiError(
      new Error('FORBIDDEN: only org members can resolve a failure pattern'),
      REQUEST_ID,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.message).not.toContain('at Object.')
  })

  it('an INVALID_ARGUMENT afrError (Convex-side resolutionNote/Ref length violation) maps to 422', async () => {
    const res = mapApiError(
      new Error(`INVALID_ARGUMENT: resolutionNote must be at most ${String(MAX_RESOLUTION_NOTE_LENGTH)} characters`),
      REQUEST_ID,
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(422)
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

describe('resolve body validation — versionId (cycle 2)', () => {
  const VALID_ID = 'jd7dkq9dnp4qz5zqsz8h8fhr7s6z0z8j'

  it('accepts a well-formed versionId', () => {
    const result = validateResolveBody({ versionId: VALID_ID })
    expect(isValidationError(result)).toBe(false)
    expect(result).toEqual({ versionId: VALID_ID })
  })

  it('accepts a body with note, ref and versionId together', () => {
    const result = validateResolveBody({ note: 'fixed', ref: 'PR-42', versionId: VALID_ID })
    expect(result).toEqual({ note: 'fixed', ref: 'PR-42', versionId: VALID_ID })
  })

  it('treats an absent versionId as absent (resolve without naming a version is still valid)', () => {
    expect(validateResolveBody({ note: 'fixed' })).toEqual({ note: 'fixed' })
  })

  it('treats an explicit null versionId as absent, so a cleared form field is not a 422', () => {
    const result = validateResolveBody({ versionId: null })
    expect(isValidationError(result)).toBe(false)
    // Never forwarded as null — the key is simply not present.
    expect(Object.keys(result)).not.toContain('versionId')
  })

  it('rejects a non-string versionId', () => {
    const result = validateResolveBody({ versionId: 42 })
    expect(isValidationError(result)).toBe(true)
  })

  it('rejects an empty or whitespace-bearing versionId before any Convex call', () => {
    expect(isValidationError(validateResolveBody({ versionId: '' }))).toBe(true)
    expect(isValidationError(validateResolveBody({ versionId: '   ' }))).toBe(true)
    expect(isValidationError(validateResolveBody({ versionId: 'ver 1' }))).toBe(true)
  })

  it('rejects a versionId over the length ceiling', () => {
    const tooLong = 'a'.repeat(MAX_RESOLUTION_VERSION_ID_LENGTH + 1)
    expect(isValidationError(validateResolveBody({ versionId: tooLong }))).toBe(true)
  })

  it('rejects path-traversal-ish junk in versionId', () => {
    expect(isValidationError(validateResolveBody({ versionId: '../../etc/passwd' }))).toBe(true)
  })
})

describe('resolve — versionId rejection stays a real 4xx, never degraded to 404', () => {
  const REQUEST_ID = 'req-resolution-3'
  /**
   * Team A rejects an unknown / cross-org / cross-agent versionId with ONE
   * uniform INVALID_ARGUMENT message (so the error cannot be used as an
   * existence oracle for another org's versions). Verbatim from
   * convex/failure_patterns.ts's INVALID_RESOLUTION_VERSION_MESSAGE.
   */
  const REJECTION = `INVALID_ARGUMENT: versionId must reference an agent version in this organization that belongs to an agent this pattern has been observed on`

  it('maps the version rejection to a real 422, not a generic 500', async () => {
    const res = mapApiError(new Error(REJECTION), REQUEST_ID)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(422)
    const body = (await res!.json()) as { code: string; message: string }
    expect(body.code).toBe('INVALID_ARGUMENT')
  })

  it('surfaces a message the operator can actually act on', async () => {
    const res = mapApiError(new Error(REJECTION), REQUEST_ID)
    const body = (await res!.json()) as { message: string }
    expect(body.message).toContain('agent version in this organization')
  })

  /**
   * LOAD-BEARING: resolveApiError's prose fallback turns any message
   * CONTAINING "not found" into a 404. Team A worded the rejection to avoid
   * that phrase precisely so a bad versionId cannot be mistaken for a missing
   * fingerprint. If either side ever reworded it, this fails.
   */
  it('is not degraded into a 404 by the "not found" prose fallback', async () => {
    expect(REJECTION.toLowerCase()).not.toContain('not found')
    const res = mapApiError(new Error(REJECTION), REQUEST_ID)
    expect(res!.status).not.toBe(404)
  })

  it('an unusable VERSION (422) stays distinct from an unknown FINGERPRINT (404)', () => {
    // The fingerprint case never reaches mapApiError at all: the service
    // returns null and the route emits its own generic 404. The two failures
    // must remain separately diagnosable by the operator.
    const versionRes = mapApiError(new Error(REJECTION), REQUEST_ID)
    expect(versionRes!.status).toBe(422)
  })
})

describe('acknowledge/resolve/reopen — cross-org isolation contract', () => {
  it('mapApiError has no dedicated cross-org code — the route\'s own null-check is the single enforcement point', () => {
    // acknowledgePattern/resolvePattern/reopenPattern (services/failurePatterns.ts)
    // collapse BOTH "fingerprint never existed" and "fingerprint exists in a
    // different org" into a bare `null` return, exactly like
    // getFailurePatternDetail/mutePattern/unmutePattern. There is deliberately
    // no separate "cross-org" error code for mapApiError to translate.
    expect(mapApiError(new Error('CROSS_ORG: pattern belongs to a different org'), 'req-resolution-2')).toBeNull()
  })
})
