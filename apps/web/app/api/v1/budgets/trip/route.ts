import { type NextRequest } from 'next/server'

import { v1NotImplemented } from '../../_lib/notImplemented'

import { v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { parseBudgetMutationBody } from '@/lib/budgets/mutationRequest'

// ---------------------------------------------------------------------------
// POST /api/v1/budgets/trip — trip a breaker by hand. PRIVILEGED WRITE.
//
// x-api-key auth, org-scoped. Member-permitted (not admin): tripping WITHHOLDS,
// and its cost is delay. `POST /api/v1/budgets/reset` is the admin-gated one,
// because resetting resumes spend with no ceiling in front of it. The asymmetry
// is the risk's own — requiring an admin to be awake to pull the cord was the
// wrong constraint at 3am.
//
// The act is audited SERVER-SIDE into the append-only admin audit log (CLAUDE.md
// Event Log Rule 6) under the actor's real id. This layer does not write the
// audit row and must not: an audit written by the caller's own transport is one
// the caller can omit.
//
// `reason` is REQUIRED and is never defaulted anywhere in this path. A manual
// trip has no meter reading behind it, so the audit entry's only content is the
// sentence a human wrote.
//
// ---------------------------------------------------------------------------
// WHAT THIS ROUTE CANNOT DO YET, AND WHY IT SAYS SO INSTEAD OF GUESSING
// ---------------------------------------------------------------------------
//
// The act itself needs a Convex mutation that (a) authenticates by API KEY
// rather than by Clerk session and (b) resolves a ROLE for that key. Neither
// exists: `convex/budgets.ts`'s `tripBudget` is Clerk-authed
// (`requireOrgMembership`), and an API key carries no role at all — the scope
// vocabulary is `ingest:write` / `ingest:read` / `read`, with nothing that
// means "may perform a privileged act". Those files are the data boundary's
// (CLAUDE.md File Ownership Map) and are not this team's to change.
//
// Inventing an admin check in this layer was the alternative and it is worse
// than a 501: the web tier cannot see a key's org or its holder's membership
// without asking Convex, so any check written here would be a check written
// against data it does not have. A privileged mutation gated by a guess is not
// gated.
//
// So the route authenticates, validates, and then refuses LOUDLY. Everything
// above the final step is the real surface and does not change when the backend
// path lands. Until then, the Clerk-authed twin at
// `POST /api/budgets/[budgetId]/trip` serves the web UI, where a session
// carries the role this one lacks.
// ---------------------------------------------------------------------------
export const POST = withApiHandler(
  '/api/v1/budgets/trip',
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
      'Tripping a breaker over an API key is not available in this deployment. The act is admin-audited and ' +
        'role-gated server-side, and an API key carries no role — the backing key-authenticated mutation does not ' +
        'exist yet (convex/budgets.ts trip/reset authenticate by Clerk session). Trip this breaker from the web UI ' +
        'at /settings/budgets, where the session carries the membership this credential does not.',
      ctx.requestId,
    )
  },
  // Write rate class, keyed on the API key. Deliberately far below the read
  // route's 300/min: this is a privileged act, and a privileged act performed
  // hundreds of times a minute is not an operator.
  { rateLimit: { key: 'apiKey', limitPerMin: 30 } },
)
