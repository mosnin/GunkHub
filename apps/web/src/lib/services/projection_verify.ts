import { auth } from '@clerk/nextjs/server'

import {
  okList,
  unavailableEmpty,
  unavailableError,
  unavailableNoOrg,
  unavailableOrgUnresolved,
} from './serviceResult'

import type { ServiceListResult, ServiceResult } from './serviceResult'


import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

const FAILED_VERIFICATIONS_SUBJECT = 'recent verification results'
const BATCH_STATUS_SUBJECT = 'verification status for these runs'

/** Canonical unverified state — used as a default when no result exists. */
export const UNVERIFIED_STATUS: VerificationStatus = {
  verified: false,
  isValid: null,
  verifiedAt: null,
  summary: null,
  sequenceGaps: [],
  duplicateSeqNums: [],
  checksRan: [],
  replayPassed: null,
  failureSummaryPassed: null,
}

/** A compact verification failure record — used in the dashboard overview. */
export interface FailedVerification {
  runId: string
  verifiedAt: number
  isValid: boolean
  checksRan: string[]
  failureReason: string | undefined
  sequenceGaps: number[]
  duplicateSeqNums: number[]
}

export interface VerificationStatus {
  /** True if the run has been verified at least once. */
  verified: boolean
  /** True if the last verification found no issues. null if never verified. */
  isValid: boolean | null
  /** Epoch ms of the last verification run. null if never verified. */
  verifiedAt: number | null
  /** Human-readable summary string. null if never verified. */
  summary: string | null
  /** Sequence gaps found in the last check. Empty array if none. */
  sequenceGaps: number[]
  /** Duplicate sequence numbers found in the last check. Empty array if none. */
  duplicateSeqNums: number[]
  /**
   * Which checks were run in the last verification.
   * e.g. ["sequence"] for sequence-only (pre-Prompt 21 records or degraded mode),
   * or ["sequence","replay","failureSummary"] for full derivation check.
   * Empty array if never verified.
   */
  checksRan: string[]
  /**
   * True if buildReplayProjection succeeded in the last full check.
   * null if the replay check was not run or the run has never been verified.
   */
  replayPassed: boolean | null
  /**
   * True if buildFailureSummary succeeded in the last full check.
   * null if the failure-summary check was not run or the run has never been verified.
   */
  failureSummaryPassed: boolean | null
}

function mapResultToStatus(r: Record<string, unknown>): VerificationStatus {
  return {
    verified: true,
    isValid: r.isValid as boolean,
    verifiedAt: r.verifiedAt as number,
    summary: r.summary as string,
    sequenceGaps: (r.sequenceGaps as number[]) ?? [],
    duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    checksRan: (r.checksRan as string[] | undefined) ?? [],
    replayPassed: r.replayPassed != null ? (r.replayPassed as boolean) : null,
    failureSummaryPassed: r.failureSummaryPassed != null ? (r.failureSummaryPassed as boolean) : null,
  }
}

/**
 * Get the verification status for a run.
 * Returns a VerificationStatus with verified=false if no result exists.
 * Uses the authenticated Convex client — org membership is enforced by the query.
 */
export async function getRunVerificationStatus(runId: string): Promise<VerificationStatus> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
  const result = await client.query(convex.projection_verify.getVerificationResult, { runId: runId as any })

  if (!result) {
    return {
      verified: false,
      isValid: null,
      verifiedAt: null,
      summary: null,
      sequenceGaps: [],
      duplicateSeqNums: [],
      checksRan: [],
      replayPassed: null,
      failureSummaryPassed: null,
    }
  }

  return mapResultToStatus(result as Record<string, unknown>)
}

/**
 * Batch-fetch verification statuses for a set of run IDs.
 *
 * On success, every requested runId maps to a status; runs with no stored
 * result map to `UNVERIFIED_STATUS`. That per-run fallback is CORRECT and
 * stays — see the tenancy note below.
 *
 * Previously this returned `Record<string, VerificationStatus>` and did
 * `catch { return {} }`. Callers then read a missing key as UNVERIFIED, so a
 * failed batch silently relabelled every run in the list as "not verified" —
 * an integrity claim fabricated out of a network error. The `'error'` branch
 * now says so instead.
 *
 * TENANCY. `convex/projection_verify.ts` `batchGetVerificationResults`
 * enforces org membership on `orgId`, then filters each row with
 * `result?.orgId === args.orgId ? result : null`. A runId belonging to another
 * org therefore comes back as `{ runId, result: null }` — byte-identical to a
 * run that simply has no verification record. That indistinguishability is
 * load-bearing, and nothing here disturbs it: the only failure this function
 * reports is a whole-batch one, which carries no per-run information. Do NOT
 * add a per-run error branch here; it would immediately become an existence
 * oracle across the org boundary (CLAUDE.md, Tenancy Rules #3).
 */
