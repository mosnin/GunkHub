import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetReplay } from '@/lib/services/api_v1'

interface RouteParams {
  params: { runId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/replay — public read API, x-api-key auth
// (`read` scope). Wraps convex/read_api.ts `apiGetReplay`.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs/[runId]/replay',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    try {
      const result = await apiGetReplay(hashApiKey(apiKey), params.runId)
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
