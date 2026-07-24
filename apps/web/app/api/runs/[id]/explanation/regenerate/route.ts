// POST /api/runs/:id/explanation/regenerate — Clerk-authenticated, admin-
// gated. Wraps convex/run_explanations.ts `regenerateRunExplanation` (Team A)
// — an ACTION (see services/explanations.ts, invoked via `client.action`,
// not `client.mutation`) that enforces the admin role itself
// (`_requireAdminForRegenerate`) and throws a `Forbidden:`-prefixed error for
// a non-admin caller — this route does NOT re-implement the role check. It
// only requires *some* authenticated org context and lets Convex's own gate
// throw, which `mapApiError`'s string-matching fallback turns into a clean
// 403 body rather than a generic 500. This is the one property the brief
// calls out explicitly ("the convex mutation enforces it — surface 403
// cleanly"). A run whose status isn't failed/timed_out/cancelled throws an
// `INVALID_ARGUMENT:` afrError instead, mapped to 422.
//
// Called by ExplanationRegenerateButton (Team E,
// apps/web/src/components/runs/ExplanationRegenerateButton.tsx) — it only
// checks `res.ok` and calls `router.refresh()` on success, so the response
// body shape is a convenience for callers who do inspect it, not a contract
// that component depends on.
import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { regenerateRunExplanation } from '@/lib/services/explanations'

interface RouteParams {
  params: { id: string }
}

export const POST = withApiHandler(
  '/api/runs/[id]/explanation/regenerate',
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
      const explanation = await regenerateRunExplanation(params.id)
      return NextResponse.json({ explanation })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Write traffic, LLM-backed and potentially slow/expensive — tighter than
  // the plain GET, matching the sibling triage PATCH's write-class limit.
  { rateLimit: { key: 'org', limitPerMin: 20 } },
)
