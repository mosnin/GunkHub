'use server'

import { auth } from '@clerk/nextjs/server'

import type { VerificationStatus } from '@/lib/services/projection_verify'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

export interface ReverifyResult {
  status: VerificationStatus | null
  error: string | null
}

export interface BulkReverifyResult {
  /** Run IDs where reverify completed without error. */
  succeeded: string[]
  /** Run IDs where reverify returned an error or threw. */
  failed: string[]
  /** Per-run error messages for failed entries. */
  errors: Record<string, string>
}

/** Maximum number of runs that can be reverified in a single bulk call. */
const MAX_BULK_REVERIFY = 20

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

/**
 * Server action: re-run verification for multiple runs in parallel.
 *
 * Bounded to MAX_BULK_REVERIFY runs per call. Excess IDs are silently dropped.
 * Auth is delegated to reverifyRunAction (Clerk session + Convex member+ role).
 * Returns counts of succeeded/failed with per-run error messages for failures.
 */
export async function bulkReverifyAction(runIds: string[]): Promise<BulkReverifyResult> {
  const { userId } = auth()
  if (!userId) {
    const bounded = runIds.slice(0, MAX_BULK_REVERIFY)
    return {
      succeeded: [],
      failed: bounded,
      errors: Object.fromEntries(bounded.map((id) => [id, 'Not authenticated'])),
    }
  }

  const bounded = runIds.slice(0, MAX_BULK_REVERIFY)

  const settled = await Promise.allSettled(
    bounded.map((runId) => reverifyRunAction(runId)),
  )

  const succeeded: string[] = []
  const failed: string[] = []
  const errors: Record<string, string> = {}

  for (const [i, r] of settled.entries()) {
    const id = bounded[i] as string
    if (r.status === 'fulfilled') {
      if (r.value.error === null) {
        succeeded.push(id)
      } else {
        failed.push(id)
        errors[id] = r.value.error ?? 'Unknown error'
      }
    } else {
      failed.push(id)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      errors[id] = r.reason instanceof Error ? r.reason.message : 'Unknown error'
    }
  }

  return { succeeded, failed, errors }
}
