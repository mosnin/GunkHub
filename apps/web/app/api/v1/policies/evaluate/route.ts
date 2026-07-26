import { type NextRequest } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../_lib/fieldsParam'
import { v1NotImplemented } from '../../_lib/notImplemented'

import { v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'

// ---------------------------------------------------------------------------
// GET /api/v1/policies/evaluate — "what does the record show?", asked AFTER.
//
// The retrospective half of ADR-009, and the read-only one. It computes nothing
// that changes what an agent does; it reports what the log shows and, far more
// often, what the log CANNOT show.
//
// ===========================================================================
// `?fields=` IS REFUSED HERE, AND THIS IS THE ONE ROUTE WHERE THAT REFUSAL IS
// NOT MERELY ABOUT USEFULNESS
// ===========================================================================
//
// On `/api/v1/budgets/snapshot` the argument for refusing a projection is that
// it DEGRADES the answer: contracts reports the stripped body as malformed and
// `decideBudget` treats it as no answer. The caller is worse off, but the
// failure points the safe way.
//
// HERE IT POINTS THE OTHER WAY, and that is the whole reason this parameter gets
// a decision rather than a copy-paste.
//
// A compliance report's honesty lives in fields that LOOK LIKE METADATA and are
// therefore exactly what a projection strips first:
//
//   `scan.runsRead` vs `scan.runsInScope`   the difference between "we checked
//                                            every run" and "we checked four of
//                                            two hundred".
//   `scan.evaluationTruncated`              whether every count is a floor.
//   `scan.retentionHorizon`                 whether the window's runs were
//                                            PURGED under ADR-001 — the state
//                                            where a report goes clean by
//                                            elapsed time, which will happen
//                                            without anyone deciding it.
//   `scan.orderingCaveat`                   whether a cited sequence number is
//                                            arrival order (ADR-007) rather
//                                            than occurrence order.
//   each outcome's `notEvaluableBecause` / `wouldBeEvaluableBy`
//                                            the entire content of "we could not
//                                            look". Strip them and a
//                                            not-evaluable outcome is an outcome
//                                            with no text.
//
// And the sharpest one: `?fields=scan` REMOVES `outcomes` ENTIRELY. That strips
// every PROVEN VIOLATION out of a compliance report while leaving a body that
// still parses, still carries a scan, and still yields a verdict. A caller — or
// a screenshot, or a questionnaire attachment — then holds a document that says
// a scan ran and shows nothing found.
//
// THAT IS THE FAILURE ADR-009 WAS WRITTEN TO PREVENT, REACHABLE IN ONE QUERY
// PARAMETER, and no amount of client-side care fixes it because the caller
// cannot tell a projected clean from a real one. Stripping a coverage proof
// turns a withheld answer into an apparent clean one; stripping the outcomes
// turns a breach into one. Neither is a projection this API will serve.
//
// The refusal runs BEFORE the key is resolved, so it is not an existence oracle,
// and shape is validated with the shared helper first so a malformed `fields`
// gets the same message here as everywhere else.
//
// ===========================================================================
// WHY THE FINAL STEP IS A 501 AND NOT A BODY
// ===========================================================================
//
// There is no key-authenticated evaluation function in `convex/`.
// `policies:evaluateRunAgainstPolicies` and `policies:scanRunsAgainstPolicy`
// both call `getAuthContext` + `requireOrgMembership`, which resolve a CLERK
// session; an API key carries no session and no role.
// `convex/policy_gate.ts` — the file that exists precisely to serve key-authed
// callers without reaching for Clerk — exposes only `sdkCheckPolicy`, the
// pre-flight listing.
//
// The alternative to this 501 is not a working route. It is either a route that
// 404s (which a client reads as "wrong URL" and a human reads as "not deployed
// yet"), or a route that quietly returns an empty evaluation — and an empty
// evaluation on a compliance surface is the exact sentence this feature must
// never produce. Auth and validation run FIRST, so the surface a client
// integrates against is the real one and only the final step changes when the
// backend lands.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/policies/evaluate',
  // `require-await` is suppressed rather than satisfied, and the suppression is
  // a MARKER RATHER THAN A WORKAROUND. `withApiHandler` requires a handler
  // returning `Promise<Response>`, and this one has nothing to await for exactly
  // one reason: it never reaches a backend. Every line below is real — the
  // subject check, the `fields` refusal, the key check — and the moment a
  // key-authenticated evaluation query exists in `convex/`, the `await` on it
  // lands here and this comment goes with it. Restructuring the handler to
  // dodge the rule (a bare `Promise.resolve` wrapper) would hide that, and the
  // signature this route must eventually have is the async one.
  // eslint-disable-next-line @typescript-eslint/require-await
  async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const projectId = sp.get('projectId')
    const agentId = sp.get('agentId')
    const environment = sp.get('environment')
    const runId = sp.get('runId')
    const orgWide = sp.get('orgWide')

    const named = [projectId, agentId, environment, runId].filter(
      (value) => value !== null && value !== '',
    )
    if (named.length === 0 && orgWide !== 'true') {
      return v1InvalidArgument(
        'name a subject: one or more of projectId, agentId, environment, runId — or pass orgWide=true to ask ' +
          'about the org explicitly. An evaluation whose subject is implicit is a compliance answer about a scope ' +
          'nobody named.',
        ctx.requestId,
      )
    }
    if (orgWide !== null && orgWide !== 'true') {
      return v1InvalidArgument(
        'orgWide, when supplied, must be exactly "true". It is an explicit opt-in and never a default.',
        ctx.requestId,
      )
    }

    const fields = parseFieldsParam(sp)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }
    if (fields.fields !== undefined) {
      return v1InvalidArgument(
        'fields projection is not supported on this route, and will not be. An evaluation is a compliance report ' +
          'whose honesty lives in the fields a projection strips first: scan.runsRead against scan.runsInScope, ' +
          'scan.evaluationTruncated, scan.retentionHorizon, and each outcome\'s own reason and next action. A ' +
          'projection can also remove the outcomes entirely, which strips every proven violation out of the ' +
          'report while leaving a body that still parses and still yields a verdict — a withheld answer served as ' +
          'an apparent clean one. Omit the fields parameter and read the whole report.',
        ctx.requestId,
      )
    }

    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    return v1NotImplemented(
      'Evaluating policies over recorded runs is not available over an API key in this deployment. The evaluation ' +
        'surface (convex/policies.ts `evaluateRunAgainstPolicies` and `scanRunsAgainstPolicy`) authenticates by ' +
        'Clerk session, and convex/policy_gate.ts — the key-authed door — exposes only the pre-flight listing at ' +
        'GET /api/v1/policies/snapshot. A key-authenticated evaluation query is the data boundary\'s to add; this ' +
        'route fails loudly rather than returning an empty evaluation, because an empty compliance report and a ' +
        'clean one are indistinguishable to whoever reads it next. Evaluate from the web UI at ' +
        '/settings/policies, where the session carries the membership this credential does not.',
      ctx.requestId,
    )
  },
  { rateLimit: { key: 'apiKey', limitPerMin: 120 } },
)
