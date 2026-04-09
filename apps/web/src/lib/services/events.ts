import type {
  ListEventsRequest,
  ListEventsResponse,
  CreateEventRequest,
  CreateEventResponse,
} from '@agent-flight-recorder/contracts'

/**
 * List events for a run.
 * TODO: Replace with Convex query/mutation call
 */
export async function listEvents(params: ListEventsRequest): Promise<ListEventsResponse> {
  void params
  return {
    events: [],
    nextCursor: undefined,
  }
}

/**
 * Create a new event.
 * TODO: Replace with Convex query/mutation call
 */
export async function createEvent(req: CreateEventRequest): Promise<CreateEventResponse> {
  return {
    event: {
      id: `evt_${Date.now()}`,
      runId: req.runId,
      orgId: '',
      type: req.type,
      sequenceNumber: req.sequenceNumber,
      timestamp: req.timestamp,
      payload: req.payload,
      parentEventId: req.parentEventId,
    },
  }
}
