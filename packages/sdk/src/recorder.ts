import { Events, buildEvent } from './events.js'
import { HttpTransport, createRetryStrategy, type Transport } from './transport.js'

import type { RecorderConfig, RunContext, RecordEventOptions, FlushResult } from './types.js'
import type { RunStatus, EventType, EventPayload } from '@agent-flight-recorder/contracts'

/** Minimal shape of the Node `process` global we depend on (avoids @types/node). */
interface NodeProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  exitCode?: number
}

/** Event types that must never be dropped from the buffer on overflow. */
const PROTECTED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
])

/** Return the Node process if we're running under Node, otherwise undefined. */
function getNodeProcess(): NodeProcessLike | undefined {
  const p = (globalThis as { process?: unknown }).process
  if (p && typeof (p as NodeProcessLike).on === 'function' && typeof (p as NodeProcessLike).off === 'function') {
    return p as NodeProcessLike
  }
  return undefined
}

export class Recorder {
  private readonly config: RecorderConfig
  private readonly transport: Transport
  private runContext: RunContext | null = null
  private eventBuffer: ReturnType<typeof buildEvent>[] = []
  private sequenceCounter = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  // Serializes flushes. flush() is launched fire-and-forget from both the flush
  // timer and the maxBatch path, so without serialization two overlapping FAILED
  // flushes would unshift LIFO and reorder the buffer out of sequence order —
  // which the server's non-repeating/contiguity check then rejects, wedging the
  // buffer so terminal events never persist. Chaining guarantees at most one
  // in-flight flush and preserves buffer order.
  private flushChain: Promise<unknown> = Promise.resolve()

  /** Cumulative count of events dropped from the buffer due to overflow. */
  private droppedEventCount = 0

  private processHandlersInstalled = false
  private readonly onBeforeExit = (): void => {
    // Best-effort flush as the event loop drains. Never rejects into the host.
    void this.shutdown().catch(() => {})
  }
  private readonly onUncaught = (err: unknown): void => {
    // An uncaught exception genuinely crashed the run — mark it failed and flush
    // best-effort. We do NOT call process.exit: as an observability library the
    // SDK must not seize the host's shutdown. Setting exitCode preserves the
    // failure signal for whenever the process naturally exits.
    void this.crashRun(err).catch(() => {})
    const proc = getNodeProcess()
    if (proc) proc.exitCode = 1
  }

  constructor(config: RecorderConfig, transport?: Transport) {
    this.config = config
    // When we own the transport, thread the retry-tuning options through so
    // maxRetries/retryBackoffMs actually take effect instead of being dead config.
    this.transport =
      transport ??
      new HttpTransport(config.endpoint, {
        retryStrategy: createRetryStrategy({
          ...(config.options?.maxRetries !== undefined && { maxRetries: config.options.maxRetries }),
          ...(config.options?.retryBackoffMs !== undefined && { backoffMs: config.options.retryBackoffMs }),
        }),
      })
    if (config.options?.captureProcessExit) {
      this.installProcessHandlers()
    }
  }

  /**
   * Start a new run. Must be called before recording any events.
   * Returns the run context including the assigned run ID.
   */
  async startRun(input: unknown, runConfig: Record<string, unknown> = {}): Promise<RunContext> {
    if (this.runContext) {
      throw new Error('A run is already active. Call endRun() before starting a new one.')
    }

    const runResponse = await this.transport.createRun(
      {
        agentId: this.config.agentId,
        // exactOptionalPropertyTypes: only spread if defined
        ...(this.config.agentVersionId !== undefined && { agentVersionId: this.config.agentVersionId }),
        metadata: runConfig,
        tags: [],
        sdkVersion: '0.1.0',
      },
      { apiKey: this.config.apiKey }
    )

    this.runContext = {
      runId: runResponse.run.id,
      agentId: this.config.agentId,
      status: 'running',
      startedAt: Date.now(),
    }

    this.sequenceCounter = 0
    this.recordEvent('run.started', Events.runStarted(this.runContext.runId, input, runConfig).payload)

    this.scheduleFlush()
    return this.runContext
  }

