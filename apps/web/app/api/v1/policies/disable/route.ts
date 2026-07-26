import { type NextRequest } from 'next/server'

import { v1NotImplemented } from '../../_lib/notImplemented'

import { v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseDisablePolicyBody } from '@/lib/policies/mutationRequest'

// ---------------------------------------------------------------------------
// POST /api/v1/policies/disable — switch a policy off. PRIVILEGED WRITE,
// ADMIN-ONLY, AUDITED.
//
// THERE IS DELIBERATELY NO DELETE ROUTE, HERE OR ANYWHERE. A policy that
// governed recorded runs is part of how those runs were judged: every outcome it
// produced carries `violatedPolicyRevision` / `undecidedPolicyRevision`, and
// removing the row would leave those pointing at nothing. Disabling is the
// operation, it is audited, and `disabledAt` is kept as a historical marker that
// is never cleared on re-enable.
//
// `reason` IS REQUIRED AND NEVER DEFAULTED. It is written to the append-only
// admin audit log (CLAUDE.md Event Log Rule 6), and disabling a control is
// exactly the act whose audit row is worthless without one: "somebody turned off
// the rule about shell execution" and "somebody turned off the rule about shell
// execution because the tool was renamed" are the same row otherwise.
//
// A DISABLED POLICY GOVERNS NOTHING, and it is NOT a policy that was evaluated
// and satisfied. Nothing in this product may report it among the policies it
// checked.
//
// The ordering — auth, then validation, then the 501 — and the reason the final
// step is a 501 rather than a body are the same as the sibling upsert route; see
// its header. In short: `convex/policies.ts`'s `disablePolicy` is gated on an
// admin MEMBERSHIP, and an API key carries no membership. The Clerk-authed twin
// at POST /api/policies/[policyId]/disable serves the web UI.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/v1/policies/disable',
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

    const parsed = parseDisablePolicyBody(raw)
    if (!parsed.ok) {
      return v1InvalidArgument(parsed.message, ctx.requestId)
    }

    return v1NotImplemented(
      'Disabling a policy over an API key is not available in this deployment. The act is admin-audited and ' +
        'role-gated server-side (convex/policies.ts disablePolicy requires an admin membership), and an API key ' +
        'carries no role — the backing key-authenticated mutation does not exist. Disable this policy from the ' +
        'web UI at /settings/policies, where the session carries the membership this credential does not. This ' +
        'route fails rather than no-ops on purpose: an operator who believes a control was switched off, and ' +
        'whose runs are still being graded against it, has been told something false in the direction that ' +
        'produces surprise findings.',
      ctx.requestId,
    )
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 30 } },
)
