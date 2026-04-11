import { auth } from '@clerk/nextjs/server'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

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
 * Returns a map from runId → VerificationStatus. Entries with no result map to UNVERIFIED_STATUS.
 * Non-fatal: returns an empty object on auth or network failure.
 * Org membership is enforced by the Convex query.
 */
export async function batchGetRunVerificationStatuses(
  runIds: string[],
): Promise<Record<string, VerificationStatus>> {
  if (runIds.length === 0) return {}

  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return {}

  try {
    const client = await getAuthedClient()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return {}

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

    return statuses
  } catch {
    return {}
  }
}

/**
 * Get the most recent failed verification results for the org.
 * Used by the dashboard to surface verification issues.
 * Non-fatal: returns an empty array on auth or network failure.
 */
export async function getRecentFailedVerifications(limit = 5): Promise<FailedVerification[]> {
  const { orgId: clerkOrgId } = auth()
  if (!clerkOrgId) return []

  try {
    const client = await getAuthedClient()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const org = await client.query(convex.organizations.getOrganization, { clerkOrgId })
    if (!org) return []

    const orgId = (org as Record<string, unknown>)._id as string

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const raw = await client.query(convex.projection_verify.listRecentFailedVerifications, {
      orgId: orgId as unknown as never,
      limit,
    })

    const items = raw as Array<Record<string, unknown>>
    return items.map((r) => ({
      runId: r.runId as string,
      verifiedAt: r.verifiedAt as number,
      isValid: r.isValid as boolean,
      checksRan: (r.checksRan as string[] | undefined) ?? [],
      failureReason: r.failureReason as string | undefined,
      sequenceGaps: (r.sequenceGaps as number[]) ?? [],
      duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    }))
  } catch {
    return []
  }
}
