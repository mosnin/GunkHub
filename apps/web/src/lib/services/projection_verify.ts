import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

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

  const r = result as Record<string, unknown>
  return {
    verified: true,
    isValid: r.isValid as boolean,
    verifiedAt: r.verifiedAt as number,
    summary: r.summary as string,
    sequenceGaps: (r.sequenceGaps as number[]) ?? [],
    duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
    checksRan: (r.checksRan as string[]) ?? [],
    replayPassed: r.replayPassed != null ? (r.replayPassed as boolean) : null,
    failureSummaryPassed: r.failureSummaryPassed != null ? (r.failureSummaryPassed as boolean) : null,
  }
}
