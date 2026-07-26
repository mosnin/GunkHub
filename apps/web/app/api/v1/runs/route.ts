import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../_lib/fieldsParam'

import type { RunStatus } from '@agent-flight-recorder/contracts'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiListRuns } from '@/lib/services/api_v1'


// ---------------------------------------------------------------------------
// GET /api/v1/runs — public read API, x-api-key auth (`read` scope).
//
// Query params: status, agentId, environment, session, limit, cursor, fields.
// The external `session` param name maps to the Run/read_api `sessionId`
// field — kept short in the query string for ergonomics.
//
// `fields` (optional) selects a server-side projection: `?fields=a,b,c`
// returns only those fields of each run. Omitted => the full document,
// unchanged — existing consumers are unaffected. Malformed lists (empty,
// stray comma, surrounding whitespace, duplicates, repeated param) are
// REJECTED with 400 INVALID_ARGUMENT before any Convex call, never coerced;
// see ../_lib/fieldsParam.ts. UNKNOWN field NAMES are not checked here on
// purpose — convex/read_api.ts owns the field vocabulary and raises the error
// naming the offender and listing the valid names, and this route surfaces
// that error rather than keeping a second copy of the list that can disagree.
//
// Projection is a response-shaping concern only: it never changes WHICH runs
// are returned, so the org scoping enforced inside the Convex function is
// untouched by it.
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

    const fields = parseFieldsParam(sp)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }

    try {
      const result = await apiListRuns(hashApiKey(apiKey), {
        ...(sp.get('status') !== null && { status: sp.get('status') as RunStatus }),
        ...(sp.get('agentId') !== null && { agentId: sp.get('agentId') as string }),
        ...(sp.get('environment') !== null && { environment: sp.get('environment') as string }),
        ...(sp.get('session') !== null && { sessionId: sp.get('session') as string }),
        ...(limit !== undefined && { limit }),
        ...(sp.get('cursor') !== null && { cursor: sp.get('cursor') as string }),
        ...(fields.fields !== undefined && { fields: fields.fields }),
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
