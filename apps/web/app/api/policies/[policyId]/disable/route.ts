import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { setPolicyEnabled } from '@/lib/services/policies'

// ---------------------------------------------------------------------------
// POST /api/policies/[policyId]/disable — switch a policy on or off.
// ADMIN-gated and audited server-side. Clerk-authed; backs /settings/policies.
//
// ITS OWN ROUTE RATHER THAN A FIELD ON THE UPSERT, and the reason is contracts'
// split between `UpsertPolicyRequest` and `DisablePolicyRequest`: changing what
// a policy forbids and switching it off are different acts with different blast
// radii. An operator who wanted the second must not be able to do the first by
// supplying one extra field.
//
// `reason` IS REQUIRED AND NEVER DEFAULTED — it is written to the append-only
// admin audit log, and an audit row that records a control was switched off
// without recording why is a row nobody can act on six months later.
//
// THERE IS NO DELETE ROUTE. A policy that governed recorded runs is part of how
// those runs were judged.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/policies/[policyId]/disable',
  async (req: NextRequest, ctx) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) {
      return NextResponse.json<ApiError>(
        { code: 'UNAUTHORIZED', message: 'Authentication required' },
        { status: 401 },
      )
    }
    ctx.setOrgId(authResult.orgId)

    // The id comes from the PATH. It is not read from the body as well: two
    // sources for one id is a route that can be asked to disable one policy
    // while its audit trail names another.
    const policyId = req.nextUrl.pathname.split('/').at(-2) ?? ''
    if (policyId === '') {
      return NextResponse.json<ApiError>(
        { code: 'INVALID_ARGUMENT', message: 'policyId is required in the path' },
        { status: 400 },
      )
    }

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json<ApiError>(
        { code: 'INVALID_ARGUMENT', message: 'body must be valid JSON' },
        { status: 400 },
      )
    }

    const body = raw as { reason?: unknown; enabled?: unknown }
    if (typeof body?.reason !== 'string' || body.reason.length === 0) {
      return NextResponse.json<ApiError>(
        {
          code: 'INVALID_ARGUMENT',
          message:
            'reason is required and must be a non-empty string. It is written to the append-only admin audit log, ' +
            'and a defaulted reason records that a control was switched off without recording why.',
        },
        { status: 400 },
      )
    }
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json<ApiError>(
        {
          code: 'INVALID_ARGUMENT',
          message:
            'enabled is required and must be a boolean. It is never inferred from the route name: re-enabling a ' +
            'control and switching it off are both audited acts and both must be stated explicitly.',
        },
        { status: 400 },
      )
    }

    try {
      await setPolicyEnabled(policyId, body.enabled, body.reason)
      return NextResponse.json({ policyId, enabled: body.enabled }, { status: 200 })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 30 } },
)
