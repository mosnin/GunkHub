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
//
// `fromSequence` (optional) is a WINDOW floor: only events with
// `sequenceNumber >= fromSequence` are returned, served as a range read on
// the existing `by_run` index rather than by paging from the head of the log.
// It is REJECTED, never coerced, when malformed — a silently coerced bound
// (NaN -> head of log, 3.7 -> 3, -1 -> 1) returns the wrong window and looks
// like a correct answer. A floor past the end of the run is legitimate and
// yields an empty page, not an error.
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

    // Strict: decimal digits only, then a safe-integer >= 1 check. `Number()`
    // alone would accept '' (-> 0), ' 5' , '1e3', '0x10' and '3.7' (-> 3 after
    // a downstream floor), each of which silently becomes a DIFFERENT window
    // than the caller asked for. Sequence numbers start at 1 (Event Log Rule
    // 4), so 0 and negatives are malformed rather than clampable.
    const rawFromSequence = sp.get('fromSequence')
    let fromSequence: number | undefined
    if (rawFromSequence !== null) {
      const parsed = Number(rawFromSequence)
      if (!/^\d+$/.test(rawFromSequence) || !Number.isSafeInteger(parsed) || parsed < 1) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_ARGUMENT',
              message: 'fromSequence must be a positive integer (sequence numbers start at 1)',
            },
            requestId: ctx.requestId,
          },
          { status: 400 },
        )
      }
      fromSequence = parsed
    }

    try {
      const result = await apiGetRunEvents(hashApiKey(apiKey), {
        runId: params.runId,
        ...(limit !== undefined && { limit }),
        ...(fromSequence !== undefined && { fromSequence }),
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
