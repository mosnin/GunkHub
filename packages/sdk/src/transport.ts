import { PAYLOAD_EXTERNALIZATION_THRESHOLD } from '@agent-flight-recorder/contracts'

import type { CreateEventRequest, CreateRunRequest, CreateRunResponse, ExternalizedPayload } from '@agent-flight-recorder/contracts'
import type { TransportResponse } from './types.js'

export interface Transport {
  createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse>
  sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse>
  updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<void>
}

export interface TransportAuth {
  apiKey: string
  orgId?: string
}

export interface BatchingStrategy {
  shouldFlush(bufferedCount: number, lastFlushMs: number): boolean
  maxBatchSize: number
}

export interface RetryStrategy {
  shouldRetry(attempt: number, error: TransportResponse & { success: false }): boolean
  delayMs(attempt: number): number
}

export class HttpTransport implements Transport {
  private readonly endpoint: string
  private readonly timeoutMs: number

  /**
   * Create an HttpTransport that sends requests to the given endpoint.
   *
   * @param endpoint - Base URL of the Agent Flight Recorder API (e.g. "http://localhost:3000")
   * @param timeoutMs - Per-request timeout in milliseconds. Defaults to 10 000 ms.
   */
  constructor(endpoint: string, timeoutMs = 10_000) {
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
  }

