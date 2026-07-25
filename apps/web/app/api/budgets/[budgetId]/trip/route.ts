import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseBudgetMutationBody } from '@/lib/budgets/mutationRequest'
import { tripBudget } from '@/lib/services/budgets'

interface RouteParams {
  params: { budgetId: string }
}

// ---------------------------------------------------------------------------
// POST /api/budgets/[budgetId]/trip — trip a breaker by hand.
//
// MEMBER-permitted, not admin. Convex enforces it. The asymmetry with the reset
// route is the risk's own: tripping WITHHOLDS and its cost is delay, while
// resetting resumes spend with nothing in front of it. Requiring an admin to be
// awake to pull the cord was the wrong constraint at 3am. Viewers may do
// neither.
//
// `reason` is REQUIRED and written verbatim to the append-only admin audit log
// under the actor's real id (CLAUDE.md Event Log Rule 6). A manual trip has no
// meter reading behind it, so that sentence is the entire justification — which
// is why it is rejected rather than defaulted when absent.
//
// The reason is stored as OPERATOR TEXT and is never composed into a system
// statement. The execution-claim guard applies to this product's voice;
// censoring a human's account of what they did would be a worse dishonesty than
// the one it prevents.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/budgets/[budgetId]/trip',
  async (req: NextRequest, ctx, { params }: RouteParams) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(authResult.orgId)

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json<ApiError>(
        { code: 'BAD_REQUEST', message: 'Invalid JSON body' },
        { status: 400 },
      )
    }

    // The budget id is the PATH's, and the shared parser wants one in the body;
    // the path is authoritative, so it is injected rather than trusted from the
    // body. A body id that disagreed with the path would be an ambiguity worth
    // nobody's time to resolve.
    const parsed = parseBudgetMutationBody({
      ...(raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
      budgetId: params.budgetId,
    })
    if (!parsed.ok) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: parsed.message },
        { status: 422 },
      )
    }

    try {
      await tripBudget(params.budgetId, parsed.body.reason)
      return NextResponse.json({ ok: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)
