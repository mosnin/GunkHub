import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@agent-flight-recorder/contracts'

import { externalizePayloadIfLarge, uploadArtifact, type ArtifactPointer } from './externalize.js'

import type { TransportResponse } from './types.js'
import type { CreateEventRequest, CreateRunRequest, CreateRunResponse } from '@agent-flight-recorder/contracts'

export interface Transport {
  createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse>
  sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse>
  /**
   * Transition a run's status on the server (e.g. "completed" / "failed").
   *
   * Returns a `TransportResponse` so callers can surface a failed terminal
   * transition instead of leaving the run stuck "running" forever. Implementations
   * must never throw — failures are reported via the returned `TransportResponse`.
   */
  updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<TransportResponse>
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

/** Options for constructing an {@link HttpTransport}. */
export interface HttpTransportOptions {
  /** Per-request timeout in milliseconds. Default: 10 000 ms. */
  timeoutMs?: number
  /** Retry policy for transient failures. Default: {@link defaultRetryStrategy}. */
  retryStrategy?: RetryStrategy
  /** Batching policy. Default: {@link defaultBatchingStrategy}. */
  batchingStrategy?: BatchingStrategy
  /**
   * Suppress the one-time console warning emitted when the endpoint uses
   * plain HTTP to a non-localhost host. Default: false.
   */
  allowInsecureEndpoint?: boolean
}

/** Endpoints already warned about, so each is warned at most once per process. */
const warnedInsecureEndpoints = new Set<string>()

/**
 * Warn (once per endpoint, per process) when a configured endpoint is plain
 * HTTP to a non-loopback host — the API key and all recorded payloads would
 * transit the network in cleartext. `localhost` / `127.0.0.1` / `::1` /
 * `*.localhost` are exempt (local development). Suppressible via
 * `allowInsecureEndpoint: true`. Unparseable endpoints are ignored here; they
 * fail loudly at request time instead.
 */
export function warnIfInsecureEndpoint(endpoint: string, allowInsecureEndpoint?: boolean): void {
  if (allowInsecureEndpoint) return
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return
  }
  if (url.protocol !== 'http:') return
  const host = url.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')) {
    return
  }
  if (warnedInsecureEndpoints.has(endpoint)) return
  warnedInsecureEndpoints.add(endpoint)
  console.warn(
    `[afr-sdk] Endpoint "${endpoint}" uses plain HTTP to a non-localhost host — the API key and recorded payloads will be sent in cleartext. Use https://, or pass allowInsecureEndpoint: true to suppress this warning.`
  )
}

export class HttpTransport implements Transport {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly retryStrategy: RetryStrategy
  private readonly batchingStrategy: BatchingStrategy

  /**
   * Create an HttpTransport that sends requests to the given endpoint.
   *
   * @param endpoint - Base URL of the Agent Flight Recorder API (e.g. "http://localhost:3000")
   * @param options - Optional timeout, retry strategy, and batching strategy. For
   *   backwards compatibility a bare `number` is accepted and treated as `timeoutMs`.
   */
  constructor(endpoint: string, options?: HttpTransportOptions | number) {
    this.endpoint = endpoint
    const opts: HttpTransportOptions = typeof options === 'number' ? { timeoutMs: options } : options ?? {}
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.retryStrategy = opts.retryStrategy ?? defaultRetryStrategy
    this.batchingStrategy = opts.batchingStrategy ?? defaultBatchingStrategy
    warnIfInsecureEndpoint(endpoint, opts.allowInsecureEndpoint)
  }

