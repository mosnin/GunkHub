import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

export interface VerificationStatus {
  /** True if the run has been verified at least once. */
  verified: boolean
  /** True if the last verification found no sequence gaps or duplicates. null if never verified. */
  isValid: boolean | null
  /** Epoch ms of the last verification run. null if never verified. */
  verifiedAt: number | null
  /** Human-readable summary string. null if never verified. */
  summary: string | null
  /** Sequence gaps found in the last check. Empty array if none. */
  sequenceGaps: number[]
  /** Duplicate sequence numbers found in the last check. Empty array if none. */
  duplicateSeqNums: number[]
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
  }
}
