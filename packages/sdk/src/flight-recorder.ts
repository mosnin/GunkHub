import { externalizePayloadIfLarge, uploadArtifact } from './externalize.js'

import type {
  RunStartedPayload,
  RunCompletedPayload,
  RunFailedPayload,
} from '@agent-flight-recorder/contracts'

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
 * Unlike the buffered {@link Recorder}, this is an un-buffered path: each event
 * is POSTed immediately. It shares the SAME payload-externalization logic as the
 * buffered path, so an oversized (>10 KB) payload is uploaded as an artifact and
 * replaced with a pointer rather than being shipped inline and rejected.
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
    const recorder = new RunRecorder(data.run.id, this)
    // Event Log Rule 5: RUN_STARTED must be the first event. Emit it so a run
    // created through this high-level path has a lifecycle log like the low-level
    // Recorder path. The run.started event is non-terminal, so it stays
    // best-effort here: a failed run.started must not break run creation.
    const startedPayload: RunStartedPayload = {
      type: 'run.started',
      input: params?.metadata ?? null,
      config: params?.metadata ?? {},
    }
    try {
      await recorder.recordEvent('run.started', startedPayload)
    } catch {
      // best-effort: run creation already succeeded
    }
    return recorder
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
  /** Wall-clock time (ms) this run recorder was created, for duration_ms. */
  private readonly startedAt: number
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
    this.startedAt = Date.now()
  }

  /** Increment and return the next per-run sequence number (starts at 1). */
  private nextSequence(): number {
    return ++this.sequenceCounter
  }

  /**
   * Record an event in this run.
   *
   * Calls POST /api/events. Sequence numbers are assigned automatically and
   * monotonically. Oversized payloads (>10 KB serialized) are first uploaded as
   * an artifact via POST /api/artifacts/upload and replaced with a compact
   * pointer, matching the buffered `Recorder`/`HttpTransport` path — so a large
   * payload is never shipped inline and 413'd. The caller is responsible for
   * ensuring the run has not already reached a terminal state.
   *
   * @param type - Event type string (e.g. 'run.started', 'llm.request', 'custom').
   * @param payload - Arbitrary event payload. Must be JSON-serialisable.
   * @param parentEventId - Optional ID of the parent event for tree-shaped traces.
   * @returns The event ID assigned by the server.
   * @throws Error if the request fails (network failure, upload failure, or non-2xx response).
   */
  async recordEvent(type: string, payload: unknown, parentEventId?: string): Promise<string> {
    const seq = this.nextSequence()

    // Externalize oversized payloads through the shared helper so this path
    // enforces the same >10 KB rule as HttpTransport. Failures propagate.
    const outgoingPayload = await externalizePayloadIfLarge(
      this.runId,
      type,
      payload,
      (runId, eventType, serialized) =>
        uploadArtifact((u, i) => fetch(u, i), this.fr.baseUrl, this.fr.apiKey, runId, eventType, serialized),
    )

    const body: Record<string, unknown> = {
      runId: this.runId,
      type,
      sequenceNumber: seq,
      timestamp: Date.now(),
      payload: outgoingPayload,
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
   * Records the terminal `run.completed` event (Event Log Rule 5) and then calls
   * PATCH /api/runs/:id/status with `status: 'completed'`. Unlike the previous
   * implementation, a failure to record the terminal event is NOT swallowed —
   * losing terminal telemetry is the worst failure mode for a flight recorder,
   * so it propagates to the caller.
   *
   * @param metadata - Optional output metadata recorded as the run.completed output.
   * @throws Error if the terminal event cannot be recorded or the status update fails.
   */
  async complete(metadata?: Record<string, unknown>): Promise<void> {
    const payload: RunCompletedPayload = {
      type: 'run.completed',
      output: metadata ?? null,
      duration_ms: Date.now() - this.startedAt,
    }
    // Surface terminal-event failures rather than swallowing them.
    await this.recordEvent('run.completed', payload)
    await this._updateStatus('completed')
  }

  /**
   * Mark the run as failed.
   *
   * Records the terminal `run.failed` event (Event Log Rule 5), then calls
   * PATCH /api/runs/:id/status with `status: 'failed'`, then re-throws the
   * original error so the caller's promise chain remains rejected.
   *
   * Terminal-event failures are surfaced, not swallowed: if run.failed cannot be
   * recorded, a combined error is thrown that still includes the original error's
   * message (and carries the original as its `cause`). A subsequent status-update
   * failure is swallowed so the original error stays the primary signal.
   *
   * @param error - The error that caused the failure. Can be an Error instance
   *   or a plain string message.
   * @throws Always throws after attempting the status update — the original error
   *   on the happy path, or a combined error if terminal telemetry could not be recorded.
   */
  async fail(error: Error | string): Promise<void> {
    const originalError = error instanceof Error ? error : new Error(error)
    const payload: RunFailedPayload = {
      type: 'run.failed',
      error: {
        message: originalError.message,
        ...(originalError.stack !== undefined && { stack: originalError.stack }),
      },
      duration_ms: Date.now() - this.startedAt,
    }

    try {
      await this.recordEvent('run.failed', payload)
    } catch (recErr) {
      // Do NOT hide a dropped terminal event. Surface it, but keep the original
      // agent error as the primary cause and in the message for callers matching on it.
      const detail = recErr instanceof Error ? recErr.message : String(recErr)
      const combined = new Error(
        `${originalError.message} (additionally, run.failed telemetry could not be recorded: ${detail})`
      )
      ;(combined as { cause?: unknown }).cause = originalError
      throw combined
    }

    try {
      await this._updateStatus('failed')
    } catch {
      // Swallow status-update failures — the caller's error takes priority.
    }
    throw originalError
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
