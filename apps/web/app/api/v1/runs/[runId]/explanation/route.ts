import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetExplanation } from '@/lib/services/api_v1'

interface RouteParams {
  params: { runId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/explanation — public read API, x-api-key auth
// (`read` scope). The "Why did this fail?" root-cause for the `afr explain`
// CLI + FlightReader.getExplanation. Wraps convex/read_api.ts
// `apiGetExplanation`; returns `{ explanation: RunExplanation | null }`.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs/[runId]/explanation',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    try {
      const result = await apiGetExplanation(hashApiKey(apiKey), params.runId)
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