  /** The batching strategy this transport was configured with. */
  get batching(): BatchingStrategy {
    return this.batchingStrategy
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

  /** Timeout-wrapped artifact uploader used by the externalization helper. */
  private _uploadArtifact(auth: TransportAuth): (runId: string, eventType: string, serialized: string) => Promise<ArtifactPointer> {
    return (runId, eventType, serialized) =>
      uploadArtifact((u, i) => this._fetchWithTimeout(u, i), this.endpoint, auth.apiKey, runId, eventType, serialized)
  }

  /**
   * Create a new run on the server.
   *
   * Sends POST /api/runs with the given request body.
   * Retries on transient failures using the configured retry strategy.
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
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
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

        if (this.retryStrategy.shouldRetry(attempt, transportErr)) {
          await this._sleep(this.retryStrategy.delayMs(attempt))
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

      if (retryable && this.retryStrategy.shouldRetry(attempt, transportErr)) {
        await this._sleep(this.retryStrategy.delayMs(attempt))
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
   *  - Network errors / timeouts → retryable, uses the configured retry strategy
   *  - 4xx responses → not retryable (client error, e.g. bad API key)
   *  - 5xx responses → retryable, uses the configured retry strategy
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
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    }

    // Pre-externalize any events whose payload exceeds the threshold. Done before
    // the retry loop so we don't re-upload on retry. The per-call cache prevents
    // redundant blob uploads when the same oversized payload appears more than
    // once in a single batch; it is GC'd when sendEvents returns.
    const uploadCache = new Map<string, ArtifactPointer>()
    const upload = this._uploadArtifact(auth)

    const processedEvents: CreateEventRequest[] = []
    for (const event of events) {
      try {
        const payload = await externalizePayloadIfLarge(
          event.runId,
          event.type,
          event.payload,
          upload,
          uploadCache,
        )
        processedEvents.push({ ...event, payload })
      } catch (err) {
        return {
          success: false,
          retryable: false,
          error: `Failed to externalize payload for event seq=${event.sequenceNumber}: ${err instanceof Error ? err.message : String(err)}`,
        }
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

        if (this.retryStrategy.shouldRetry(attempt, transportErr)) {
          await this._sleep(this.retryStrategy.delayMs(attempt))
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

      if (this.retryStrategy.shouldRetry(attempt, transportErr)) {
        await this._sleep(this.retryStrategy.delayMs(attempt))
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
   * This method NEVER throws — all failures (network, timeout, non-2xx) are
   * captured and returned as a `TransportResponse`. A failed terminal transition
   * MUST be surfaced to the caller so the run does not silently remain "running"
   * forever; retries follow the configured retry strategy.
   *
   * @param runId - ID of the run to update
   * @param status - New run status string (e.g. "completed", "failed")
   * @param endedAt - Optional Unix timestamp (ms) when the run ended
   * @param auth - Authentication credentials (API key)
   * @returns `{ success: true }` on success, or `{ success: false, retryable, error }` on failure
   */
  async updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<TransportResponse> {
    if (!auth) {
      return { success: false, retryable: false, error: 'updateRunStatus called without auth' }
    }

    const url = `${this.endpoint}/api/runs/${runId}/status`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': auth.apiKey,
      [PROTOCOL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    }

    const body: Record<string, unknown> = { status }
    if (endedAt !== undefined) {
      body['endedAt'] = endedAt
    }

    let attempt = 0

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response: Response
      try {
        response = await this._fetchWithTimeout(url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        })
      } catch (err) {
        const transportErr: TransportResponse & { success: false } = {
          success: false,
          retryable: true,
          error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        }
        if (this.retryStrategy.shouldRetry(attempt, transportErr)) {
          await this._sleep(this.retryStrategy.delayMs(attempt))
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
          const parsed = (await response.json()) as { message?: string }
          if (parsed.message) message = parsed.message
        } catch {
          // ignore parse failure
        }
        return { success: false, retryable: false, error: message }
      }

      // 5xx — retryable
      const transportErr: TransportResponse & { success: false } = {
        success: false,
        retryable: true,
        error: `Server error: HTTP ${response.status}`,
      }
      if (this.retryStrategy.shouldRetry(attempt, transportErr)) {
        await this._sleep(this.retryStrategy.delayMs(attempt))
        attempt++
        continue
      }
      return transportErr
    }
  }
}

export const defaultBatchingStrategy: BatchingStrategy = {
  maxBatchSize: 100,
  shouldFlush(bufferedCount: number, lastFlushMs: number): boolean {
    return bufferedCount >= this.maxBatchSize || (Date.now() - lastFlushMs) > 1000
  },
}

/** Options for {@link createRetryStrategy}. */
export interface RetryStrategyOptions {
  /** Maximum number of retry attempts. Default: 3. */
  maxRetries?: number
  /** Initial back-off in ms (doubled each attempt). Default: 500. */
  backoffMs?: number
  /** Upper bound on any single back-off delay, before jitter. Default: 30 000. */
  maxBackoffMs?: number
}

/**
 * Build a {@link RetryStrategy} from the given options. Delays use exponential
 * back-off capped at `maxBackoffMs`, with full jitter applied to spread retries
 * and avoid thundering-herd behaviour against a recovering server.
 *
 * @param options - retry tuning knobs (all optional)
 * @returns a RetryStrategy suitable for injection into {@link HttpTransport}
 */
export function createRetryStrategy(options: RetryStrategyOptions = {}): RetryStrategy {
  const maxRetries = options.maxRetries ?? 3
  const backoffMs = options.backoffMs ?? 500
  const maxBackoffMs = options.maxBackoffMs ?? 30_000
  return {
    shouldRetry(attempt: number, error: TransportResponse & { success: false }): boolean {
      return attempt < maxRetries && error.retryable
    },
    delayMs(attempt: number): number {
      const exponential = backoffMs * Math.pow(2, attempt)
      const capped = Math.min(exponential, maxBackoffMs)
      // Full jitter: a random value in [0, capped]. Prevents synchronized retries.
      return Math.floor(Math.random() * capped)
    },
  }
}

export const defaultRetryStrategy: RetryStrategy = createRetryStrategy()
