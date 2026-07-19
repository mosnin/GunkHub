/**
 * `FlightReader` — a typed, read-only client for the Agent Flight Recorder
 * public v1 read API (`docs/api_reference.md`), shipped from the SDK so
 * "record with `Recorder`, read back with `FlightReader`" is a single-package
 * story instead of requiring a separate HTTP client.
 *
 * v1 endpoints (all GET, `x-api-key` auth with the `read` scope):
 *   GET /api/v1/runs                 -> listRuns()
 *   GET /api/v1/runs/:id             -> getRun()
 *   GET /api/v1/runs/:id/events      -> getRunEvents() / iterateEvents()
 *   GET /api/v1/runs/:id/replay      -> getReplay()
 *
 * Every response is wrapped in an envelope: `{ apiVersion, data }` on
 * success, `{ apiVersion, error: { code, message } }` on failure — parsed
 * tolerantly by the shared {@link fetchV1} helper in `./v1-client.js` (the
 * ONE source of truth this class shares with `@agent-flight-recorder/cli`'s
 * `apiClient.ts`).
 *
 * Uses only the native `fetch` — no HTTP framework dependency, consistent
 * with the rest of the SDK.
 */
import { warnIfInsecureEndpoint } from './transport.js'
import { fetchV1, V1ApiError } from './v1-client.js'

import type { V1ApiConfig, V1FetchLike } from './v1-client.js'
import type { Event, FailureSummary, ReplayProjection, Run, RunStatus } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// v1 response data shapes (entity types reused from contracts — read-only)
// ---------------------------------------------------------------------------

export interface V1ListRunsData {
  runs: Run[]
  nextCursor?: string
  /** Current page's length. Kept alongside `total` for the Clerk-authed-route naming compatibility documented in `docs/api_reference.md`. */
  pageSize?: number
  total?: number
}

export interface V1GetRunData {
  run: Run
  eventCount: number
  artifactCount: number
}

export interface V1ListEventsData {
  events: Event[]
  nextCursor?: string
}

export interface V1ReplayData {
  projection: ReplayProjection
  failureSummary: FailureSummary
}

export interface ListRunsParams {
  status?: RunStatus
  agentId?: string
  environment?: string
  sessionId?: string
  limit?: number
  cursor?: string
}

export interface ListEventsParams {
  limit?: number
  cursor?: string
}

/** Constructor options for {@link FlightReader}. */
export interface FlightReaderConfig {
  /** Base URL of the Agent Flight Recorder deployment (e.g. `https://afr.example.com`). */
  baseUrl: string
  /** An API key carrying the `read` scope (see `docs/api_reference.md` — a write-only `ingest:write` key is rejected with 403). */
  apiKey: string
  /**
   * Suppress the one-time console warning emitted when `baseUrl` uses plain
   * HTTP to a non-localhost host (the read-scoped API key would transit in
   * cleartext) — same warning, and same opt-out, as `RecorderConfig.options.
   * allowInsecureEndpoint` / `FlightRecorderConfig.allowInsecureEndpoint`.
   * Default: false.
   */
  allowInsecureEndpoint?: boolean
}

/**
 * Read-only client over the v1 read API.
 *
 * ```ts
 * const reader = new FlightReader({ baseUrl: 'https://afr.example.com', apiKey: process.env.AFR_READ_KEY! })
 * const { runs } = await reader.listRuns({ status: 'failed', limit: 25 })
 * const { run, eventCount } = await reader.getRun(runs[0].id)
 * for await (const event of reader.iterateEvents(run.id)) {
 *   console.log(event.type, event.sequenceNumber)
 * }
 * ```
 */
export class FlightReader {
  private readonly config: V1ApiConfig
  private readonly fetchImpl: V1FetchLike | undefined

  /**
   * @param config - `{ baseUrl, apiKey }`. The API key must carry the `read` scope.
   * @param fetchImpl - injectable fetch, defaults to the global `fetch`. Tests
   *   inject a mock here — never make a real HTTP call in a unit test.
   */
  constructor(config: FlightReaderConfig, fetchImpl?: V1FetchLike) {
    this.config = { baseUrl: config.baseUrl, apiKey: config.apiKey }
    this.fetchImpl = fetchImpl
    // Same cleartext-transit warning as the write paths (HttpTransport /
    // FlightRecorder) — a read-scoped key sent over plain HTTP to a
    // non-localhost host is just as exposed as a write-scoped one.
    warnIfInsecureEndpoint(config.baseUrl, config.allowInsecureEndpoint)
  }

