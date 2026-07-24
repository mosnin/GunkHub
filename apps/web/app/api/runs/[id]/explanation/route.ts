// GET /api/runs/:id/explanation — Clerk-authenticated (browser callers, not
// the SDK). Member-gated, org-scoped: wraps convex/run_explanations.ts
// `getRunExplanation` (Team A), which resolves the run's orgId and calls
// `requireOrgMembership` itself — this route does not re-check membership,
// it just requires *some* authenticated org context (mirrors the pattern in
// runs/[id]/triage/route.ts) and lets Convex's own gate produce a clean 403
// if the caller isn't in the run's org.
//
// Response body is intentionally honest about the two "nothing to show"
// cases the brief calls out:
//   - `{ explanation: null }` — no cached explanation yet (run hasn't
//     failed, or generation hasn't completed/been triggered). The client
//     cannot distinguish "not a failed run" from "still generating" from
//     this alone today — see docs/design/explanations.md's "Known gap:
//     coarse null state" for why, and what a future Convex-side status field
//     would resolve.
//   - A thrown Convex/network error still maps through `mapApiError` to a
//     real error status — that is NOT the same as `explanation: null` and
//     must never be silently coerced into it.
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { getRunExplanation } from '@/lib/services/explanations'

interface RouteParams {
  params: { id: string }
}

export const GET = withApiHandler(
  '/api/runs/[id]/explanation',
  async (_req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(authResult.orgId)

    try {
      const explanation = await getRunExplanation(params.id)
      return NextResponse.json({ explanation })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Read traffic — same class as the sibling /status and /replay GETs.
  { rateLimit: { key: 'org', limitPerMin: 180 } },
)