  /**
   * Wraps `fetch` with an AbortController-based timeout so that hung requests
   * do not block the SDK indefinitely.
   */
  private async _fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(id)
    }
  }

  /**
   * Returns a promise that resolves after `ms` milliseconds. Used for retry
   * back-off delays.
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Upload an oversized event payload as an artifact so the event record can
   * store a compact pointer instead of the full inline payload.
   *
   * Sends POST /api/artifacts/upload with the raw payload JSON.
   *
   * @param runId - ID of the run this event belongs to
   * @param eventType - The event type string (e.g. "llm.response") — used as the artifact name
   * @param serializedPayload - The already-serialized JSON string of the event payload
   * @param auth - Authentication credentials (API key)
   * @returns Artifact pointer fields needed to construct an `ExternalizedPayload`
   * @throws Error if the upload request fails (non-2xx) or the network is unreachable
   */
  private async _uploadArtifact(
    runId: string,
    eventType: string,
    serializedPayload: string,
    auth: TransportAuth,
  ): Promise<{ artifactId: string; storageKey: string; storageBucket: string; checksum: string; size: number }> {
    const url = `${this.endpoint}/api/artifacts/upload`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': auth.apiKey,
    }

    const response = await this._fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        runId,
        name: `${eventType.replace('.', '-')}.payload.json`,
        mimeType: 'application/json',
        payload: JSON.parse(serializedPayload),
      }),
    })

    if (!response.ok) {
      let body = ''
      try {
        body = await response.text()
      } catch {
        // ignore parse failure
      }
      throw new Error(`HTTP ${response.status}: ${body}`)
    }

    return (await response.json()) as {
      artifactId: string
      storageKey: string
      storageBucket: string
      checksum: string
      size: number
    }
  }

  /**
   * Create a new run on the server.
   *
   * Sends POST /api/runs with the given request body.
   * Retries on transient failures using `defaultRetryStrategy`.
   * Throws on unrecoverable errors so that `Recorder.startRun` can surface
   * the failure to the caller (Recorder wraps startRun in a try/catch).
   *
   * @param req - Run creation payload (agentId, metadata, tags, etc.)
   * @param auth - Authentication credentials (API key)
   * @returns The created run wrapped in a `CreateRunResponse`
   * @throws Error on network failure, timeout, or non-2xx response
   */
  async createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse> {
    const url = `${this.endpoint}/api/runs`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': auth.apiKey,
    }

    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response
      try {
        response = await this._fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(req),
        })
      } catch (err) {
        // Network error or timeout — check retry eligibility
        const transportErr: TransportResponse & { success: false } = {
          success: false,
          retryable: true,
          error: err instanceof Error ? err.message : String(err),
        }

        if (defaultRetryStrategy.shouldRetry(attempt, transportErr)) {
          await this._sleep(defaultRetryStrategy.delayMs(attempt))
          attempt++
          continue
        }

        throw new Error(
          `HttpTransport.createRun failed after ${attempt + 1} attempt(s): ${transportErr.error}`
        )
      }

      if (response.ok) {
        return (await response.json()) as CreateRunResponse
      }

      // Non-2xx response
      let errorBody = ''
      try {
        errorBody = await response.text()
      } catch {
        // ignore parse failure
      }

      const retryable = response.status >= 500
      const transportErr: TransportResponse & { success: false } = {
        success: false,
        retryable,
        error: `HTTP ${response.status}: ${errorBody}`,
      }

      if (retryable && defaultRetryStrategy.shouldRetry(attempt, transportErr)) {
        await this._sleep(defaultRetryStrategy.delayMs(attempt))
        attempt++
        continue
      }

      throw new Error(
        `HttpTransport.createRun received HTTP ${response.status}: ${errorBody}`
      )
    }
  }

  /**
   * Send a batch of recorded events to the server.
   *
   * Sends POST /api/events with the event array.
   * This method NEVER throws — all errors are captured and returned in
   * `TransportResponse` so they can be surfaced via `FlushResult` without
   * crashing customer agent code.
   *
   * Retry behaviour:
   *  - Network errors / timeouts → retryable, uses defaultRetryStrategy
   *  - 4xx responses → not retryable (client error, e.g. bad API key)
   *  - 5xx responses → retryable, uses defaultRetryStrategy
   *
   * @param events - Array of event payloads to send
   * @param auth - Authentication credentials (API key)
   * @returns `{ success: true }` on success, or `{ success: false, retryable, error }` on failure
   */
  async sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse> {
    const url = `${this.endpoint}/api/events`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': auth.apiKey,
    }

    // Pre-externalize any events whose payload exceeds the threshold.
    // Done before the retry loop so we don't re-upload on retry.
    //
    // uploadCache: prevents redundant blob PUT calls when the same oversized
    // payload appears more than once in a single sendEvents call. Keyed by the
    // full serialized payload string. Scope is this call only — the Map is
    // declared as a local const and is GC'd when sendEvents returns.
    const uploadCache = new Map<string, {
      artifactId: string
      storageKey: string
      storageBucket: string
      checksum: string
      size: number
    }>()

    const processedEvents: CreateEventRequest[] = []
    for (const event of events) {
      const serialized = JSON.stringify(event.payload)
      // Measure UTF-8 BYTES, not UTF-16 code units. `string.length` undercounts
      // multi-byte characters, so a payload that is >10 KB on the wire (and in the
      // Convex document store, which the server now rejects) could slip under the
      // threshold and never externalize. TextEncoder gives the true byte length.
      const byteLength = new TextEncoder().encode(serialized).length
      if (byteLength > PAYLOAD_EXTERNALIZATION_THRESHOLD) {
        // Check the per-call cache before issuing a PUT to blob storage
        const cached = uploadCache.get(serialized)
        if (cached) {
          processedEvents.push({
            ...event,
            payload: {
              type: '_externalized' as const,
              originalType: event.type,
              _artifact: cached,
            } satisfies ExternalizedPayload,
          })
          continue
        }

        // Cache miss — upload the oversized payload as an artifact first
        try {
          const pointer = await this._uploadArtifact(event.runId, event.type, serialized, auth)
          uploadCache.set(serialized, pointer)
          processedEvents.push({
            ...event,
            payload: {
              type: '_externalized' as const,
              originalType: event.type,
              _artifact: pointer,
            } satisfies ExternalizedPayload,
          })
        } catch (err) {
          return {
            success: false,
            retryable: false,
            error: `Failed to externalize payload for event seq=${event.sequenceNumber}: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      } else {
        processedEvents.push(event)
      }
    }

    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response
      try {
        response = await this._fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: processedEvents }),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const transportErr: TransportResponse & { success: false } = {
          success: false,
          retryable: true,
          error: `Network error: ${message}`,
        }

        if (defaultRetryStrategy.shouldRetry(attempt, transportErr)) {
          await this._sleep(defaultRetryStrategy.delayMs(attempt))
          attempt++
          continue
        }

        return transportErr
      }

      if (response.ok) {
        return { success: true, eventIds: [] }
      }

      // 4xx — client error, not retryable
      if (response.status >= 400 && response.status < 500) {
        let message = `HTTP ${response.status}`
        try {
          const body = (await response.json()) as { message?: string }
          if (body.message) message = body.message
        } catch {
          // ignore parse failure
        }
        return { success: false, retryable: false, error: message }
      }

      // 5xx — server error, retryable
      const transportErr: TransportResponse & { success: false } = {
        success: false,
        retryable: true,
        error: `Server error: HTTP ${response.status}`,
      }

      if (defaultRetryStrategy.shouldRetry(attempt, transportErr)) {
        await this._sleep(defaultRetryStrategy.delayMs(attempt))
        attempt++
        continue
      }

      return transportErr
    }
  }

  /**
   * Update the status of a run on the server (e.g. mark it "completed" or "failed").
   *
   * Sends PATCH /api/runs/:runId/status.
   * This method NEVER throws — errors are swallowed so that SDK shutdown
   * (triggered from `endRun` / `failRun`) cannot crash customer agent code.
   *
   * @param runId - ID of the run to update
   * @param status - New run status string (e.g. "completed", "failed")
   * @param endedAt - Optional Unix timestamp (ms) when the run ended
   * @param auth - Authentication credentials (API key)
   */
  async updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<void> {
    if (!auth) return

    const url = `${this.endpoint}/api/runs/${runId}/status`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': auth.apiKey,
    }

    const body: Record<string, unknown> = { status }
    if (endedAt !== undefined) {
      body['endedAt'] = endedAt
    }

    try {
      await this._fetchWithTimeout(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      })
      // Response body is intentionally ignored — this is a best-effort call
    } catch {
      // Swallow all errors: network failures, timeouts, non-2xx responses.
      // SDK shutdown must not crash customer code.
    }
  }
}

export const defaultBatchingStrategy: BatchingStrategy = {
  maxBatchSize: 100,
  shouldFlush(bufferedCount: number, lastFlushMs: number): boolean {
    return bufferedCount >= this.maxBatchSize || (Date.now() - lastFlushMs) > 1000
  },
}

export const defaultRetryStrategy: RetryStrategy = {
  shouldRetry(attempt: number, error: TransportResponse & { success: false }): boolean {
    return attempt < 3 && error.retryable
  },
  delayMs(attempt: number): number {
    return 500 * Math.pow(2, attempt)
  },
}
