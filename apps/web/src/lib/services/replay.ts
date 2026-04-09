import type {
  Event,
  EventPayload,
  EventType,
  GetReplayResponse,
  Run,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { buildFailureSummary, buildReplayProjection } from '@/lib/replay'

function mapRun(doc: Record<string, unknown>): Run {
  return {
    id: doc._id as string,
    orgId: doc.orgId as string,
    projectId: doc.projectId as string,
    agentId: doc.agentId as string,
    status: doc.status as Run['status'],
    startedAt: doc.startedAt as number,
    metadata: (doc.metadata ?? {}) as Record<string, unknown>,
    tags: (doc.tags ?? []) as string[],
    ...(doc.agentVersionId !== undefined && { agentVersionId: doc.agentVersionId as string }),
    ...(doc.endedAt !== undefined && { endedAt: doc.endedAt as number }),
    ...(doc.triggeredBy !== undefined && { triggeredBy: doc.triggeredBy as string }),
    ...(doc.sdkVersion !== undefined && { sdkVersion: doc.sdkVersion as string }),
  }
}

function mapEvent(doc: Record<string, unknown>): Event {
  return {
    id: doc._id as string,
    runId: doc.runId as string,
    orgId: doc.orgId as string,
    type: doc.type as EventType,
    sequenceNumber: doc.sequenceNumber as number,
    timestamp: doc.timestamp as number,
    payload: doc.payload as EventPayload,
    ...(doc.parentEventId !== undefined && { parentEventId: doc.parentEventId as string }),
  }
}

/**
 * Fetch all events for a run and compute the replay projection + failure summary.
 * On-demand computation — not stored. Rebuilt from canonical events on every request.
 */
export async function getReplayProjection(runId: string): Promise<GetReplayResponse> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const runDoc = await client.query(convex.runs.getRun, { runId })
  if (!runDoc) throw new Error('Run not found')

  // Paginate through all events for the run.
  const allEventDocs: Record<string, unknown>[] = []
  let cursor: string | undefined = undefined
  do {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = await client.query(convex.events.listEvents, {
      runId,
      limit: 1000,
      ...(cursor !== undefined && { cursor }),
    })
    const typedPage = page as { events: Record<string, unknown>[]; nextCursor?: string }
    allEventDocs.push(...typedPage.events)
    cursor = typedPage.nextCursor
  } while (cursor !== undefined)

  const run = mapRun(runDoc as Record<string, unknown>)
  const events = allEventDocs.map(mapEvent)

  const projection = buildReplayProjection(run, events)
  const failureSummary = buildFailureSummary(run, events)

  return { projection, failureSummary }
}
