import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { listFailurePatterns } from '@/lib/services/failurePatterns'

// ---------------------------------------------------------------------------
// GET /api/patterns — list the caller's org's recurring failure-fingerprint
// rollups ("Failure Patterns" / PREVENTION feature, cycle 1). Clerk auth,
// any org member may view — convex/failure_patterns.ts's listFailurePatterns
// is member-gated, not admin-gated, same posture as GET /api/alerts/events.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/patterns',
  async (req: NextRequest, ctx) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 }
      )
    }
    const { orgId } = authResult
    ctx.setOrgId(orgId)

    const rawLimit = req.nextUrl.searchParams.get('limit')
    const limit =
      rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined

    try {
      const patterns = await listFailurePatterns(limit)
      return NextResponse.json({ patterns })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Clerk-read rate class, consistent with the sibling GET /api/alerts/events.
  { rateLimit: { key: 'org', limitPerMin: 180 } }
)
