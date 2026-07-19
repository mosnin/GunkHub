import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { listWebhookDeliveries } from '@/lib/services/webhooks_config'

interface RouteParams {
  params: { id: string }
}

// ---------------------------------------------------------------------------
// GET /api/webhooks-config/[id]/deliveries — delivery history for one
// webhook target (Clerk auth, admin-only — convex/webhooks.ts
// listWebhookDeliveries enforces the role check against the target's org).
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/webhooks-config/[id]/deliveries',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
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
      const deliveries = await listWebhookDeliveries(params.id, limit)
      return NextResponse.json({ deliveries })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  }
)
