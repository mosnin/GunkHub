/**
 * services/api_v1_policies.ts — key-authed service layer for the policy
 * surfaces of the public `/api/v1/**` API.
 *
 * Same posture as services/api_v1_budgets.ts: authenticates via `x-api-key`
 * (hashed, forwarded to Convex), and org scoping happens INSIDE the Convex
 * function. This layer never sees or needs an orgId — the key-authed gate
 * deliberately has no `orgId` argument at all.
 *
 * ===========================================================================
 * WHY THIS FILE MAPS WHERE ITS BUDGET SIBLING FORWARDS BYTE FOR BYTE
 * ===========================================================================
 *
 * `services/api_v1_budgets.ts` forwards a `BreakerSnapshot` untouched, because
 * `convex/budget_gate.ts` already speaks contracts' vocabulary and every field
 * is load-bearing for the client-side gate.
 *
 * `convex/policy_gate.ts` does NOT speak contracts' vocabulary. It returns
 * `convex/helpers/policy.ts`'s `LocalPolicySnapshot`, whose `policies` are
 * `LocalPolicy` rows — no `revision`, no `name`, a single required matcher where
 * contracts has an optional list, an `agent_version` scope contracts has no arm
 * for, and a `model_invocation` act contracts has no rule kind for.
 *
 * A byte-for-byte forward would therefore hand the SDK a body that contracts'
 * OWN `policySnapshotRefusals` refuses on every element. The SDK's
 * `assertPolicySnapshotTrustworthy` would throw, `decidePreflight` would fall
 * through to the caller's `PolicyUnavailablePolicy`, and every deployment would
 * see a permanently broken pre-flight with no indication of why.
 *
 * So this layer CONVERTS, in `lib/policies/localWire.ts`, and — the load-bearing
 * part — a policy it cannot convert is NEVER DROPPED. It is counted, it keeps
 * `policiesInScope` honest, and it forces `listingTruncated: true`.
 *
 * ===========================================================================
 * `listingTruncated` IS THE RIGHT LEVER, AND NOT A CONVENIENT ONE
 * ===========================================================================
 *
 * Contracts documents the flag as: "A TRUNCATED LISTING CANNOT ANSWER 'no policy
 * forbids this' … the policy that forbids the act is exactly as likely to be in
 * the unread tail as in the read head." A policy this layer could not state is
 * in exactly that position — present, governing, and invisible to the caller.
 *
 * `decidePreflight` then behaves correctly with no further help: a POSITIVE
 * match among the policies we DID state still advises against the act (step 2,
 * which runs before any completeness check), while the NEGATIVE question folds
 * into "no usable answer" and is adjudicated by the caller's explicit
 * unavailability policy (step 3). That asymmetry — a positive match survives
 * incompleteness, a negative one does not — is exactly the asymmetry this
 * feature needs, and it is already in the contract.
 *
 * TODAY THAT MEANS THE LISTING IS TRUNCATED AND EMPTY FOR EVERY DEPLOYMENT,
 * because `convex/policies.ts`'s `toLocalPolicy` drops the `revision` column
 * that the stored row already has. That is an honest "we cannot answer", not a
 * false "nothing forbids this", and it is fixed in one line in `convex/` — see
 * the note in `lib/policies/localWire.ts`.
 */
import type { PolicySnapshot } from '@agent-flight-recorder/contracts'


import { convex } from '@/lib/convexFunctions'
import { getPublicClient, withConvexTimeout } from '@/lib/convexServer'
import { convertPolicyRows, type PolicyListConversion } from '@/lib/policies/localWire'

/** Subject narrowing accepted by `GET /api/v1/policies/snapshot`. The key supplies the org. */
export interface ApiV1PolicySubjectParams {
  projectId?: string
  agentId?: string
  environment?: string
  runId?: string
}

/**
 * The `data` payload of `GET /api/v1/policies/snapshot`.
 *
 * Matches `V1PolicySnapshotData` in `packages/sdk/src/reader.ts`, which reads
 * `data.snapshot` and hands it to `assertPolicySnapshotTrustworthy`.
 *
 * `unrepresented` is an ADDITIVE, NON-CONTRACT field on the envelope and NOT on
 * the snapshot. It is outside `snapshot` on purpose: contracts' refusal walk
 * runs over the snapshot object, and a field it does not know is a field a
 * future contracts version could collide with. Here it is diagnostic only — the
 * enforcement is `snapshot.listingTruncated`, which the SDK already honours.
 */
