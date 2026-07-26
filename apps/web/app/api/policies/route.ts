import { auth } from '@clerk/nextjs/server'
import { type NextRequest, NextResponse } from 'next/server'

import type { ApiError } from '@agent-flight-recorder/contracts'

import { hasOrgAuthContext } from '@/lib/apiAuthGuard'
import { mapApiError } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseUpsertPolicyBody } from '@/lib/policies/mutationRequest'
import { createPolicy, listPolicies, updatePolicy } from '@/lib/services/policies'

// ---------------------------------------------------------------------------
// /api/policies — the Clerk-authed management surface for declarative policy,
// backing the web UI at /settings/policies.
//
// SEPARATE FROM `/api/v1/policies/**` ON PURPOSE, and the separation is the
// whole reason this file exists. The v1 surface authenticates by API key, and an
// API key carries no role — so it cannot gate a privileged act. A Clerk session
// carries the membership these mutations are gated on. Mixing the two auth
// models in one route is how a future edit reaches for the wrong one; the same
// split, for the same reason, as convex/policy_gate.ts versus convex/policies.ts.
//
// ROLE ENFORCEMENT IS CONVEX'S, NOT THIS LAYER'S. `createPolicy` and
// `updatePolicy` are admin-gated and audited there, and this route does not
// re-check — a duplicated check is a check that can disagree, and the one that
// matters is the one nearest the data.
// ---------------------------------------------------------------------------

function unauthorized(): NextResponse {
  return NextResponse.json<ApiError>(
    { code: 'UNAUTHORIZED', message: 'Authentication required' },
    { status: 401 },
  )
}

/**
 * GET /api/policies — every policy defined in the caller's org.
 *
 * NOT wrapped in a catch-and-return-[]. An empty list and a failed read reach
 * the client as different things, because an org with no controls and an org
 * whose controls could not be read must never produce the same screen.
 */
export const GET = withApiHandler(
  '/api/policies',
  async (_req: NextRequest, ctx) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) return unauthorized()
    ctx.setOrgId(authResult.orgId)

    try {
      const read = await listPolicies()
      return NextResponse.json(read)
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 180 } },
)

/**
 * POST /api/policies — define or replace a policy. ADMIN-gated and audited
 * server-side (CLAUDE.md Event Log Rule 6).
 *
 * The body is contracts' `UpsertPolicyRequest`. `policyId` present means
 * replace; absent means create. `enabled` is honoured only on CREATE — on a
 * replace, changing whether a policy is in force goes through
 * `/api/policies/[policyId]/disable`, which requires a reason for the audit log.
 * That split is contracts', not this route's invention.
 */
export const POST = withApiHandler(
  '/api/policies',
  async (req: NextRequest, ctx) => {
    const authResult = auth()
    if (!hasOrgAuthContext(authResult)) return unauthorized()
    ctx.setOrgId(authResult.orgId)

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json<ApiError>(
        { code: 'INVALID_ARGUMENT', message: 'body must be valid JSON' },
        { status: 400 },
      )
    }

    try {
      const parsed = parseUpsertPolicyBody(raw)
      if (!parsed.ok) {
        return NextResponse.json<ApiError>(
          { code: 'INVALID_ARGUMENT', message: parsed.message },
          { status: 400 },
        )
      }

      // The org is NOT read from the body. `createPolicy` resolves it from the
      // session (CLAUDE.md Tenancy Rules) and `convex/policies.ts` checks an
      // admin membership against it.
      const { policyId } = parsed.value
      if (policyId !== undefined) {
        await updatePolicy(policyId, parsed.value)
        return NextResponse.json({ policyId }, { status: 200 })
      }
      const created = await createPolicy(parsed.value)
      return NextResponse.json({ policyId: created }, { status: 201 })
    } catch (err) {
      const mapped = mapApiError(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  { rateLimit: { key: 'org', limitPerMin: 30 } },
)
