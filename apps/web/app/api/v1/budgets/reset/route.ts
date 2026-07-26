import { type NextRequest } from 'next/server'

import { v1NotImplemented } from '../../_lib/notImplemented'

import { v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseBudgetMutationBody } from '@/lib/budgets/mutationRequest'

// ---------------------------------------------------------------------------
// POST /api/v1/budgets/reset — clear a trip. PRIVILEGED WRITE, ADMIN-ONLY.
//
// x-api-key auth, org-scoped. Stricter than the sibling trip route on purpose,
// and the difference must not be evened out: tripping withholds and costs
// delay; resetting RESUMES SPEND with no ceiling in front of it, and it
// additionally begins a new accounting period, which discards the breaching
// spend from the window. That is why the audit row is the only place the
// discarded fact survives, and why `reason` is required and never defaulted.
//
// SEPARATE FROM THE CONFIG ROUTE, deliberately: raising a limit and clearing a
// trip are different acts with different blast radii, and an operator who
// wanted the second must not be able to do the first by supplying one extra
// field. Raising a limit is also not a decision that the earlier, proven breach
// did not happen — only this route clears one.
//
// The 501 below, and the ordering that puts auth and validation before it, are
// explained in full on the sibling route
// (`apps/web/app/api/v1/budgets/trip/route.ts`): the act needs a
// key-authenticated, role-resolving Convex mutation that does not exist, and
// the data boundary owns that file. The Clerk-authed twin at
// `POST /api/budgets/[budgetId]/reset` serves the web UI in the meantime.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/v1/budgets/reset',
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

    const parsed = parseBudgetMutationBody(raw)
    if (!parsed.ok) {
      return v1InvalidArgument(parsed.message, ctx.requestId)
    }

    return v1NotImplemented(
      'Resetting a breaker over an API key is not available in this deployment. The act is admin-audited and ' +
        'role-gated server-side, and an API key carries no role — the backing key-authenticated mutation does not ' +
        'exist yet (convex/budgets.ts trip/reset authenticate by Clerk session). Reset this breaker from the web ' +
        'UI at /settings/budgets, where the session carries the membership this credential does not.',
      ctx.requestId,
    )
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 30 } },
)
