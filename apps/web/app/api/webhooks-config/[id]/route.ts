import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { deleteWebhook } from '@/lib/services/webhooks_config'

interface RouteParams {
  params: { id: string }
}

// ---------------------------------------------------------------------------
// DELETE /api/webhooks-config/[id] — delete an outbound webhook target
// (Clerk auth, admin-only — convex/webhooks.ts deleteWebhook enforces the
// role check against the target's own org).
// ---------------------------------------------------------------------------
export const DELETE = withApiHandler(
  '/api/webhooks-config/[id]',
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

    try {
      await deleteWebhook(params.id)
      return NextResponse.json({ deleted: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } }
)
