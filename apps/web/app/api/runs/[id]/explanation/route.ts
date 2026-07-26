// GET /api/runs/:id/explanation — Clerk-authenticated (browser callers, not
// the SDK). Member-gated, org-scoped: wraps convex/run_explanations.ts
// `getRunExplanation` (Team A), which resolves the run's orgId and calls
// `requireOrgMembership` itself — this route does not re-check membership,
// it just requires *some* authenticated org context (mirrors the pattern in
// runs/[id]/triage/route.ts) and lets Convex's own gate produce a clean 403
// if the caller isn't in the run's org.
//
// Response body:
//   - `{ explanation, status, runStatus, runEndedAt? }` — `status` is the
//     REAL discriminant (`"not_eligible" | "pending" | "ready"`) Team A
//     added to `run_explanations:getRunExplanation` this cycle (ADR-004,
//     cycle 3), closing what was previously a documented "coarse null
//     state" gap (`explanation: null` used to mean either "not a failed
//     run" or "still generating", indistinguishably). `explanation` is
//     still `null` for BOTH `not_eligible` and `pending` — existing callers
//     reading only `.explanation` are unaffected — but any caller (or a
//     future `ExplanationPanel` revision) that wants the precise reason can
//     now read `status` instead of guessing from `runEndedAt` client-side.
//     See `@/lib/services/explanations`'s `getRunExplanationWithStatus`.
//   - A thrown Convex/network error still maps through `mapApiError` to a
//     real error status — that is NOT the same as `explanation: null` and
//     must never be silently coerced into it.
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { getRunExplanationWithStatus } from '@/lib/services/explanations'

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
      const result = await getRunExplanationWithStatus(params.id)
      return NextResponse.json(result)
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Read traffic — same class as the sibling /status and /replay GETs.
  { rateLimit: { key: 'org', limitPerMin: 180 } },
)
