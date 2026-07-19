import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetRunEvents } from '@/lib/services/api_v1'

interface RouteParams {
  params: { runId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/events — public read API, x-api-key auth
// (`read` scope). Paginated (limit/cursor). Wraps convex/read_api.ts
// `apiGetRunEvents`.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs/[runId]/events',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    const sp = req.nextUrl.searchParams
    const rawLimit = sp.get('limit')
    const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined

    try {
      const result = await apiGetRunEvents(hashApiKey(apiKey), {
        runId: params.runId,
        ...(limit !== undefined && { limit }),
        ...(sp.get('cursor') !== null && { cursor: sp.get('cursor') as string }),
      })
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
