import { type NextRequest, NextResponse } from 'next/server'

import type { Event, Run } from '@agent-flight-recorder/contracts'

import { env } from '@/lib/env'
import { getRequestId, logger } from '@/lib/logger'
import { createRateLimiter, getClientIp } from '@/lib/rateLimit'
import { verifyProjectionIntegrity } from '@/lib/replay/verify'

const ROUTE = '/api/internal/verify-derivation'

// Best-effort per-instance rate limit for this shared-secret route
// (60 req/min/IP). Durable rate limiting stays in Convex — see lib/rateLimit.ts.
const rateLimiter = createRateLimiter(60)

// POST /api/internal/verify-derivation
//
// Internal route called by the Convex verifyRecentRuns action to run
// buildReplayProjection and buildFailureSummary against a run's full event log.
//
// Protected by a shared secret (x-internal-secret header). Not intended for
// external callers — it is not authenticated via Clerk or API keys.
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

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req)

  if (!rateLimiter.check(getClientIp(req))) {
    return NextResponse.json(
      { error: 'Too many requests', requestId },
      { status: 429, headers: { 'x-request-id': requestId, 'retry-after': '60' } },
    )
  }

  // Reject if INTERNAL_VERIFY_SECRET is not configured on this deployment.
  // This var is optional by design — the Convex verifyRecentRuns action falls
  // back to sequence-only verification when this route is unavailable — so we
  // report 503 with the variable name instead of throwing via assertServerEnv.
  if (!env.INTERNAL_VERIFY_SECRET) {
    logger.warn('Missing env var INTERNAL_VERIFY_SECRET — verify-derivation disabled', {
      requestId,
      route: ROUTE,
    })
    return NextResponse.json(
      { error: 'Not configured: INTERNAL_VERIFY_SECRET is unset', requestId },
      { status: 503, headers: { 'x-request-id': requestId } },
    )
  }

  const secret = req.headers.get('x-internal-secret')
  if (secret !== env.INTERNAL_VERIFY_SECRET) {
    return NextResponse.json(
      { error: 'Unauthorized', requestId },
      { status: 401, headers: { 'x-request-id': requestId } },
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
}
