import { type NextRequest } from 'next/server'

import { v1NotImplemented } from '../../_lib/notImplemented'

import { v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseUpsertPolicyBody } from '@/lib/policies/mutationRequest'

// ---------------------------------------------------------------------------
// POST /api/v1/policies/upsert — define or replace a policy. PRIVILEGED WRITE,
// ADMIN-ONLY, AUDITED.
//
// A policy says what must not happen. NOTE WHAT THE REQUEST DELIBERATELY CANNOT
// CARRY, and what cannot be added without reopening ADR-009's invariant 0: no
// `action`, no `onViolation`, no `severity` that gates recording. There is no
// field here that says what to do to the event showing the act happened,
// because the answer is always the same — record it. The breach is the most
// valuable row in the log and the exact run a regulator will ask for.
//
// SEPARATE FROM THE DISABLE ROUTE, deliberately, and the split is contracts'
// (`UpsertPolicyRequest` versus `DisablePolicyRequest`): changing what a policy
// forbids and switching it off are different acts with different blast radii,
// and an operator who wanted the second must not be able to do the first by
// supplying one extra field.
//
// ---------------------------------------------------------------------------
// THE ORDERING: AUTH, THEN VALIDATION, THEN THE 501
// ---------------------------------------------------------------------------
//
// A privileged mutation has exactly two acceptable behaviours — perform the act
// and audit it, or fail LOUDLY. The one thing it must never do is look like it
// worked, because a policy an operator believes exists and does not is a
// compliance gap wearing a green tick, and it will be discovered by an incident
// rather than by a screen.
//
// So the surface a client integrates against is the real one: a missing key is
// still a 401, a rule this backend cannot store is still a 400 naming exactly
// why, and neither response changes when the backing mutation lands. Only the
// final step changes.
//
// WHY THE FINAL STEP IS A 501. `convex/policies.ts`'s `createPolicy` and
// `updatePolicy` call `getAuthContext` + `requireOrgMembership(..., { minimumRole:
// "admin" })`. AN API KEY CARRIES NO ROLE — it is a credential, not a
// membership — so there is nothing for the admin gate to check, and a
// key-authenticated policy write would either bypass the gate or need a second
// authorization model invented at this layer. Neither is acceptable for the
// mutation that defines what an org's compliance controls ARE. The Clerk-authed
// twin at POST /api/policies serves the web UI, where the session carries the
// membership.
//
// `packages/cli/src/apiClient.ts`'s `upsertPolicy` documents this route as the
// web layer's to build and its absence as the honest interim outcome. This is
// that route, built up to the boundary the data layer owns.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/v1/policies/upsert',
  async (req: NextRequest, ctx) => {
    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return v1InvalidArgument('body must be valid JSON', ctx.requestId)
    }

    // Validated in full even though this route cannot write, so the errors a
    // client integrates against are the real ones. No org id is passed or
    // needed: a policy's org is the `orgId` argument of the Convex mutation,
    // resolved from the caller's credential server-side and never taken from the
    // body (CLAUDE.md Tenancy Rules).
    const parsed = parseUpsertPolicyBody(raw)
    if (!parsed.ok) {
      return v1InvalidArgument(parsed.message, ctx.requestId)
    }

    return v1NotImplemented(
      'Defining a policy over an API key is not available in this deployment. The act is admin-audited and ' +
        'role-gated server-side (convex/policies.ts createPolicy/updatePolicy require an admin membership), and ' +
        'an API key carries no role — the backing key-authenticated mutation does not exist. Define this policy ' +
        'from the web UI at /settings/policies, where the session carries the membership this credential does ' +
        'not. This route fails rather than no-ops on purpose: a policy you believe exists and which does not is a ' +
        'control that grades nothing while appearing to be in force.',
      ctx.requestId,
    )
  },
  // Tighter than the read routes. A definition write is rare, human-initiated
  // and audited; there is no loop that needs to afford it.
  { rateLimit: { key: 'apiKey', limitPerMin: 30 } },
)
