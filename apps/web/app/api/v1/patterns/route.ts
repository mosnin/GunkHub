import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiListFailurePatterns } from '@/lib/services/api_v1'

// ---------------------------------------------------------------------------
// GET /api/v1/patterns — public read API, x-api-key auth (`read` scope).
//
// Query params: agentId, spiking, limit, cursor. Recurring failure patterns for the
// key's org (PREVENTION cycle 1, ADR-005) — a durable memory of
// fingerprinted, recurring failures derived from failed runs, most-recently-
// seen first. Wraps convex/read_api.ts `apiListFailurePatterns` (sdk_quality
// team) — the function enforces org scoping and the `read` scope for the
// resolved key; this route only hashes the raw key and forwards filters.
// Powers `afr patterns` and the SDK's `FlightReader.getFailurePatterns`.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/patterns',
  async (req: NextRequest, ctx) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    const sp = req.nextUrl.searchParams
    const rawLimit = sp.get('limit')
    const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined
    // --spiking (PREVENTION cycle 2): only "true" opts in to the filter — any
    // other value (including "false" or garbage) is treated as unset, same
    // permissive-parsing posture as `limit` above.
    const spiking = sp.get('spiking') === 'true' ? true : undefined

    try {
      const result = await apiListFailurePatterns(hashApiKey(apiKey), {
        ...(sp.get('agentId') !== null && { agentId: sp.get('agentId') as string }),
        ...(spiking !== undefined && { spiking }),
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
  // Same "ingest-key" rate class as the other v1 read routes.
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
