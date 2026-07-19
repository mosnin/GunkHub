import { type NextRequest, NextResponse } from 'next/server'

import type { RunStatus } from '@agent-flight-recorder/contracts'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiListRuns } from '@/lib/services/api_v1'

// ---------------------------------------------------------------------------
// GET /api/v1/runs — public read API, x-api-key auth (`read` scope).
//
// Query params: status, agentId, environment, session, limit, cursor. The
// external `session` param name maps to the Run/read_api `sessionId` field —
// kept short in the query string for ergonomics.
// Wraps convex/read_api.ts `apiListRuns` (Team A) — the function enforces
// org scoping and the `read` scope for the resolved key; this route only
// hashes the raw key and forwards filters.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs',
  async (req: NextRequest, ctx) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    const sp = req.nextUrl.searchParams
    const rawLimit = sp.get('limit')
    const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined

    try {
      const result = await apiListRuns(hashApiKey(apiKey), {
        ...(sp.get('status') !== null && { status: sp.get('status') as RunStatus }),
        ...(sp.get('agentId') !== null && { agentId: sp.get('agentId') as string }),
        ...(sp.get('environment') !== null && { environment: sp.get('environment') as string }),
        ...(sp.get('session') !== null && { sessionId: sp.get('session') as string }),
        ...(limit !== undefined && { limit }),
        ...(sp.get('cursor') !== null && { cursor: sp.get('cursor') as string }),
      })
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      // Unrecognized — rethrow so withApiHandler logs the detail and
      // genericizes the response (never leaks raw convex error text). Note:
      // withApiHandler's own generic 500 fallback uses the flat ApiError
      // shape, not the v1 envelope — see docs/api_reference.md's "known
      // limitations" note.
      throw err
    }
  },
  // "ingest-key" rate class: keyed off the api-key hash (never the raw
  // secret), tuned for read traffic — looser than the 120/min write default
  // but distinct from the 600/min ingest-write class used by /api/events.
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
