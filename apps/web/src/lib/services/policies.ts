/**
 * services/policies.ts — Clerk-authed service layer for declarative policy
 * (ADR-009), wrapping `convex/policies.ts`.
 *
 * Mirrors services/budgets.ts: resolves the Clerk org to a Convex orgId, then
 * calls the org-scoped Convex functions. CONVEX ENFORCES THE ROLE CHECKS — this
 * layer does not duplicate them, it only surfaces what Convex throws. All three
 * mutations (`createPolicy`, `updatePolicy`, `disablePolicy`) are ADMIN-gated
 * and audited into the append-only admin audit log (CLAUDE.md Event Log Rule 6).
 *
 * ===========================================================================
 * EVERY READ HERE RETURNS A DISCRIMINATED UNION, NEVER A NULLABLE VALUE
 * ===========================================================================
 *
 * `null` and `[]` would collapse "we could not read your policies" into "you
 * have no policies", and on THIS screen those two must never render alike. The
 * first is an outage. The second is an organization with no controls at all.
 * Both look like a quiet screen, and on a compliance surface a quiet screen is
 * read as reassurance.
 *
 * That is the same argument services/budgets.ts makes, and it is stronger here
 * for the reason ADR-009 exists: the person who acts on a budget screen can go
 * and check the number. The person who acts on this one is often a third party
 * reading an answer somebody else produced.
 *
 * ===========================================================================
 * WHAT THIS LAYER REFUSES TO DO
 * ===========================================================================
 *
 * It computes no ratio, no percentage and no bare satisfied count, and it
 * exports no function that could produce one. The three counts travel together
 * through `lib/policies/outcomes.ts`'s `OutcomeCounts` or not at all — the same
 * constraint contracts puts on `PolicyOutcomeCounts`, for the same reason: a
 * satisfied figure travelling alone is the attestation figure with every
 * safeguard stripped off.
 */
import { auth } from '@clerk/nextjs/server'

import type { UpsertPolicyRequest } from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient, resolveConvexOrgId, withConvexTimeout } from '@/lib/convexServer'
import { readEvaluation, type PolicyEvaluationRead } from '@/lib/policies/evaluation'
import { readConvexPolicyRow, type ConvexPolicyRow } from '@/lib/policies/localWire'



async function requireOrgContext(): Promise<{ convexOrgId: string }> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) throw new Error('Unauthorized: no organization context')
  return { convexOrgId: await resolveConvexOrgId(clerkOrgId) }
}

// ---------------------------------------------------------------------------
// THE DEFINITIONS
// ---------------------------------------------------------------------------

/**
 * A policy row as this UI shows it.
 *
 * `interpretable` is carried through and never defaulted to `true`. It is
 * `convex/policies.ts`'s own answer to "can the engine read this rule at all",
 * and a `false` is a control an operator believes is in force and which grades
 * nothing — the policy list is exactly where they look to believe it.
 */
export interface PolicyRecord extends ConvexPolicyRow {
  readonly interpretable: boolean
}

export type PolicyListRead =
  | { kind: 'policies'; policies: PolicyRecord[]; unreadableRows: number }
  /** The read failed or returned something that is not a list. NOT an empty list. */
  | { kind: 'unreadable'; because: string }

/**
 * Read the policy list, keeping unreadable rows COUNTED rather than dropped.
 *
 * Pure over its input and exported so a test can pin it without Convex.
 */
export function readPolicyList(raw: unknown): PolicyListRead {
  const rows = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { policies?: unknown }).policies)
      ? ((raw as { policies: unknown[] }).policies)
      : null
  if (rows === null) {
    return {
      kind: 'unreadable',
      because:
        'the policy list request returned something that is not a list of policies. This is shown as a failure ' +
        'rather than as an empty list, because an organization with no controls and an organization whose ' +
        'controls could not be read must never produce the same screen.',
    }
  }
  const policies: PolicyRecord[] = []
  let unreadableRows = 0
  for (const raw_ of rows) {
    const row = readConvexPolicyRow(raw_)
    if (row === null) {
      unreadableRows += 1
      continue
    }
    policies.push({ ...row, interpretable: row.interpretable ?? false })
  }
  return { kind: 'policies', policies, unreadableRows }
}

