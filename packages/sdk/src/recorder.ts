import type { RunStatus, EventType, EventPayload } from '@agent-flight-recorder/contracts'
import type { RecorderConfig, RunContext, RecordEventOptions, FlushResult } from './types.js'
import { HttpTransport, type Transport } from './transport.js'
import { Events, buildEvent } from './events.js'

export class Recorder {
  private readonly config: RecorderConfig
  private readonly transport: Transport
  private runContext: RunContext | null = null
  private eventBuffer: ReturnType<typeof buildEvent>[] = []
  private sequenceCounter = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(config: RecorderConfig, transport?: Transport) {
    this.config = config
    this.transport = transport ?? new HttpTransport(config.endpoint)
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

    const maxBatch = this.config.options?.maxBatchSize ?? 100
    if (this.eventBuffer.length >= maxBatch) {
      void this.flush()
    }
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
  async flush(): Promise<FlushResult> {
    if (this.eventBuffer.length === 0) return { success: true, eventsSubmitted: 0, errors: [] }

    const batch = this.eventBuffer.splice(0)
    const result = await this.transport.sendEvents(batch, { apiKey: this.config.apiKey })

    if (result.success) {
      return { success: true, eventsSubmitted: batch.length, errors: [] }
    }

    return {
      success: false,
      eventsSubmitted: 0,
      errors: [{ eventIndex: -1, error: result.error, retryable: result.retryable }],
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
    const result = await this.flush()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await this.transport.updateRunStatus(this.runContext!.runId, status, Date.now(), { apiKey: this.config.apiKey })
    this.runContext = null
    return result
  }

  private scheduleFlush(): void {
    const interval = this.config.options?.flushIntervalMs ?? 1000
    this.flushTimer = setTimeout(() => {
      void this.flush()
      this.scheduleFlush()
    }, interval)
  }
}
