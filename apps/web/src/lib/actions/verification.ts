'use server'

import { auth } from '@clerk/nextjs/server'

import type { VerificationStatus } from '@/lib/services/projection_verify'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

export interface ReverifyResult {
  status: VerificationStatus | null
  error: string | null
}

/**
 * Server action: re-run derivation verification for a single run on demand.
 *
 * Auth is enforced at two layers:
 *   1. Clerk session must be active (checked here before calling Convex).
 *   2. The Convex action enforces member+ role within the run's org.
 *
 * Returns the fresh VerificationStatus on success, or an error string.
 */
export async function reverifyRunAction(runId: string): Promise<ReverifyResult> {
  const { userId } = auth()
  if (!userId) return { status: null, error: 'Not authenticated' }

  try {
    const client = await getAuthedClient()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const raw = await client.action(convex.projection_verify.reverifyRun, { runId: runId as any })

    const r = raw as Record<string, unknown>
    const status: VerificationStatus = {
      verified: true,
      isValid: r.isValid as boolean,
      verifiedAt: r.verifiedAt as number,
      summary: r.summary as string,
      sequenceGaps: (r.sequenceGaps as number[]) ?? [],
      duplicateSeqNums: (r.duplicateSeqNums as number[]) ?? [],
      checksRan: (r.checksRan as string[] | undefined) ?? [],
      replayPassed: r.replayPassed != null ? (r.replayPassed as boolean) : null,
      failureSummaryPassed:
        r.failureSummaryPassed != null ? (r.failureSummaryPassed as boolean) : null,
    }
    return { status, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed'
    return { status: null, error: msg }
  }
}
