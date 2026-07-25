import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { deleteBudget, updateBudget } from '@/lib/services/budgets'

interface RouteParams {
  params: { budgetId: string }
}

// ---------------------------------------------------------------------------
// PATCH /api/budgets/[budgetId] — change a budget's configuration.
// DELETE /api/budgets/[budgetId] — remove it.
//
// Both ADMIN-gated and audited server-side; Convex enforces the role.
//
// NOTE WHAT PATCH CANNOT DO: clear a trip. There is no `trippedAt` field to
// send and there deliberately is not one — raising a limit is not a decision
// that the earlier, proven breach did not happen. Clearing a trip is
// POST /api/budgets/[budgetId]/reset, a different act with a different blast
// radius, and an operator who wanted that one must not be able to reach it by
// adding a field to this one.
//
// DELETE removes the row and NOT the audit trail. Deleting a tripped budget is
// the obvious way to make a breaker stop withholding, so the record that it
// existed, tripped and was removed has to outlive it — convex/audit.ts has no
// delete path.
// ---------------------------------------------------------------------------
export const PATCH = withApiHandler(
  '/api/budgets/[budgetId]',
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
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'body must be a JSON object' },
        { status: 422 },
      )
    }
    const body = raw as Record<string, unknown>

    const name = body['name']
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'name, when supplied, must be a non-empty string' },
        { status: 422 },
      )
    }
    const enabled = body['enabled']
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'enabled, when supplied, must be a boolean' },
        { status: 422 },
      )
    }
    const limitAmount = body['limitAmount']
    if (
      limitAmount !== undefined &&
      (typeof limitAmount !== 'number' || !Number.isInteger(limitAmount) || limitAmount <= 0)
    ) {
      return NextResponse.json<ApiError>(
        {
          code: 'VALIDATION_ERROR',
          message: "limitAmount, when supplied, must be a positive integer in the meter's own unit",
        },
        { status: 422 },
      )
    }
    const rearm = body['rearmOnPeriodRoll']
    if (rearm !== undefined && typeof rearm !== 'boolean') {
      return NextResponse.json<ApiError>(
        { code: 'VALIDATION_ERROR', message: 'rearmOnPeriodRoll, when supplied, must be a boolean' },
        { status: 422 },
      )
    }

    try {
      await updateBudget(params.budgetId, {
        ...(name !== undefined && { name: (name).trim() }),
        ...(enabled !== undefined && { enabled }),
        ...(limitAmount !== undefined && { limitAmount }),
        ...(rearm !== undefined && { rearmOnPeriodRoll: rearm }),
      })
      return NextResponse.json({ ok: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)

export const DELETE = withApiHandler(
  '/api/budgets/[budgetId]',
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
      await deleteBudget(params.budgetId)
      return NextResponse.json({ ok: true })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 60 } },
)
