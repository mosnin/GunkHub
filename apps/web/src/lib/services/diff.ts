import type {
  Event,
  EventPayload,
  EventType,
  GetDiffResponse,
  Run,
  RunDiff,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'
import { buildRunDiff } from '@/lib/replay'
import { MAX_EVENTS_PER_DIFF } from '@/lib/replay/diff'

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

/** Fetch events for a run up to MAX_EVENTS_PER_DIFF. Returns truncated=true if the run has more. */
async function fetchAllEvents(
  client: Awaited<ReturnType<typeof getAuthedClient>>,
  runId: string
): Promise<{ events: Event[]; truncated: boolean }> {
  const allDocs: Record<string, unknown>[] = []
  let cursor: string | undefined = undefined
  do {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const page = await client.query(convex.events.listEvents, {
      runId,
      limit: 1000,
      ...(cursor !== undefined && { cursor }),
    })
    const typedPage = page as { events: Record<string, unknown>[]; nextCursor?: string }
    allDocs.push(...typedPage.events)
    cursor = typedPage.nextCursor
  } while (cursor !== undefined && allDocs.length < MAX_EVENTS_PER_DIFF)

  const truncated = cursor !== undefined // exited early due to limit
  return { events: allDocs.slice(0, MAX_EVENTS_PER_DIFF).map(mapEvent), truncated }
}

/**
 * Fetch events for both runs, verify they belong to the authenticated org,
 * and compute a structural diff.
 */
export async function getRunDiff(leftRunId: string, rightRunId: string): Promise<GetDiffResponse> {
  const client = await getAuthedClient()

  // Fetch both run records. getRun enforces org-membership inside Convex.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const leftRunDoc = await client.query(convex.runs.getRun, { runId: leftRunId })
  if (!leftRunDoc) throw new Error('Run not found')

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const rightRunDoc = await client.query(convex.runs.getRun, { runId: rightRunId })
  if (!rightRunDoc) throw new Error('Run not found')

  void mapRun(leftRunDoc as Record<string, unknown>)
  void mapRun(rightRunDoc as Record<string, unknown>)

  // Fetch events for both runs in parallel, capped at MAX_EVENTS_PER_DIFF each.
  const [{ events: leftEvents, truncated: leftTruncated }, { events: rightEvents, truncated: rightTruncated }] =
    await Promise.all([
      fetchAllEvents(client, leftRunId),
      fetchAllEvents(client, rightRunId),
    ])

  // Determine comparability.
  if (leftEvents.length === 0 || rightEvents.length === 0) {
    const emptyDiff: RunDiff = {
      leftRunId,
      rightRunId,
      eventDiffs: [],
      summary: { added: 0, removed: 0, changed: 0, same: 0, statusChanged: false },
    }
    return {
      diff: emptyDiff,
      incomparable: true,
      incomparableReason: 'One or both runs have no events',
    }
  }

  const diff = buildRunDiff(leftRunId, rightRunId, leftEvents, rightEvents)
  return {
    diff: { ...diff, ...(leftTruncated || rightTruncated ? { truncated: true } : {}) },
    incomparable: false,
  }
}
