import type {
  CreateEventRequest,
  CreateEventResponse,
  Event,
  ListEventsRequest,
  ListEventsResponse,
} from '@agent-flight-recorder/contracts'

import { convex } from '@/lib/convexFunctions'
import { getAuthedClient } from '@/lib/convexServer'

function mapEvent(doc: Record<string, unknown>): Event {
  return {
    id: doc._id as string,
    runId: doc.runId as string,
    orgId: doc.orgId as string,
    type: doc.type as Event['type'],
    sequenceNumber: doc.sequenceNumber as number,
    timestamp: doc.timestamp as number,
    payload: doc.payload as Event['payload'],
    ...(doc.parentEventId !== undefined && { parentEventId: doc.parentEventId as string }),
  }
}

/**
 * List events for a run in sequence order.
 * Requires Clerk session with org membership on the run's org.
 */
export async function listEvents(
  params: ListEventsRequest & { afterSeq?: number },
): Promise<ListEventsResponse> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await client.query(convex.events.listEvents, {
    runId: params.runId,
    ...(params.limit !== undefined && { limit: params.limit }),
    ...(params.cursor !== undefined && { cursor: params.cursor }),
    ...(params.types !== undefined && { types: params.types }),
    ...(params.afterSeq !== undefined && { afterSeq: params.afterSeq }),
  })

  const res = result as { events: Record<string, unknown>[]; nextCursor?: string }
  return {
    events: (res.events ?? []).map(mapEvent),
    nextCursor: res.nextCursor,
  }
}

/**
 * Get a single event by ID. Verifies org membership via Convex.
 */
export async function getEvent(eventId: string): Promise<Event> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.query(convex.events.getEvent, { eventId })

  if (!doc) throw new Error('Event not found')

  return mapEvent(doc as Record<string, unknown>)
}

/**
 * Create a new event. Used by the web UI (Clerk auth).
 * For SDK-initiated events use the /api/events ingestion route with x-api-key.
 */
export async function createEvent(req: CreateEventRequest): Promise<CreateEventResponse> {
  const client = await getAuthedClient()

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const doc = await client.mutation(convex.events.createEvent, {
    runId: req.runId,
    type: req.type,
    sequenceNumber: req.sequenceNumber,
    timestamp: req.timestamp,
    payload: req.payload,
    ...(req.parentEventId !== undefined && { parentEventId: req.parentEventId }),
  })

  return { event: mapEvent(doc as Record<string, unknown>) }
}
