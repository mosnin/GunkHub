/**
 * Configuration for FlightRecorder.
 */
export interface FlightRecorderConfig {
  /** API key for authentication (passed as x-api-key header). */
  apiKey: string
  /**
   * Base URL of the Agent Flight Recorder deployment.
   * Example: 'http://localhost:3000' or 'https://yourapp.com'
   * Trailing slash is stripped automatically.
   */
  baseUrl: string
  /** Agent ID that all runs created by this recorder belong to. */
  agentId: string
  /** Optional agent version string. Included in run creation payloads. */
  agentVersionId?: string
  /**
   * SDK version string included in run creation payloads.
   * Defaults to '0.1.0'.
   */
  sdkVersion?: string
}

/**
 * FlightRecorder is a high-level entry point for the Agent Flight Recorder SDK.
 *
 * It manages the `agentId`/`apiKey` configuration so callers only need to
 * supply run-specific parameters when starting a run. All HTTP calls use
 * native `fetch` (Node 18+).
 *
 * @example
 * ```typescript
 * const recorder = new FlightRecorder({
 *   apiKey: 'my-api-key',
 *   baseUrl: 'http://localhost:3000',
 *   agentId: 'my-agent',
 * })
 * const run = await recorder.startRun({ tags: ['demo'] })
 * await run.recordEvent('custom', { hello: 'world' })
 * await run.complete()
 * ```
 */
export class FlightRecorder {
  /** Normalised base URL (trailing slash stripped). */
  readonly baseUrl: string
  readonly apiKey: string
  readonly agentId: string
  private readonly agentVersionId: string | undefined
  private readonly sdkVersion: string

  /**
   * Create a new FlightRecorder.
   *
   * @param config - Recorder configuration including API key, base URL, and agent ID.
   */
  constructor(config: FlightRecorderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.apiKey = config.apiKey
    this.agentId = config.agentId
    this.agentVersionId = config.agentVersionId
    this.sdkVersion = config.sdkVersion ?? '0.1.0'
  }

  /**
   * Start a new run and return a RunRecorder for recording events into it.
   *
   * Calls POST /api/runs on the configured base URL. Throws if the request
   * fails or returns a non-2xx status.
   *
   * @param params - Optional run parameters: metadata, tags, and triggeredBy.
   * @returns A RunRecorder bound to the newly created run.
   * @throws Error if the run cannot be created (network failure or non-2xx response).
   */
  async startRun(params?: {
    metadata?: Record<string, unknown>
    tags?: string[]
    triggeredBy?: string
  }): Promise<RunRecorder> {
    const body: Record<string, unknown> = {
      agentId: this.agentId,
      sdkVersion: this.sdkVersion,
    }
    if (this.agentVersionId !== undefined) body['agentVersionId'] = this.agentVersionId
    if (params?.metadata !== undefined) body['metadata'] = params.metadata
    if (params?.tags !== undefined) body['tags'] = params.tags
    if (params?.triggeredBy !== undefined) body['triggeredBy'] = params.triggeredBy

    const response = await fetch(`${this.baseUrl}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const errBody = (await response.json()) as { message?: string }
        if (errBody.message) message = errBody.message
      } catch {
        // ignore parse failures — keep the HTTP status message
      }
      throw new Error(`FlightRecorder.startRun failed: ${message}`)
    }

    const data = (await response.json()) as { run: { id: string } }
    return new RunRecorder(data.run.id, this)
  }
}

/**
 * RunRecorder is a scoped recorder tied to a single run.
 *
 * Obtain a RunRecorder via `FlightRecorder.startRun()`. Do not construct directly.
 */
export class RunRecorder {
  /** The run ID assigned by the server. */
  readonly runId: string

  private readonly fr: FlightRecorder
  /**
   * Per-run sequence counter. CLAUDE.md Event Log Rule 4 requires sequence
   * numbers to be monotonically increasing integers starting at 1 *within a run*
   * and contiguous — so the counter must live on the RunRecorder, not shared
   * across runs on the parent FlightRecorder. The server now rejects
   * non-contiguous sequences, so a shared counter would fail verification for
   * every run after the first.
   */
  private sequenceCounter = 0

  /**
   * @param runId - Run ID returned by the server.
   * @param fr - Parent FlightRecorder (provides config and sequence numbers).
   * @internal
   */
  constructor(runId: string, fr: FlightRecorder) {
    this.runId = runId
    this.fr = fr
  }

  /** Increment and return the next per-run sequence number (starts at 1). */
  private nextSequence(): number {
    return ++this.sequenceCounter
  }

  /**
   * Record an event in this run.
   *
   * Calls POST /api/events. Sequence numbers are assigned automatically and
   * monotonically. The caller is responsible for ensuring the run has not
   * already reached a terminal state.
   *
   * @param type - Event type string (e.g. 'RUN_STARTED', 'LLM_REQUEST', 'custom').
   * @param payload - Arbitrary event payload. Must be JSON-serialisable.
   * @param parentEventId - Optional ID of the parent event for tree-shaped traces.
   * @returns The event ID assigned by the server.
   * @throws Error if the request fails (network failure or non-2xx response).
   */
  async recordEvent(type: string, payload: unknown, parentEventId?: string): Promise<string> {
    const seq = this.nextSequence()

    const body: Record<string, unknown> = {
      runId: this.runId,
      type,
      sequenceNumber: seq,
      timestamp: Date.now(),
      payload,
    }
    if (parentEventId !== undefined) body['parentEventId'] = parentEventId

    const response = await fetch(`${this.fr.baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.fr.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const errBody = (await response.json()) as { message?: string }
        if (errBody.message) message = errBody.message
      } catch {
        // ignore parse failures
      }
      throw new Error(message)
    }

    const result = (await response.json()) as { eventId?: string; event?: { id: string } }
    return result.eventId ?? result.event?.id ?? ''
  }

  /**
   * Mark the run as completed.
   *
   * Calls PATCH /api/runs/:id/status with `status: 'completed'`.
   *
   * @param _metadata - Reserved for future use; currently ignored.
   * @throws Error if the status update request fails.
   */
  async complete(_metadata?: Record<string, unknown>): Promise<void> {
    await this._updateStatus('completed')
  }

  /**
   * Mark the run as failed.
   *
   * Calls PATCH /api/runs/:id/status with `status: 'failed'`, then re-throws
   * the original error so the caller's promise chain remains in a rejected
   * state. If a status update error occurs it is swallowed so the original
   * error is always the one surfaced.
   *
   * @param error - The error that caused the failure. Can be an Error instance
   *   or a plain string message.
   * @throws Always re-throws `error` after attempting the status update.
   */
  async fail(error: Error | string): Promise<void> {
    try {
      await this._updateStatus('failed')
    } catch {
      // Swallow status-update failures — the caller's error takes priority.
    }
    if (error instanceof Error) throw error
    throw new Error(error)
  }

  private async _updateStatus(status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    const response = await fetch(`${this.fr.baseUrl}/api/runs/${this.runId}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.fr.apiKey,
      },
      body: JSON.stringify({ status, endedAt: Date.now() }),
    })

    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const errBody = (await response.json()) as { message?: string }
        if (errBody.message) message = errBody.message
      } catch {
        // ignore
      }
      throw new Error(`RunRecorder.${status} failed: ${message}`)
    }
  }
}