export interface ApiV1PolicySnapshotData {
  snapshot: PolicySnapshot
  /**
   * Every governing policy this deployment could not state in contracts'
   * vocabulary, with the reason. Present so an operator debugging "why is my
   * listing truncated" gets the answer from the API rather than from a log.
   */
  unrepresented: readonly { policyId: string | null; because: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build the contracts snapshot from whatever the gate returned.
 *
 * Separated from the Convex call so a test can hold it over a literal body, the
 * same way `budgetSnapshotEnvelope` is.
 *
 * EVERY FALLBACK IN HERE POINTS THE SAME WAY. An unreadable `policiesInScope`
 * becomes the number of policies we could not account for rather than `0`; an
 * unreadable `listingTruncated` becomes `true`. A dropped field must never read
 * as "complete", because "complete and empty" is the one answer that means
 * "nothing forbids this act".
 */
export function policySnapshotEnvelope(raw: unknown, subjectEcho: Record<string, unknown>): ApiV1PolicySnapshotData {
  const body = isRecord(raw) ? raw : {}
  const rows: readonly unknown[] = Array.isArray(body['policies']) ? body['policies'] : []
  // The gate supplies no org id (deliberately — see this file's header), and the
  // subject echo it returns carries one. Read it if present; a definition's
  // `orgId` is descriptive here, never an authorization input.
  const echoedOrg = isRecord(body['subject']) ? body['subject']['orgId'] : undefined
  const conversion: PolicyListConversion = convertPolicyRows(
    rows,
    typeof echoedOrg === 'string' ? echoedOrg : '',
  )

  const statedInScope = body['policiesInScope']
  const inScope =
    typeof statedInScope === 'number' && Number.isInteger(statedInScope) && statedInScope >= 0
      ? statedInScope
      : conversion.represented.length + conversion.unrepresented.length

  const shelfLife = body['shelfLifeMs']
  const evaluatedAt = body['evaluatedAt']

  return {
    snapshot: {
      evaluatedAt: typeof evaluatedAt === 'number' && Number.isFinite(evaluatedAt) ? evaluatedAt : Date.now(),
      // A non-positive or unreadable shelf life would be refused by contracts;
      // clamped UP to one minute rather than defaulted to something long, so an
      // unreadable field costs freshness rather than buying permission.
      shelfLifeMs:
        typeof shelfLife === 'number' && Number.isInteger(shelfLife) && shelfLife > 0
          ? shelfLife
          : 60_000,
      // Echoed from what the REQUEST asked for, not from the response, so the
      // SDK's ignored-parameter check compares against the caller's own
      // question. A deployment that listed a different subject's policies
      // returned a well-formed answer to a question nobody asked.
      subject: subjectEcho as PolicySnapshot['subject'],
      policies: conversion.represented,
      policiesInScope: inScope,
      listingTruncated:
        body['listingTruncated'] !== false || conversion.unrepresented.length > 0,
    },
    unrepresented: conversion.unrepresented.map((u) => ({
      policyId: u.policyId,
      because: u.unrepresentableBecause,
    })),
  }
}

/**
 * List every enabled policy governing a subject, for an API key's org.
 *
 * Ids are forwarded EXPLICITLY across the hand-maintained
 * `makeFunctionReference` seam, where a dropped field is not a type error — and
 * a dropped narrowing id does not fail, it returns a well-formed listing about a
 * DIFFERENT (wider) subject.
 */
export async function apiGetPolicySnapshot(
  apiKeyHash: string,
  params: ApiV1PolicySubjectParams,
  subjectEcho: Record<string, unknown>,
): Promise<ApiV1PolicySnapshotData> {
  const client = getPublicClient()
  const raw = await withConvexTimeout(
    client.query(convex.policy_gate.sdkCheckPolicy, {
      apiKeyHash,
      ...(params.projectId !== undefined && { projectId: params.projectId }),
      ...(params.agentId !== undefined && { agentId: params.agentId }),
      ...(params.environment !== undefined && { environment: params.environment }),
      ...(params.runId !== undefined && { runId: params.runId }),
    }),
  )
  return policySnapshotEnvelope(raw, subjectEcho)
}
