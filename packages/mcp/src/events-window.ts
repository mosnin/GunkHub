/**
 * Tier 4's event-window fetch.
 *
 * PRIMARY PATH: `FlightReader.getRunEventWindow`, which asks the server for a
 * window addressed by `sequenceNumber` — one request, cost O(window). That is
 * the right shape and this module prefers it whenever the deployment supports
 * it.
 *
 * FALLBACK PATH: `GET /api/v1/runs/:id/events` accepts only `limit`/`cursor` on
 * deployments that predate windowed reads, and silently ignores an unknown
 * `fromSequence` — returning the HEAD of the log dressed up as the requested
 * window. `getRunEventWindow` detects exactly that (the first event's sequence
 * is below the requested floor, which a server that honored the floor can never
 * produce) and throws `invalid_response` rather than returning a wrong answer
 * that looks right. This module catches that ONE error and assembles the window
 * client-side instead: page forward from the start, discard everything below
 * the window, keep the window, and STOP — the async generator means stopping
 * actually stops the paging.
 *
 * The fallback's cost is honest and bounded: reaching sequence N costs
 * ceil(N / 200) round trips, it never buffers more than the window, and it
 * refuses to scan past {@link MAX_SCANNED_EVENTS} rather than grinding through
 * an enormous run. It is slower, never wrong.
 *
 * When every deployment supports windowed reads, the fallback and its scan
 * ceiling can be deleted with no change to the tool's input or output shape.
 */
import { V1ApiError } from '@agent-flight-recorder/sdk'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

import { EVENT_REQUEST_FIELDS } from './projections.js'

import type { EventRow } from './projections.js'
import type { Event } from '@agent-flight-recorder/contracts'

/** Page size used by the fallback path. 200 is the server's own `MAX_PAGE_SIZE`. */
export const PAGE_SIZE = 200

/**
 * Hard ceiling on events examined by the FALLBACK path while seeking to the
 * window start. Reaching it fails loudly instead of continuing to page: a
 * caller that asks for sequence 500 000 on a deployment without windowed reads
 * should be told the request is not affordable, not left waiting on hundreds of
 * round trips.
 */
export const MAX_SCANNED_EVENTS = 20_000

/** Minimal slice of `FlightReader` this module needs. Tests substitute a stub. */
export interface EventSource {
  /** Server-side windowed read. Optional so an older reader implementation still satisfies the interface. */
  getRunEventWindow?: (
    runId: string,
    options: { fromSequence?: number; limit?: number; fields?: string[] },
  ) => Promise<{ events: Event[]; fromSequence: number; nextCursor?: string }>
  iterateEvents(runId: string, options?: { pageSize?: number; maxPages?: number }): AsyncIterable<Event>
}

/** Result of a window fetch. */
export interface EventWindow {
  events: Event[]
  /**
   * The lowest sequence number NOT returned, when the log continued past the
   * window. Pass it back as `fromSequence` to continue. Absent at end of log.
   */
  nextFromSequence?: number
}

/** True for the one error that means "this deployment cannot do windowed reads". */
function isUnsupportedWindowRead(err: unknown): boolean {
  return err instanceof V1ApiError && err.kind === 'invalid_response'
}

/**
 * Assemble the window client-side by paging from the head of the log.
 *
 * Used only when the server cannot honor a sequence floor.
 */
async function fetchWindowByPaging(
  source: EventSource,
  runId: string,
  start: number,
  limit: number,
): Promise<EventWindow> {
  const collected: Event[] = []
  let scanned = 0
  let nextFromSequence: number | undefined

  for await (const event of source.iterateEvents(runId, { pageSize: PAGE_SIZE })) {
    scanned++
    if (event.sequenceNumber < start) {
      if (scanned > MAX_SCANNED_EVENTS) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Seeking to sequence ${String(start)} would require scanning more than ${String(MAX_SCANNED_EVENTS)} ` +
            'events, because this deployment’s read API cannot yet seek by sequence number. Request an earlier ' +
            'window, or use afr_explain_run to get the sequence numbers that actually matter.',
        )
      }
      continue
    }
    if (collected.length >= limit) {
      // One event past the window: report where to resume, then stop paging.
      nextFromSequence = event.sequenceNumber
      break
    }
    collected.push(event)
  }

  return nextFromSequence === undefined ? { events: collected } : { events: collected, nextFromSequence }
}

/**
 * Fetch a contiguous window of a run's events.
 *
 * @param source - a `FlightReader` (or any {@link EventSource}).
 * @param runId - the run's id.
 * @param fromSequence - the first `sequenceNumber` to return. Values below 1
 *   are clamped to 1.
 * @param limit - maximum events to return.
 * @returns the window, plus `nextFromSequence` when more events follow.
 * @throws {@link McpError} when a fallback seek would exceed {@link MAX_SCANNED_EVENTS}.
 */
export async function fetchEventWindow(
  source: EventSource,
  runId: string,
  fromSequence: number,
  limit: number,
): Promise<EventWindow> {
  const start = Math.max(1, Math.floor(fromSequence))

  const windowRead = source.getRunEventWindow
  if (windowRead !== undefined) {
    // Ask for one more than the window so the presence of a further event —
    // and therefore `nextFromSequence` — is a fact rather than a guess.
    const read = async (fields: string[] | undefined): Promise<EventWindow> => {
      const data = await windowRead(runId, {
        fromSequence: start,
        limit: limit + 1,
        ...(fields !== undefined && { fields }),
      })
      const events = data.events.slice(0, limit)
      const overflow = data.events[limit]
      return overflow === undefined ? { events } : { events, nextFromSequence: overflow.sequenceNumber }
    }

    try {
      // `fields` is DERIVED from tier 4's column table (`EVENT_COLUMNS`), so
      // the server serializes only the fields `toEventRow` reads. Sent only on
      // this primary path: the fallback pages through `iterateEvents`, whose
      // options are the SDK's and carry no selection. Either way
      // `budgetEventRows` still applies the byte budgets — a field selection
      // bounds WHICH fields come back, never how big one of them is.
      return await read([...EVENT_REQUEST_FIELDS])
    } catch (err) {
      if (!isUnsupportedWindowRead(err)) throw err
      // THREE-STEP DEGRADATION, and the order matters. The SDK reports both
      // "this deployment ignored `fields`" and "this deployment ignored
      // `fromSequence`" as `invalid_response`, and they are not distinguishable
      // from here. Retrying the WINDOW without the selection separates them: if
      // the projection was the problem this succeeds and keeps the one-request,
      // O(window) read; only if the sequence floor is also unsupported do we
      // drop to paging, which is what this deployment cost before `fields`
      // existed. Trying the cheap-but-newer thing first must never cost the
      // caller the older, working thing.
      try {
        return await read(undefined)
      } catch (retryErr) {
        if (!isUnsupportedWindowRead(retryErr)) throw retryErr
      }
    }
  }

  return fetchWindowByPaging(source, runId, start, limit)
}

/** Re-export so tool modules import the row type from one place. */
export type { EventRow }
