import { timingSafeEqual } from 'node:crypto'

import { type NextRequest, NextResponse } from 'next/server'

import type { Event, Run } from '@agent-flight-recorder/contracts'

import { withApiHandler } from '@/lib/apiHandler'
import { getAcceptedSecrets } from '@/lib/env'
import { logger } from '@/lib/logger'
import { verifyProjectionIntegrity } from '@/lib/replay/verify'

const ROUTE = '/api/internal/verify-derivation'

/**
 * Constant-time shared-secret comparison. Length is checked first (an
 * unavoidable length oracle — acceptable for a high-entropy random secret);
 * the byte comparison itself never short-circuits, so the comparison time
 * does not leak how many leading bytes matched.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// POST /api/internal/verify-derivation
//
// Internal route called by the Convex verifyRecentRuns action to run
// buildReplayProjection and buildFailureSummary against a run's full event log.
//
// Protected by a shared secret (x-internal-secret header). Not intended for
// external callers — it is not authenticated via Clerk or API keys.
// Rate limiting (60 req/min/IP, best-effort per instance) is provided by
// withApiHandler; durable rate limiting stays in Convex — see lib/rateLimit.ts.
//
// Request body: { run: <raw Convex run doc>, events: <raw Convex event docs[]> }
//
// Response: {
//   isValid: boolean,
//   summary: string,
//   sequenceGaps: number[],
//   duplicateSeqNums: number[],
//   failureReason?: string,
//   checksRan: string[],       // e.g. ["sequence","replay","failureSummary"]
//   replayPassed: boolean,
//   failureSummaryPassed: boolean,
// }

export const POST = withApiHandler(
  ROUTE,
  async (req: NextRequest, ctx) => {
    const requestId = ctx.requestId

    // Reject if INTERNAL_VERIFY_SECRET is not configured on this deployment.
    // This var is optional by design — the Convex verifyRecentRuns action falls
    // back to sequence-only verification when this route is unavailable — so we
    // report 503 with the variable name instead of throwing via assertServerEnv.
    //
    // Supports dual-accept rotation: INTERNAL_VERIFY_SECRET may hold
    // `current,previous` (comma-separated) during a rotation window — every
    // accepted value validates until the old one is dropped. See
    // docs/operations_runbook.md → "Secret rotation".
    const acceptedSecrets = getAcceptedSecrets('INTERNAL_VERIFY_SECRET')
    if (acceptedSecrets.length === 0) {
      logger.warn('Missing env var INTERNAL_VERIFY_SECRET — verify-derivation disabled', {
        requestId,
        route: ROUTE,
      })
      return NextResponse.json(
        { error: 'Not configured: INTERNAL_VERIFY_SECRET is unset', requestId },
        { status: 503 },
      )
    }

    const secret = req.headers.get('x-internal-secret')
    if (!secret || !acceptedSecrets.some((accepted) => secretsMatch(secret, accepted))) {
      return NextResponse.json(
        { error: 'Unauthorized', requestId },
        { status: 401 },
      )
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { run: rawRun, events: rawEvents } = body as {
      run: Record<string, unknown>
      events: Array<Record<string, unknown>>
    }

    if (!rawRun || !Array.isArray(rawEvents)) {
      return NextResponse.json({ error: 'Missing run or events in body' }, { status: 400 })
    }

    // Map raw Convex documents to contracts types.
    // Convex docs use _id; contracts types use id.
    const run: Run = {
      id: rawRun._id as string,
      orgId: rawRun.orgId as string,
      projectId: rawRun.projectId as string,
      agentId: rawRun.agentId as string,
      agentVersionId: rawRun.agentVersionId as string | undefined,
      status: rawRun.status as Run['status'],
      startedAt: rawRun.startedAt as number,
      endedAt: rawRun.endedAt as number | undefined,
      metadata: (rawRun.metadata ?? {}) as Record<string, unknown>,
      tags: (rawRun.tags ?? []) as string[],
      triggeredBy: rawRun.triggeredBy as string | undefined,
      sdkVersion: rawRun.sdkVersion as string | undefined,
    }

    const events: Event[] = rawEvents.map((e) => ({
      id: e._id as string,
      runId: e.runId as string,
      orgId: e.orgId as string,
      type: e.type as Event['type'],
      sequenceNumber: e.sequenceNumber as number,
      timestamp: e.timestamp as number,
      payload: e.payload as Event['payload'],
      parentEventId: e.parentEventId as string | undefined,
    }))

    const result = verifyProjectionIntegrity(run, events)

    // Determine per-check pass/fail from the errors array.
    // verifyProjectionIntegrity prefixes errors from each check:
    //   "buildReplayProjection threw: ..."
    //   "Frame count mismatch: ..."
    //   "totalEvents mismatch: ..."
    //   "buildFailureSummary threw: ..."
    const replayErrors = result.errors.filter(
      (e) =>
        e.startsWith('buildReplayProjection') ||
        e.startsWith('Frame count mismatch') ||
        e.startsWith('totalEvents mismatch'),
    )
    const failureSummaryErrors = result.errors.filter((e) =>
      e.startsWith('buildFailureSummary'),
    )

    const replayPassed = replayErrors.length === 0
    const failureSummaryPassed = failureSummaryErrors.length === 0
    const checksRan = ['sequence', 'replay', 'failureSummary']

    // Determine failure reason: prefer non-sequence errors so the badge is informative
    let failureReason: string | undefined
    if (!result.isValid) {
      const nonSeqError = result.errors.find(
        (e) => !e.startsWith('Duplicate sequence') && !e.startsWith('Sequence gaps'),
      )
      failureReason = nonSeqError ?? result.errors[0]
    }

    return NextResponse.json({
      isValid: result.isValid,
      summary: result.summary,
      sequenceGaps: result.sequenceGaps,
      duplicateSeqNums: result.duplicateSequenceNumbers,
      failureReason,
      checksRan,
      replayPassed,
      failureSummaryPassed,
    })
  },
  { rateLimit: { key: 'ip', limitPerMin: 60 } }
)
