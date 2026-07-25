import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseCreateBudgetBody } from '@/lib/budgets/createRequest'
import { createBudget, listBudgets } from '@/lib/services/budgets'

// ---------------------------------------------------------------------------
// /api/budgets — the Clerk-authed management surface for budget circuit
// breakers, backing the web UI at /settings/budgets.
//
// SEPARATE FROM `/api/v1/budgets/**` ON PURPOSE. The v1 surface authenticates
// by API key, and an API key carries no role — so it cannot gate a privileged
// act. A Clerk session carries the membership these mutations are gated on.
// Mixing the two auth models in one route is how a future edit reaches for the
// wrong one; the same split, for the same reason, as convex/budget_gate.ts
// versus convex/budgets.ts.
//
// ROLE ENFORCEMENT IS CONVEX'S, NOT THIS LAYER'S. `createBudget` is admin-gated
// there and this route does not re-check it — a duplicated check is a check
// that can disagree, and the one that matters is the one nearest the data.
// ---------------------------------------------------------------------------

// GET /api/budgets — list every budget configured for the caller's org.
export const GET = withApiHandler(
  '/api/budgets',
  async (_req: NextRequest, ctx) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(authResult.orgId)

    try {
      // NOT wrapped in a catch-and-return-[] — see services/budgets.ts. An
      // empty list and a failed read must reach the client as different things.
      const budgets = await listBudgets()
      return NextResponse.json({ budgets })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 180 } },
)

// POST /api/budgets — create a budget definition. ADMIN-gated and audited
// server-side (CLAUDE.md Event Log Rule 6).
export const POST = withApiHandler(
  '/api/budgets',
  async (req: NextRequest, ctx) => {
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

    const parsed = parseCreateBudgetBody(raw)
    if (!parsed.ok) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: parsed.message },
        { status: 422 },
      )
    }

    try {
      const budgetId = await createBudget(parsed.body)
      return NextResponse.json({ budgetId }, { status: 201 })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)
