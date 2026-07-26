import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { getFailurePatternDetail } from '@/lib/services/failurePatterns'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'

interface RouteParams {
  params: { fingerprint: string }
}

// ---------------------------------------------------------------------------
// GET /api/patterns/[fingerprint] — one failure pattern's detail (rollup +
// recent occurrences + trend) for the caller's org. Clerk auth, any org
// member may view (member-gated, not admin-gated — same posture as
// GET /api/patterns and GET /api/alerts/events).
//
// Tenancy: services/failurePatterns.ts's getFailurePatternDetail passes the
// caller's own resolved orgId to convex/failure_patterns.ts's
// getFailurePattern(orgId, fingerprintHash), which is expected to filter by
// orgId server-side. A fingerprint that exists but belongs to a DIFFERENT
// org therefore comes back as the same `null` as a fingerprint that never
// existed at all — this route maps both to an identical 404, so cross-org
// existence can never be inferred from the response (CLAUDE.md tenancy
// rule 3: never return data, or a distinguishable signal, across org
// boundaries).
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/patterns/[fingerprint]',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    const { orgId } = authResult
    ctx.setOrgId(orgId)

    const fingerprint = params.fingerprint
    if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'fingerprint must be a hex digest' },
        { status: 422 }
      )
    }

    try {
      const detail = await getFailurePatternDetail(fingerprint)
      if (!detail) {
        return NextResponse.json<ApiError>(
          { code: 'NOT_FOUND', message: 'Failure pattern not found' },
          { status: 404 }
        )
      }
      return NextResponse.json(detail)
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 180 } }
)
