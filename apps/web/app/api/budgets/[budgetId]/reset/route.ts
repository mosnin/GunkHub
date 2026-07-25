import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseBudgetMutationBody } from '@/lib/budgets/mutationRequest'
import { resetBudget } from '@/lib/services/budgets'

interface RouteParams {
  params: { budgetId: string }
}

// ---------------------------------------------------------------------------
// POST /api/budgets/[budgetId]/reset — clear a trip and begin a new accounting
// period at this instant.
//
// ADMIN-only. Convex enforces it, and the stricter gate than the sibling trip
// route is deliberate: tripping withholds, resetting RESUMES SPEND. It also
// advances the window start for every period, which is what stops a reset from
// re-tripping on the very next evaluation — and which means the breaching spend
// leaves the accounting window. THE AUDIT ROW IS WHERE THAT DISCARDED FACT
// SURVIVES, so `reason` is required and never defaulted.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/budgets/[budgetId]/reset',
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
      await resetBudget(params.budgetId, parsed.body.reason)
      return NextResponse.json({ ok: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)