  /**
   * Record an event in the current run.
   */
  recordEvent(
    type: EventType,
    payload: EventPayload,
    options?: RecordEventOptions
  ): void {
    if (!this.runContext) {
      throw new Error('No active run. Call startRun() first.')
    }

    const seq = options?.sequenceNumber ?? ++this.sequenceCounter

    // exactOptionalPropertyTypes: conditionally spread optional fields
    const eventOptions = {
      ...(options?.parentEventId !== undefined && { parentEventId: options.parentEventId }),
      ...(options?.timestamp !== undefined && { timestamp: options.timestamp }),
    }

    this.eventBuffer.push(
      buildEvent(
        this.runContext.runId,
        '', // orgId resolved server-side from API key
        type,
        payload,
        seq,
        eventOptions
      )
    )

    this.enforceBufferLimit()

    const maxBatch = this.config.options?.maxBatchSize ?? 100
    if (this.eventBuffer.length >= maxBatch) {
      // Fire-and-forget: a throwing custom Transport must not surface as an
      // unhandled rejection in the host.
      void this.flush().catch(() => {})
    }
  }

  /**
   * Enforce the configured `maxBufferSize`. When the buffer exceeds the cap,
   * drop the OLDEST non-protected events (protected = run.started and the
   * terminal events) until the buffer is back within bounds. Terminal telemetry
   * is the worst thing to lose, so it is never dropped. Dropped events are
   * counted and surfaced via `FlushResult.droppedEvents`.
   */
  private enforceBufferLimit(): void {
    const max = this.config.options?.maxBufferSize ?? 10_000
    if (max <= 0 || this.eventBuffer.length <= max) return

    let toDrop = this.eventBuffer.length - max
    const kept: ReturnType<typeof buildEvent>[] = []
    for (const ev of this.eventBuffer) {
      if (toDrop > 0 && !PROTECTED_EVENT_TYPES.has(ev.type)) {
        toDrop--
        this.droppedEventCount++
        continue
      }
      kept.push(ev)
    }
    this.eventBuffer = kept
  }

  /**
   * Complete the run successfully.
   */
  async endRun(output: unknown): Promise<FlushResult> {
    if (!this.runContext) throw new Error('No active run.')
    this.recordEvent(
      'run.completed',
      Events.runCompleted(this.runContext.runId, output, Date.now() - this.runContext.startedAt).payload
    )
    return this.finalizeRun('completed')
  }

  /**
   * Fail the run with an error.
   */
  async failRun(error: Error | { message: string; code?: string }): Promise<FlushResult> {
    if (!this.runContext) throw new Error('No active run.')

    // exactOptionalPropertyTypes: conditionally spread optional fields
    const errPayload: { message: string; code?: string; stack?: string } = {
      message: error.message,
      ...(error instanceof Error && error.stack !== undefined && { stack: error.stack }),
      ...(!('stack' in error) && 'code' in error && error.code !== undefined && { code: error.code }),
    }

    this.recordEvent(
      'run.failed',
      Events.runFailed(this.runContext.runId, errPayload, Date.now() - this.runContext.startedAt).payload
    )
    return this.finalizeRun('failed')
  }

  /**
   * Flush all buffered events to the server.
   */
  /**
   * Flush buffered events to the server. Flushes are serialized: a call waits for
   * any in-flight flush to finish before it splices the buffer, so overlapping
   * flushes can never reorder events or double-send a batch.
   */
  flush(): Promise<FlushResult> {
    const run = this.flushChain.then(() => this.flushOnce())
    // Keep the chain alive and unrejected regardless of this flush's outcome.
    this.flushChain = run.catch(() => {})
    return run
  }

  private async flushOnce(): Promise<FlushResult> {
    if (this.eventBuffer.length === 0) {
      return { success: true, eventsSubmitted: 0, errors: [], droppedEvents: this.droppedEventCount }
    }

    const batch = this.eventBuffer.splice(0)
    const result = await this.transport.sendEvents(batch, { apiKey: this.config.apiKey })

    if (result.success) {
      return { success: true, eventsSubmitted: batch.length, errors: [], droppedEvents: this.droppedEventCount }
    }

    // DURABILITY: the send failed, so the batch is NOT persisted. Return it to the
    // FRONT of the buffer (ahead of any events appended during the await) so a
    // later flush — or finalizeRun's flush — retries it instead of dropping it.
    // Because flushes are serialized, no other flush spliced concurrently, so the
    // buffer stays in ascending sequence order. Losing terminal
    // (run.completed/run.failed) events is the worst failure mode for a flight
    // recorder; never discard on failure.
    this.eventBuffer.unshift(...batch)

    return {
      success: false,
      eventsSubmitted: 0,
      errors: [{ eventIndex: -1, error: result.error, retryable: result.retryable }],
      droppedEvents: this.droppedEventCount,
    }
  }