export async function batchGetRunVerificationStatuses(
  runIds: string[],
): Promise<ServiceResult<{ statuses: Record<string, VerificationStatus> }>> {
  // Nothing was asked for. Genuinely empty, and no query was needed to know it.
  if (runIds.length === 0) {
    return unavailableEmpty('No runs to check verification status for.')
  }

  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(BATCH_STATUS_SUBJECT)

  try {
    const client = await getAuthedClient()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(BATCH_STATUS_SUBJECT)

    const orgId = (org as Record<string, unknown>)._id as string

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const raw = await client.query(convex.projection_verify.batchGetVerificationResults, {
      orgId: orgId as unknown as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      runIds: runIds as any,
    })

    const items = raw as Array<{ runId: string; result: Record<string, unknown> | null }>
    const statuses: Record<string, VerificationStatus> = {}

    for (const item of items) {
      statuses[item.runId] = item.result ? mapResultToStatus(item.result) : UNVERIFIED_STATUS
    }

    // The query succeeded, so 'ok' even if every run came back unverified:
    // "these runs have not been verified" is a real, reportable finding. It is
    // only a lie when we never got an answer, which is the branch below.
    return { status: 'ok', statuses }
  } catch (err) {
    return unavailableError(BATCH_STATUS_SUBJECT, err, {
      service: 'projection_verify',
      fn: 'batchGetRunVerificationStatuses',
      runCount: runIds.length,
    })
  }
}

/**
 * Get the most recent failed verification results for the org.
 * Used by the dashboard to surface verification issues.
 *
 * THIS WAS THE MOST DAMAGING INSTANCE OF THE SWALLOWED-ERROR BUG IN THE REPO,
 * and it is worth stating plainly so it is never reintroduced. The function
 * used to `catch { return [] }`. The dashboard renders
 * `failedVerifications.length === 0` as a green dot and the words "No recent
 * verification issues". So when the verification query threw, the widget whose
 * entire job is to tell an engineer their event log is intact rendered a clean
 * bill of health. On a product whose core invariant is an immutable, VERIFIABLE
 * event log (CLAUDE.md, Event Log Rules), asserting "verification is fine"
 * because the verification query failed inverts the feature: the more broken
 * the integrity checking is, the healthier the product claims to be.
 *
 * It was double-swallowed — `app/(app)/dashboard/page.tsx` also wrapped the
 * call in `catch { /* Non-fatal *\/ }`. That outer catch is now redundant and
 * should be removed when the call site is updated.
 *
 * An empty list from a SUCCESSFUL query is still good news and still reports
 * `status: 'empty'` — the green dot is correct there. The point is only that
 * 'empty' and 'error' must reach the widget as different values.
 */
export async function getRecentFailedVerifications(
  limit = 5,
): Promise<ServiceListResult<FailedVerification>> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return unavailableNoOrg(FAILED_VERIFICATIONS_SUBJECT)

  try {
    const client = await getAuthedClient()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return unavailableOrgUnresolved(FAILED_VERIFICATIONS_SUBJECT)

    const orgId = (org as Record<string, unknown>)._id as string

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const raw = await client.query(convex.projection_verify.listRecentFailedVerifications, {
      orgId: orgId as unknown as never,
      limit,
    })

    const items = raw as Array<Record<string, unknown>>
    const failures: FailedVerification[] = items.map((r) => ({
      runId: r.runId as string,
      verifiedAt: r.verifiedAt as number,
      isValid: r.isValid as boolean,
      checksRan: (r.checksRan as string[] | undefined) ?? [],
      failureReason: r.failureReason as string | undefined,
      sequenceGaps: (r.sequenceGaps as number[]) ?? [],
      duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    }))

    // A successful query returning nothing IS the good news the green dot is
    // for. `okList` maps that to 'empty', never to 'ok' with a hollow list.
    return okList(failures, 'No recent verification issues.')
  } catch (err) {
    return unavailableError(FAILED_VERIFICATIONS_SUBJECT, err, {
      service: 'projection_verify',
      fn: 'getRecentFailedVerifications',
      limit,
    })
  }
}
