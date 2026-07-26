import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../../../_lib/fieldsParam'

import { mapApiErrorV1, v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetFleetDivergence } from '@/lib/services/api_v1'

interface RouteParams {
  params: { baselineVersionId: string; targetVersionId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/versions/[baselineVersionId]/blast-radius/[targetVersionId]
//
// ADR-008 TIER 3. "Can I ship target across everything baseline has actually
// been doing?" — a BOUNDED BATCH of the baseline version's recorded runs,
// grouped by DISTINCT REASON. Public read API, `x-api-key` (`read` scope).
// Wraps convex/read_api.ts `apiGetFleetDivergence`.
//
// This is what `afr compat` calls for a fleet gate, and what the MCP
// `afr_assess_version` tool calls.
//
// WHY BOTH VERSIONS ARE PATH SEGMENTS, NOT QUERY PARAMS.
// The (baseline, target) pair IS the resource: the baseline selects which runs
// are scanned, and the pair determines every speculative finding. Putting
// either in the query string would make it look optional, and a defaulted
// baseline would silently change the population being analysed whenever a new
// version was created.
//
// ONE BATCH, NOT ONE ANSWER. Convex permits a single `.paginate()` per
// execution and `events` has no index on `type`, so a large population is
// walked page by page. `window.nextCursor` is returned and is folded into
// `isFleetScanComplete` by the contract itself — a caller that has not walked to
// the final page has NOT seen the population, and its verdict is
// `indeterminate` rather than `compatible`. That is the property that stops a
// CI gate exiting zero over an unscanned fleet, and it depends on this route
// passing `window` through untouched. It does.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/versions/[baselineVersionId]/blast-radius/[targetVersionId]',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    const cursor = req.nextUrl.searchParams.get('cursor')
    if (cursor !== null && cursor === '') {
      return v1InvalidArgument(
        'Query parameter `cursor` must be a non-empty continuation token, or omitted entirely.',
        ctx.requestId,
      )
    }

    // REJECT, NEVER COERCE — the house rule for this surface. A `limit` of
    // `abc` coerced to a default returns a DIFFERENT answer than the caller
    // asked for, and unlike an error the caller cannot tell.
    const rawLimit = req.nextUrl.searchParams.get('limit')
    let limit: number | undefined
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) {
        return v1InvalidArgument(
          'Query parameter `limit` must be a positive integer.',
          ctx.requestId,
        )
      }
      limit = Number(rawLimit)
      if (limit < 1) {
        return v1InvalidArgument(
          'Query parameter `limit` must be a positive integer.',
          ctx.requestId,
        )
      }
    }

    const fields = parseFieldsParam(req.nextUrl.searchParams)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }

    try {
      const result = await apiGetFleetDivergence(hashApiKey(apiKey), {
        baselineVersionId: params.baselineVersionId,
        targetVersionId: params.targetVersionId,
        ...(cursor !== null && { cursor }),
        ...(limit !== undefined && { limit }),
        // Forwarded VERBATIM. `convex/read_api.ts`'s
        // `validateDivergenceFieldSelection` force-includes the caveat fields
        // (`coverage`/`nextEventCursor`, `window`/`nextCursor`, and the config
        // tier's provability fields) whenever the projection names a
        // conclusion-bearing field, so a projected report can never shed the
        // evidence that it is provisional. This route deliberately does NOT
        // mirror that rule: two layers each assuming the other handles it is
        // how the guarantee rots.
        ...(fields.fields !== undefined && { fields: fields.fields }),
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
