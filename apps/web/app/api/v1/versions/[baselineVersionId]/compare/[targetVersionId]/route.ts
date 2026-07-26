import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../../../_lib/fieldsParam'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiCompareVersionConfigs } from '@/lib/services/api_v1'

interface RouteParams {
  params: { baselineVersionId: string; targetVersionId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/versions/[baselineVersionId]/compare/[targetVersionId]
//
// ADR-008 TIER 1 — the cheapest rung of the progressive-disclosure ladder:
// ZERO run reads, ZERO event reads. Every SPECULATIVE finding depends only on
// the (baseline, target) config pair and is therefore identical across all of
// that version's runs, so this answers most of the "what changed" question for
// a whole fleet at once, for free.
//
// Public read API, `x-api-key` (`read` scope). Wraps convex/read_api.ts
// `apiCompareVersionConfigs`.
//
// WHAT THIS ROUTE CANNOT TELL YOU, and why callers must not stop here: no
// PROVEN finding is decidable from configs alone. Proving that a run could not
// have happened requires a recorded event to contradict, which means reading
// runs — the blast-radius and per-run routes. A caller treating a clean
// response here as "safe to ship" has checked that nothing CHANGED in a way it
// could name, not that nothing BREAKS. The response's own
// `requiresRunEvidence` field lists the finding classes that still need run
// data; it is not decoration.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/versions/[baselineVersionId]/compare/[targetVersionId]',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    const fields = parseFieldsParam(req.nextUrl.searchParams)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }

    try {
      const result = await apiCompareVersionConfigs(hashApiKey(apiKey), {
        baselineVersionId: params.baselineVersionId,
        targetVersionId: params.targetVersionId,
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