/** Every policy defined in the caller's org, enabled or not. */
export async function listPolicies(): Promise<PolicyListRead> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  const raw = await withConvexTimeout(
    client.query(convex.policies.listPolicies, { orgId: convexOrgId }),
  )
  return readPolicyList(raw)
}

// The reading layer is PURE and lives in `lib/policies/evaluation.ts`, with no
// Convex client and no `lib/env.ts` in its import graph — see that file's header
// for why. Re-exported here so a consumer has one entry point for the feature
// and does not have to know which half of it does I/O.
export {
  readEvaluation,
  type PolicyEvaluationRead,
  type PolicyEvaluationView,
  type PolicyScanView,
} from '@/lib/policies/evaluation'

/** Every enabled policy governing ONE run, evaluated over that run's recorded log. */
export async function evaluateRun(runId: string): Promise<PolicyEvaluationRead> {
  await requireOrgContext()
  const client = await getAuthedClient()
  const raw = await withConvexTimeout(
    client.query(convex.policies.evaluateRunAgainstPolicies, { runId }),
  )
  return readEvaluation(raw)
}

/** ONE policy across many recorded runs. Bounded, and it reports its own coverage. */
export async function scanRunsAgainstPolicy(
  policyId: string,
  limit?: number,
): Promise<PolicyEvaluationRead> {
  await requireOrgContext()
  const client = await getAuthedClient()
  const raw = await withConvexTimeout(
    client.query(convex.policies.scanRunsAgainstPolicy, {
      policyId,
      ...(limit !== undefined && { limit }),
    }),
  )
  return readEvaluation(raw)
}

// ---------------------------------------------------------------------------
// THE PRIVILEGED WRITES. Admin-gated and audited in `convex/`.
// ---------------------------------------------------------------------------

/** Create a policy. Returns the new policy id. */
export async function createPolicy(terms: UpsertPolicyRequest): Promise<string> {
  const { convexOrgId } = await requireOrgContext()
  const client = await getAuthedClient()
  const result = await withConvexTimeout(
    client.mutation(convex.policies.createPolicy, {
      // `orgId` comes from the session, never the request body.
      orgId: convexOrgId,
      name: terms.name,
      rule: terms.rule,
      subject: terms.subject,
      rationale: terms.rationale,
      enabled: terms.enabled,
    }),
  )
  return typeof result === 'string' ? result : String((result as { policyId?: unknown })?.policyId ?? '')
}

/**
 * Replace a policy's TERMS. Bumps `revision` server-side.
 *
 * NOTE WHAT IS NOT FORWARDED: `enabled`. `convex/policies.ts`'s `updatePolicy`
 * has no such argument, and that is the same split contracts draws between
 * `UpsertPolicyRequest` and `DisablePolicyRequest` — changing what a policy
 * forbids and switching it off are different acts with different blast radii.
 */
export async function updatePolicy(policyId: string, terms: UpsertPolicyRequest): Promise<void> {
  await requireOrgContext()
  const client = await getAuthedClient()
  await withConvexTimeout(
    client.mutation(convex.policies.updatePolicy, {
      policyId,
      name: terms.name,
      rule: terms.rule,
      subject: terms.subject,
      rationale: terms.rationale,
    }),
  )
}

/**
 * Switch a policy on or off. `reason` is REQUIRED and written to the append-only
 * admin audit log — there is no defaulting it here or anywhere.
 *
 * THERE IS NO DELETE FUNCTION IN THIS MODULE AND THERE MUST NOT BE ONE. A policy
 * that governed recorded runs is part of how those runs were judged; removing
 * the row would leave every past outcome pointing at a revision of nothing.
 */
export async function setPolicyEnabled(
  policyId: string,
  enabled: boolean,
  reason: string,
): Promise<void> {
  await requireOrgContext()
  const client = await getAuthedClient()
  await withConvexTimeout(
    client.mutation(convex.policies.disablePolicy, { policyId, enabled, reason }),
  )
}
