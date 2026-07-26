/**
 * services/api_v1_budgets.ts — key-authed service layer for the budget
 * surfaces of the public `/api/v1/**` API.
 *
 * Same posture as services/api_v1.ts: authenticates via `x-api-key` (hashed,
 * forwarded to Convex) rather than a Clerk session, and org scoping happens
 * INSIDE the Convex function. This layer never sees or needs an orgId — the
 * key-authed gate deliberately has no `orgId` argument at all, so a caller
 * cannot name an organization and therefore cannot name someone else's.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE PASSES THE SNAPSHOT THROUGH UNTOUCHED
 * ---------------------------------------------------------------------------
 *
 * Every other v1 service maps, projects or reshapes what Convex returns. This
 * one does not, and the restraint is the feature.
 *
 * A `BreakerSnapshot` is not a document — it is an ANSWER, and the fields that
 * say how much of an answer it is (`scan.budgetsInScope`,
 * `scan.budgetsEvaluated`, `scan.evaluationTruncated`, `scan.subject`,
 * `evaluatedAt`, `freshUntil`, and each state's own reason strings) are exactly
 * the ones a reshaping layer drops first, because they look like metadata. They
 * are not metadata. The SDK's gate refuses a snapshot missing any of them, and
 * `decideBudget` reads every one of them to tell a complete evaluation from a
 * partial one. A snapshot that lost `scan` would make an UNEVALUATED subject
 * indistinguishable from an UNBUDGETED one — "no breakers found" reading as "no
 * budget applies".
 *
 * So the rule for this file is absolute: THE SNAPSHOT IS FORWARDED BYTE FOR
 * BYTE. No mapping function, no field picking, no defaulting, no normalising.
 * `tests/unit/budget_ui_snapshot_passthrough.test.ts` pins it by round-tripping
 * a fully-populated snapshot through {@link budgetSnapshotEnvelope} and
 * deep-equalling the result.
 *
 * NOTE THIS LAYER DOES NOT VALIDATE THE SNAPSHOT EITHER. The SDK applies
 * `assertBreakerSnapshotTrustworthy` on receipt and the CLI routes through the
 * same gate. Rejecting here as well would mean two gates that can disagree
 * about what is enforceable, and the one that matters is the one in the process
 * that acts on the answer.
 */
import type { BreakerSnapshot } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getPublicClient, withConvexTimeout } from '@/lib/convexServer'

/** Subject narrowing accepted by `GET /api/v1/budgets/snapshot`. The key supplies the org. */
export interface ApiV1BudgetSnapshotParams {
  runId?: string
  agentId?: string
  projectId?: string
}

/**
 * The `data` payload of `GET /api/v1/budgets/snapshot`.
 *
 * Matches `V1BudgetSnapshotData` in `packages/sdk/src/reader.ts` — the SDK
 * reads `data.snapshot` and hands it straight to `BudgetGuard.absorbSnapshot`.
 */
export interface ApiV1BudgetSnapshotData {
  snapshot: BreakerSnapshot
}

/**
 * Wrap whatever the gate returned as the route's `data` payload, WITHOUT
 * touching it.
 *
 * A one-line function purely so the pass-through is a thing a test can hold and
 * a future edit has to walk past a doc comment to break.
 */
export function budgetSnapshotEnvelope(raw: unknown): ApiV1BudgetSnapshotData {
  return { snapshot: raw as BreakerSnapshot }
}

/**
 * Evaluate every breaker governing a subject, for an API key's org.
 *
 * Ids are forwarded EXPLICITLY. This crosses the hand-maintained
 * `makeFunctionReference` seam, where a dropped field is not a type error — and
 * a dropped `runId` does not fail, it returns a well-formed snapshot ABOUT A
 * DIFFERENT SUBJECT. (The SDK catches that one on receipt by comparing
 * `scan.subject` against what it asked for; that is a backstop, not a licence
 * to be careless here.)
 */
export async function apiGetBudgetSnapshot(
  apiKeyHash: string,
  params: ApiV1BudgetSnapshotParams,
): Promise<ApiV1BudgetSnapshotData> {
  const client = getPublicClient()
  const raw = await withConvexTimeout(
    client.query(convex.budget_gate.sdkCheckBudget, {
      apiKeyHash,
      ...(params.runId !== undefined && { runId: params.runId }),
      ...(params.agentId !== undefined && { agentId: params.agentId }),
      ...(params.projectId !== undefined && { projectId: params.projectId }),
    }),
  )
  return budgetSnapshotEnvelope(raw)
}
