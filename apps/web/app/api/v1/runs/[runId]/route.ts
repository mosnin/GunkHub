import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../_lib/fieldsParam'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetRun } from '@/lib/services/api_v1'


interface RouteParams {
  params: { runId: string }
}

// ---------------------------------------------------------------------------
// GET /api/v1/runs/[runId] — public read API, x-api-key auth (`read` scope).
// Wraps convex/read_api.ts `apiGetRun`.
//
// `fields` (optional) selects a server-side projection: `?fields=a,b,c`
// returns only those fields of the run document. Omitted => the full document,
// unchanged. Shape validation and the reject-never-coerce rationale live in
// ../../_lib/fieldsParam.ts; unknown field NAMES are convex/read_api.ts's to
// reject, and this route surfaces that error verbatim rather than duplicating
// the field list.
//
// TENANCY: the shape rejection below happens before the key is resolved and
// before any Convex call, so a malformed `fields` produces an identical
// response whether the run exists, does not exist, or belongs to another org.
// Projection never widens or narrows WHICH run is returned.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/runs/[runId]',
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
      const result = await apiGetRun(hashApiKey(apiKey), {
        runId: params.runId,
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
