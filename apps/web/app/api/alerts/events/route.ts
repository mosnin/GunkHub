import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { listAlertEvents } from '@/lib/services/alerts'

// ---------------------------------------------------------------------------
// GET /api/alerts/events — firing history for the org (Clerk auth; any
// member may view, per ADR — convex/alerts.ts listAlertEvents is not
// admin-gated). Used by the UI's alert-rule-firing history view.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/alerts/events',
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
      const events = await listAlertEvents(limit)
      return NextResponse.json({ events })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Clerk-read rate class: higher than the sibling 60/min write limit,
  // explicit rather than falling back to the global 300/min default, for
  // consistency with this route family's other explicit limits.
  { rateLimit: { key: 'org', limitPerMin: 180 } }
)
