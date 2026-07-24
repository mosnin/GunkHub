import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { acknowledgePattern } from '@/lib/services/failurePatterns'
import { isValidFingerprint } from '@/lib/services/fingerprintValidation'

interface RouteParams {
  params: { fingerprint: string }
}

// ---------------------------------------------------------------------------
// POST /api/patterns/[fingerprint]/acknowledge — acknowledge a failure
// pattern (Resolution lifecycle, docs/adr/006-failure-resolution.md, cycle
// 1). Structured identically to the sibling mute route
// (apps/web/app/api/patterns/[fingerprint]/mute/route.ts) with one important
// difference in gating: Team A's `acknowledgePattern` is MEMBER-gated (not
// admin), because acknowledging a failure is normal triage — like
// commenting — not org-wide alert-suppression config. This route does not
// re-implement that gate or the audit write; it only supplies the org-scoped
// auth context and maps whatever Convex throws:
//   - an insufficient-role caller's `FORBIDDEN: ...` throw -> a clean 403 via
//     mapApiError, never a raw 500.
//   - a fingerprint that doesn't exist IN THIS ORG -> the service returns
//     `null` (collapsing "never existed" and "belongs to a different org"
//     into the same value, exactly like GET /api/patterns/[fingerprint] and
//     the mute route) -> this route maps that to a generic 404.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/patterns/[fingerprint]/acknowledge',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    ctx.setOrgId(authResult.orgId)

    const fingerprint = params.fingerprint
    if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'fingerprint must be a hex digest' },
        { status: 422 }
      )
    }

    try {
      const pattern = await acknowledgePattern(fingerprint)
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
