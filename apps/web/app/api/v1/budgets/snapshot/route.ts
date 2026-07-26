import { type NextRequest, NextResponse } from 'next/server'

import { fieldsInvalidArgument, parseFieldsParam } from '../../_lib/fieldsParam'

import { mapApiErrorV1, v1InvalidArgument, v1UnauthorizedNoKey } from '@/lib/apiErrorMapping'
import { withApiHandler } from '@/lib/apiHandler'
import { apiV1Envelope } from '@/lib/apiV1Envelope'
import { hashApiKey } from '@/lib/convexServer'
import { apiGetBudgetSnapshot } from '@/lib/services/api_v1_budgets'

// ---------------------------------------------------------------------------
// GET /api/v1/budgets/snapshot — "may this agent spend any more?"
//
// x-api-key auth, org-scoped. Wraps convex/budget_gate.ts `sdkCheckBudget`,
// which resolves the key, enforces its own scope requirement, and computes the
// snapshot fresh. Powers `FlightReader.getBudgetSnapshot` and `afr budget`.
//
// THIS IS THE CHEAP ASK AND THE CHEAPNESS IS THE FEATURE. The contract's design
// is one round trip per shelf life, not one per model call: the SDK holds the
// snapshot and `BudgetGuard.check()` is synchronous. A breaker nobody can
// afford to consult is not enforcement — it is a check that gets commented out
// the first time somebody profiles the loop.
//
// SCOPE NOTE: the gate requires `ingest:write`, NOT `read`, and that is
// deliberate — this is a PRE-WRITE check, semantically part of the write path
// the key already holds. Requiring `read` would deny every key scoped exactly
// `["ingest:write"]`, which is the overwhelmingly common SDK key, turning a new
// advisory surface into a breaking change for every deployed recorder.
//
// ---------------------------------------------------------------------------
// A SUBJECT IS REQUIRED, AND THERE IS DELIBERATELY NO "WHOLE ORG" DEFAULT
// ---------------------------------------------------------------------------
//
// Omitting every id would be read as "every breaker in the org", which silently
// CHANGES MEANING the day somebody adds an org-wide budget — and it changes it
// in the direction that withholds. The SDK raises before it sends for the same
// reason; this route refuses on arrival so a hand-rolled client gets the same
// answer. The refusal is emitted BEFORE the key is resolved, so a malformed
// request cannot be used to probe whether a key is valid.
// ---------------------------------------------------------------------------
export const GET = withApiHandler(
  '/api/v1/budgets/snapshot',
  async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const runId = sp.get('runId')
    const agentId = sp.get('agentId')
    const projectId = sp.get('projectId')

    // Parameter validation FIRST, before the key is touched. That ordering is
    // what keeps a malformed request from being an existence oracle: the
    // response below is identical whether the key is valid, invalid, or absent.
    if (
      (runId === null || runId === '') &&
      (agentId === null || agentId === '') &&
      (projectId === null || projectId === '')
    ) {
      return v1InvalidArgument(
        'name a subject: one or more of runId, agentId, projectId. There is deliberately no "everything in the ' +
          'org" default — a breaker check whose subject is implicit changes meaning the day an org-wide budget is ' +
          'added, and it changes it in the direction that withholds.',
        ctx.requestId,
      )
    }

    // `fields` is REFUSED on this route rather than honoured, and this is the
    // one v1 read surface where that is the right answer.
    //
    // A snapshot is not a document, it is an ANSWER, and every field of it is
    // load-bearing for the gate that consumes it: `scan.budgetsInScope` versus
    // `scan.budgetsEvaluated` is the difference between a complete evaluation
    // and a partial one; `scan.subject` is what proves the answer is about the
    // subject that was asked about; each state's `undeterminedBecause` /
    // `trippedBecause` is the reason a decline can be explained at all. A
    // PROJECTED SNAPSHOT IS AN UNENFORCEABLE ONE — contracts'
    // `snapshotUnusableFields` reports the stripped body as malformed, and
    // `decideBudget` then treats it as NO ANSWER. So honouring the parameter
    // would hand back a 200 whose only possible effect on a client is to
    // degrade every decision it makes, silently.
    //
    // Shape is still validated with the shared helper before the refusal, so a
    // malformed `fields` gets the same message here as everywhere else.
    const fields = parseFieldsParam(sp)
    if (!fields.ok) {
      return fieldsInvalidArgument(fields.message, ctx.requestId)
    }
    if (fields.fields !== undefined) {
      return v1InvalidArgument(
        'fields projection is not supported on this route. Every field of a breaker snapshot is required by the ' +
          'client-side gate that reads it — a projected snapshot is refused as malformed and degrades every ' +
          'decision made from it to "no answer". Omit the fields parameter.',
        ctx.requestId,
      )
    }

    const apiKey = req.headers.get('x-api-key')
    if (!apiKey) {
      return v1UnauthorizedNoKey(ctx.requestId)
    }

    try {
      const result = await apiGetBudgetSnapshot(hashApiKey(apiKey), {
        ...(runId !== null && runId !== '' && { runId }),
        ...(agentId !== null && agentId !== '' && { agentId }),
        ...(projectId !== null && projectId !== '' && { projectId }),
      })
      return NextResponse.json(apiV1Envelope(result, ctx.requestId))
    } catch (err) {
      const mapped = mapApiErrorV1(err, ctx.requestId)
      if (mapped) return mapped
      throw err
    }
  },
  // Same ingest-key rate class as the other v1 read routes. Deliberately NOT
  // tighter: the contract's whole affordability argument is that a caller must
  // never be discouraged from asking, and must never be able to exhaust its own
  // ingest allowance by checking whether it may ingest.
  { rateLimit: { key: 'apiKey', limitPerMin: 300 } },
)