  /**
   * List runs for the key's organization, most-recent-first.
   *
   * @param filters - optional `status`/`agentId`/`environment`/`sessionId` filters plus `limit`/`cursor` pagination.
   * @returns `{ runs, nextCursor }` — pass `nextCursor` back as `cursor` to page.
   * @throws {@link V1ApiError} on any auth/not-found/rate-limit/server/network failure.
   */
  listRuns(filters: ListRunsParams = {}): Promise<V1ListRunsData> {
    return fetchV1<V1ListRunsData>(
      this.config,
      '/api/v1/runs',
      {
        status: filters.status,
        agentId: filters.agentId,
        environment: filters.environment,
        sessionId: filters.sessionId,
        limit: filters.limit,
        cursor: filters.cursor,
      },
      this.fetchImpl
    )
  }

  /**
   * Fetch a single run by id, along with its event and artifact counts.
   *
   * @param runId - the run's id.
   * @throws {@link V1ApiError} with `kind: 'not_found'` if the run does not exist or does not belong to the key's org.
   */
  getRun(runId: string): Promise<V1GetRunData> {
    return fetchV1<V1GetRunData>(this.config, `/api/v1/runs/${encodeURIComponent(runId)}`, {}, this.fetchImpl)
  }

  /**
   * Fetch one page of a run's event log, in `sequenceNumber` order.
   *
   * @param runId - the run's id.
   * @param options - `limit` (page size) and `cursor` (opaque, from a previous page's `nextCursor`).
   * @returns `{ events, nextCursor }` — `nextCursor` is absent once the last page has been fetched.
   */
  getRunEvents(runId: string, options: ListEventsParams = {}): Promise<V1ListEventsData> {
    return fetchV1<V1ListEventsData>(
      this.config,
      `/api/v1/runs/${encodeURIComponent(runId)}/events`,
      { ...(options.limit !== undefined && { limit: options.limit }), ...(options.cursor !== undefined && { cursor: options.cursor }) },
      this.fetchImpl
    )
  }

  /**
   * Page transparently through a run's entire event log, yielding events in
   * `sequenceNumber` order. Fetches lazily, one page at a time, via
   * {@link getRunEvents} — a consumer that `break`s out of the loop early
   * simply stops paging.
   *
   * Guards against a misbehaving (or hostile) server hanging the caller
   * forever: if `nextCursor` is ever identical to the cursor just requested
   * (no pagination progress) or the loop exceeds `maxPages`, the generator
   * throws a {@link V1ApiError} with `kind: 'invalid_response'` instead of
   * looping without end.
   *
   * @param runId - the run's id.
   * @param options - `pageSize` controls the `limit` sent on each underlying
   *   request (server-capped). `maxPages` bounds total pages fetched
   *   (default: 100 000 — effectively unbounded for any real run, but finite).
   * @throws {@link V1ApiError} on a request failure, a non-advancing cursor, or `maxPages` exceeded.
   */
  async *iterateEvents(
    runId: string,
    options: { pageSize?: number; maxPages?: number } = {}
  ): AsyncGenerator<Event, void, void> {
    const maxPages = options.maxPages ?? 100_000
    let cursor: string | undefined
    let pages = 0
    do {
      if (pages >= maxPages) {
        throw new V1ApiError(
          'invalid_response',
          `iterateEvents(${runId}) aborted after ${maxPages} pages without reaching the end of the event log.`
        )
      }
      pages++
      const page = await this.getRunEvents(runId, {
        ...(options.pageSize !== undefined && { limit: options.pageSize }),
        ...(cursor !== undefined && { cursor }),
      })
      for (const event of page.events) {
        yield event
      }
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        // The server returned the same cursor it was just given — pagination
        // is not advancing. Looping forever on a stalled cursor is worse than
        // failing loudly: it would hang the caller's process indefinitely.
        throw new V1ApiError(
          'invalid_response',
          `iterateEvents(${runId}): server returned a non-advancing cursor ("${page.nextCursor}") — refusing to loop forever.`
        )
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }

  /**
   * Fetch the server-computed replay projection for a run — the same
   * derivation the web UI's replay view uses (CLAUDE.md: replay is a derived
   * projection, never stored).
   *
   * @param runId - the run's id.
   */
  getReplay(runId: string): Promise<V1ReplayData> {
    return fetchV1<V1ReplayData>(this.config, `/api/v1/runs/${encodeURIComponent(runId)}/replay`, {}, this.fetchImpl)
  }
}
