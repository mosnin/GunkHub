import { type NextRequest, NextResponse } from 'next/server'

import { mapApiErrorV1, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiListFailurePatterns } from '@/lib/services/api_v1'

// ---------------------------------------------------------------------------
// GET /api/v1/patterns — public read API, x-api-key auth (`read` scope).
//
// Query params: agentId, spiking, muted, limit, cursor. Recurring failure
// patterns for the key's org (PREVENTION cycle 1, ADR-005) — a durable memory
// of fingerprinted, recurring failures derived from failed runs, most-
// recently-seen first. Wraps convex/read_api.ts `apiListFailurePatterns`
// (sdk_quality team) — the function enforces org scoping and the `read`
// scope for the resolved key; this route only hashes the raw key and
// forwards filters.
// Powers `afr patterns` and the SDK's `FlightReader.getFailurePatterns`.
//
// `muted` (PREVENTION cycle 3, "mute reflection"): a READ-side filter only —
// there is no mutation on this route or `apiListFailurePatterns` that sets
// `muted`. Setting mute state is an admin-only, Clerk-authed, audited action
// on a separate route; this key-authed v1 surface can only reflect it.
//
// `status`/`regressed` (Resolution cycle 1, ADR-006, "resolution
// reflection"): same READ-side-only posture as `muted` — no mutation here
// sets `status`/`resolvedAt`/`regressedAt`/etc. Acknowledging, resolving, or
// reopening a pattern is a member-gated, audited, Clerk-authed action on a
// separate route; this surface only ever reflects the resulting lifecycle
// state. Powers `afr patterns --status`/`--regressed` and the STATUS column.
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
    // --muted/--active (PREVENTION cycle 3): tri-state, parsed the same
    // permissive way as `spiking` — only the exact strings "true"/"false" opt
    // in; anything else (missing, garbage, mixed case) is treated as unset
    // rather than rejected, consistent with every other filter on this route.
    const rawMuted = sp.get('muted')
    const muted = rawMuted === 'true' ? true : rawMuted === 'false' ? false : undefined
    // --status (Resolution cycle 1): only the three known literal values opt
    // in; anything else (missing, garbage, mixed case) is treated as unset
    // rather than rejected — same permissive-parsing posture as every other
    // filter on this route. Junk values are safely ignored, not a 500.
    const rawStatus = sp.get('status')
    const status =
      rawStatus === 'open' || rawStatus === 'acknowledged' || rawStatus === 'resolved' ? rawStatus : undefined
    // --regressed: same "true" opts in, anything else unset pattern as --spiking.
    const regressed = sp.get('regressed') === 'true' ? true : undefined
    // --state (ADR-006 cycle 2): the FIX-CONFIDENCE grade, Team B's
    // `FixConfidenceState` vocabulary verbatim. Parsed permissively like every
    // other filter here — only the four known literals opt in, anything else
    // is treated as unset rather than rejected at this layer.
    //
    // NOTE the deliberate asymmetry with that permissiveness: a RECOGNIZED but
    // unanswerable value ('unproven'/'proving'/'confirmed') is forwarded and
    // then rejected by Convex with INVALID_ARGUMENT -> 422. That is the point.
    // Those three depend on per-pattern post-resolution run exposure, which
    // cannot be measured across a whole page, and silently returning an
    // unfiltered page for them would be precisely the silent-filter-drop bug
    // this route family has already shipped once. Only 'regressed' is
    // exposure-independent and therefore answerable here; the per-pattern
    // evidence endpoint answers the rest.
    const rawState = sp.get('state')
    const state =
      rawState === 'unproven' || rawState === 'proving' || rawState === 'confirmed' || rawState === 'regressed'
        ? rawState
        : undefined

    try {
      const result = await apiListFailurePatterns(hashApiKey(apiKey), {
        ...(sp.get('agentId') !== null && { agentId: sp.get('agentId') as string }),
        ...(spiking !== undefined && { spiking }),
        ...(muted !== undefined && { muted }),
        ...(status !== undefined && { status }),
        ...(regressed !== undefined && { regressed }),
        ...(state !== undefined && { state }),
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
