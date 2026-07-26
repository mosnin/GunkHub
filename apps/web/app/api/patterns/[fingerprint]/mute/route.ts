import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { mutePattern, unmutePattern } from '@/lib/services/failurePatterns'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'

interface RouteParams {
  params: { fingerprint: string }
}

// ---------------------------------------------------------------------------
// POST   /api/patterns/[fingerprint]/mute — mute a failure pattern
// DELETE /api/patterns/[fingerprint]/mute — unmute a failure pattern
//
// Cycle 3 (PREVENTION, close mute): rebuilds the mute route removed in
// cycle 2 (the Convex mutation didn't exist yet — a throwing stub would have
// been worse than no route at all). Team A has now landed
// `failure_patterns:mutePattern` / `unmutePattern` as org-scoped,
// ADMIN-GATED, AUDITED mutations. This route does not re-implement the
// admin check or the audit write — it only supplies the org-scoped auth
// context (Clerk org -> Convex orgId, same as every other route in this
// file's family) and maps whatever Convex throws:
//   - a non-admin caller's `FORBIDDEN: ...` throw -> a clean 403 via
//     mapApiError, never a raw 500.
//   - a fingerprint that doesn't exist IN THIS ORG -> the service returns
//     `null` (collapsing "never existed" and "belongs to a different org"
//     into the same value, exactly like GET /api/patterns/[fingerprint]) ->
//     this route maps that to a generic 404. A mute/unmute call can never be
//     used to probe whether a fingerprint exists in another org: the
//     response shape for "wrong org" and "no such pattern anywhere" is
//     byte-for-byte identical.
// ---------------------------------------------------------------------------

function requireAuthedOrg(
  ctx: { setOrgId: (orgId: string) => void },
): NextResponse<ApiError> | { orgId: string } {
  const authResult = auth()
  if (!hasOrgAuthContext(authResult)) {
    return NextResponse.json<ApiError>(
      { code: 'UNAUTHORIZED', message: 'Authentication required' },
      { status: 401 }
    )
  }
  ctx.setOrgId(authResult.orgId)
  return { orgId: authResult.orgId }
}

function validateFingerprintParam(fingerprint: unknown): NextResponse<ApiError> | string {
  if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
    return NextResponse.json<ApiError>(
      { code: 'VALIDATION_ERROR', message: 'fingerprint must be a hex digest' },
      { status: 422 }
    )
  }
  return fingerprint
}

export const POST = withApiHandler(
  '/api/patterns/[fingerprint]/mute',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authed = requireAuthedOrg(ctx)
    if (authed instanceof NextResponse) return authed

    const fingerprint = validateFingerprintParam(params.fingerprint)
    if (fingerprint instanceof NextResponse) return fingerprint

    try {
      const pattern = await mutePattern(fingerprint)
      if (!pattern) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json({ pattern })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)

export const DELETE = withApiHandler(
  '/api/patterns/[fingerprint]/mute',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authed = requireAuthedOrg(ctx)
    if (authed instanceof NextResponse) return authed

    const fingerprint = validateFingerprintParam(params.fingerprint)
    if (fingerprint instanceof NextResponse) return fingerprint

    try {
      const pattern = await unmutePattern(fingerprint)
      if (!pattern) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json({ pattern })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
