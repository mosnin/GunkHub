import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../../_lib/fieldsParam'

import { mapApiErrorV1, v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetRunDivergence } from '@/lib/services/api_v1'

interface RouteParams {
  params: { runId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId]/divergence?target=<versionId>
//
// ADR-008. "Would this recorded run still have been possible on version X?"
// Public read API, `x-api-key` auth (`read` scope). Wraps
// convex/read_api.ts `apiGetRunDivergence`.
//
// This is the route `afr compat` and the MCP `afr_get_run_divergence` tool call.
// Without it the divergence engine is reachable only from the browser, which
// leaves the two surfaces our ICP actually uses — a CI gate and an agent asking
// about its own next version — dead-ended.
//
// COMPLETENESS IS PART OF THE ANSWER, AND IS PASSED THROUGH VERBATIM.
// `coverage`, `eventHistoryComplete` and `nextEventCursor` are what separate an
// honest `indeterminate` from a false `compatible`. This route does not reshape
// the backend result, so a caller computing its own verdict with the contract's
// `computeDivergenceVerdict` sees exactly what the engine saw.
//
// PAGING: `cursor` continues over the RUN'S EVENTS. Until it is exhausted the
// report carries `eventHistoryComplete: false` and cannot be graded compatible.
//
// TENANCY: every rejection below happens before the key is resolved and before
// any Convex call, so a malformed parameter produces an identical response
// whether the run exists, does not exist, or belongs to another org.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs/[runId]/divergence',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    // REQUIRED. There is no default target: analysing a run against a version
    // the caller did not name would answer a question they did not ask, and the
    // answer would look identical to the one they wanted.
    const target = req.nextUrl.searchParams.get('target')
    if (target === null || target === '') {
      return v1InvalidArgument(
        'Missing required query parameter `target` (the agent version id to check this run against).',
        ctx.requestId,
      )
    }

    const cursor = req.nextUrl.searchParams.get('cursor')
    if (cursor !== null && cursor === '') {
      return v1InvalidArgument(
        'Query parameter `cursor` must be a non-empty continuation token, or omitted entirely.',
        ctx.requestId,
      )
    }

    const fields = parseFieldsParam(req.nextUrl.searchParams)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }

    try {
      const result = await apiGetRunDivergence(hashApiKey(apiKey), {
        runId: params.runId,
        targetVersionId: target,
        ...(cursor !== null && { eventCursor: cursor }),
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