  get activeRun(): RunContext | null {
    return this.runContext
  }

  private async finalizeRun(status: RunStatus): Promise<FlushResult> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const runId = this.runContext!.runId

    // Drain the buffer with bounded retries. The terminal (run.completed/failed)
    // event is in this buffer; if the final flush fails we must NOT silently give
    // up — that strands the terminal event. Retry a few times, then, if still
    // failing, re-arm the background flush timer and keep the run active so later
    // flushes continue retrying instead of losing the telemetry.
    const maxFinalizeAttempts = 3
    let result: FlushResult = { success: true, eventsSubmitted: 0, errors: [], droppedEvents: this.droppedEventCount }
    for (let attempt = 0; attempt < maxFinalizeAttempts; attempt++) {
      result = await this.flush()
      if (result.success || this.eventBuffer.length === 0) break
    }

    // Transition the run status regardless (the run IS logically finished); status
    // and event delivery are independent concerns. A failed transition must NOT be
    // swallowed — otherwise the run is stuck "running" forever, invisibly. Surface
    // it into the returned FlushResult.
    const statusResult = await this.transport.updateRunStatus(runId, status, Date.now(), {
      apiKey: this.config.apiKey,
    })
    if (!statusResult.success) {
      result = {
        ...result,
        success: false,
        errors: [
          ...result.errors,
          {
            eventIndex: -1,
            error: `Run status transition to "${status}" failed: ${statusResult.error}`,
            retryable: statusResult.retryable,
          },
        ],
      }
    }

    if (this.eventBuffer.length > 0) {
      // Terminal events could not be delivered yet. Keep retrying in the
      // background rather than dropping them; the caller sees success:false.
      this.scheduleFlush()
      return result
    }

    this.runContext = null
    return result
  }

  /**
   * Gracefully stop the recorder: cancel the flush timer, flush anything buffered,
   * and remove any installed process handlers. Safe to call multiple times and
   * safe to call with no active run. Call this before your process exits to
   * guarantee buffered events are delivered.
   */
  async shutdown(): Promise<FlushResult> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const result = await this.flush()
    this.removeProcessHandlers()
    return result
  }

  /**
   * Mark the active run failed (if any) and flush. Used by the fatal-error handler
   * so a crash still records a terminal run.failed event instead of leaving the
   * run dangling as "running" forever.
   */
  private async crashRun(err: unknown): Promise<void> {
    try {
      if (this.runContext) {
        const message = err instanceof Error ? err.message : String(err)
        this.recordEvent(
          'run.failed',
          Events.runFailed(this.runContext.runId, { message }, Date.now() - this.runContext.startedAt).payload
        )
        await this.finalizeRun('failed')
      } else {
        await this.shutdown()
      }
    } catch {
      // Best effort — the process is already dying.
    }
  }

  private installProcessHandlers(): void {
    const proc = getNodeProcess()
    if (this.processHandlersInstalled || !proc) return
    // Deliberately NOT registering SIGINT/SIGTERM: adding listeners there would
    // suppress Node's default termination and hijack the host's signal handling.
    // We only observe the two events that let us flush without seizing control.
    proc.on('beforeExit', this.onBeforeExit)
    proc.on('uncaughtException', this.onUncaught)
    this.processHandlersInstalled = true
  }

  private removeProcessHandlers(): void {
    const proc = getNodeProcess()
    if (!this.processHandlersInstalled || !proc) return
    proc.off('beforeExit', this.onBeforeExit)
    proc.off('uncaughtException', this.onUncaught)
    this.processHandlersInstalled = false
  }

  private scheduleFlush(): void {
    const interval = this.config.options?.flushIntervalMs ?? 1000
    this.flushTimer = setTimeout(() => {
      // Guard the fire-and-forget flush: a throwing custom Transport must not
      // surface as an unhandled rejection in the host process.
      void this.flush().catch(() => {})
      this.scheduleFlush()
    }, interval)
    // Do not keep the Node event loop alive on the recurring flush timer. Without
    // this, a caller who forgets endRun() hangs the process (and CI jobs) forever.
    // unref() is a no-op in environments where the timer lacks it (e.g. browsers).
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null && 'unref' in this.flushTimer) {
      (this.flushTimer as { unref: () => void }).unref()
    }
  }
}
