import { NON_RETRYABLE_RUN_ERROR_CODES } from './api-errors.js'
import { Events, buildEvent } from './events.js'
import { HttpTransport, createRetryStrategy, type Transport } from './transport.js'
import { SDK_VERSION } from './version.js'

import type {
  RecorderConfig,
  RunContext,
  RecordEventOptions,
  FlushResult,
  FlushError,
  EventSpool,
  StoredEvent,
  DropReason,
  TransportResponse,
} from './types.js'
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

/** Terminal event types — recording one seals the run's event stream. */
const TERMINAL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
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

/** Throw a TypeError unless `value` is undefined or an integer-ish number >= 1. */
function assertAtLeastOne(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (typeof value !== 'number' || Number.isNaN(value) || value < 1) {
    throw new TypeError(`RecorderOptions.${name} must be >= 1 (got ${String(value)})`)
  }
}

/** Group events by runId, preserving first-appearance order of runs and event order within each run. */
function groupByRun(events: ReturnType<typeof buildEvent>[]): Map<string, ReturnType<typeof buildEvent>[]> {
  const groups = new Map<string, ReturnType<typeof buildEvent>[]>()
  for (const ev of events) {
    const group = groups.get(ev.runId)
    if (group) group.push(ev)
    else groups.set(ev.runId, [ev])
  }
  return groups
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

  /** Cumulative count of events dropped (overflow or permanent server rejection). */
  private droppedEventCount = 0

  /**
   * True once a terminal event (run.completed/failed/cancelled) has been
   * buffered for the CURRENT run. Recording after that point is a caller bug —
   * the server rejects events after the terminal one, which would poison the
   * whole batch — so recordEvent throws instead. Reset by startRun.
   */
  private terminalBuffered = false

  /**
   * Status-transition intents that could not be delivered (and are also
   * persisted to the spool when one is configured). Kept in memory so spool
   * resyncs (clear + re-append of unacknowledged entries) never wipe a pending
   * intent, and so recover() in the same process can retire them.
   */
  private pendingStatusIntents: (StoredEvent & { kind: 'status' })[] = []

  /**
   * Best-effort mirror of how many entries the spool currently holds, used to
   * enforce `maxSpoolEntries` without re-reading the spool on every append.
   * Kept in sync by the (serialized) spool operations; initialized from
   * `peek()` by recover().
   */
  private spoolEntryCount = 0

  // Serializes spool I/O so append/clear operations apply in program order even
  // though they are launched fire-and-forget. Without this, a recordEvent
  // append racing a post-flush resync could duplicate or lose spool entries.
  private spoolChain: Promise<void> = Promise.resolve()

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

  /**
   * Create a Recorder.
   *
   * @param config - endpoint/apiKey/agentId plus optional tuning `options`.
   * @param transport - optional custom Transport (defaults to HttpTransport).
   * @throws TypeError if any numeric option is present but < 1
   *   (`maxBatchSize`, `maxBufferSize`, `maxSpoolEntries`, `flushIntervalMs`).
   */
  constructor(config: RecorderConfig, transport?: Transport) {
    assertAtLeastOne('maxBatchSize', config.options?.maxBatchSize)
    assertAtLeastOne('maxBufferSize', config.options?.maxBufferSize)
    assertAtLeastOne('maxSpoolEntries', config.options?.maxSpoolEntries)
    assertAtLeastOne('flushIntervalMs', config.options?.flushIntervalMs)

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
        ...(config.options?.allowInsecureEndpoint !== undefined && {
          allowInsecureEndpoint: config.options.allowInsecureEndpoint,
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
        sdkVersion: SDK_VERSION,
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
    this.terminalBuffered = false
    this.recordEvent('run.started', Events.runStarted(this.runContext.runId, input, runConfig).payload)

    this.scheduleFlush()
    return this.runContext
  }

  /**
   * Record an event in the current run.
   *
   * @throws Error if no run is active, or if a terminal event
   *   (run.completed/run.failed/run.cancelled) has already been recorded for
   *   the current run — the server rejects events after the terminal one, so
   *   accepting more would poison the pending batch.
   */
  recordEvent(
    type: EventType,
    payload: EventPayload,
    options?: RecordEventOptions
  ): void {
    if (!this.runContext) {
      throw new Error('No active run. Call startRun() first.')
    }
    if (this.terminalBuffered) {
      throw new Error(
        `Cannot record "${type}": a terminal event has already been recorded for run "${this.runContext.runId}". ` +
          'Events after the terminal event are rejected by the server and would poison the pending batch.'
      )
    }

    const seq = options?.sequenceNumber ?? ++this.sequenceCounter

    // exactOptionalPropertyTypes: conditionally spread optional fields
    const eventOptions = {
      ...(options?.parentEventId !== undefined && { parentEventId: options.parentEventId }),
      ...(options?.timestamp !== undefined && { timestamp: options.timestamp }),
    }

    const event = buildEvent(
      this.runContext.runId,
      '', // orgId resolved server-side from API key
      type,
      payload,
      seq,
      eventOptions
    )
    this.eventBuffer.push(event)
    if (TERMINAL_EVENT_TYPES.has(type)) {
      this.terminalBuffered = true
    }

    // Write-ahead: persist to the spool (if configured) before delivery is
    // attempted. Best-effort and non-blocking — spool failure never breaks
    // recording; it is surfaced via onSpoolError.
    this.spoolAppend([{ kind: 'event', event }])

    this.enforceBufferLimit()

    const maxBatch = this.config.options?.maxBatchSize ?? 100
    if (this.eventBuffer.length >= maxBatch) {
      // Fire-and-forget: a throwing custom Transport must not surface as an
      // unhandled rejection in the host. Failures are routed to onFlushError.
      this.backgroundFlush()
    }
  }

  /**
   * Enforce the configured `maxBufferSize`. When the buffer exceeds the cap,
   * drop the OLDEST non-protected events (protected = run.started and the
   * terminal events) until the buffer is back within bounds. Terminal telemetry
   * is the worst thing to lose, so it is never dropped. Dropped events are
   * counted and surfaced via `FlushResult.droppedEvents`, and removed from the
   * spool too (via a resync) so spool and buffer stay consistent.
   */
  private enforceBufferLimit(): void {
    const max = this.config.options?.maxBufferSize ?? 10_000
    if (this.eventBuffer.length <= max) return

    let toDrop = this.eventBuffer.length - max
    let droppedNow = 0
    const kept: ReturnType<typeof buildEvent>[] = []
    for (const ev of this.eventBuffer) {
      if (toDrop > 0 && !PROTECTED_EVENT_TYPES.has(ev.type)) {
        toDrop--
        droppedNow++
        continue
      }
      kept.push(ev)
    }
    this.eventBuffer = kept

    if (droppedNow > 0) {
      this.notifyDrop(droppedNow, 'buffer_overflow')
      // Keep the spool consistent with the buffer: without this, the dropped
      // events would linger in the spool and be re-sent (or silently discarded
      // by the next post-flush resync) — inconsistent and unobservable.
      this.resyncSpool()
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
   * Flush buffered events to the server. Flushes are serialized: a call waits for
   * any in-flight flush to finish before it splices the buffer, so overlapping
   * flushes can never reorder events or double-send a batch.
   *
   * Events are sent in PER-RUN batches (grouped by runId), so one run whose
   * batch the server cannot accept never blocks delivery for other runs.
   * Per-run failures are surfaced individually in `FlushResult.errors`;
   * successfully delivered runs' events are acknowledged (and removed from the
   * spool) independently.
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
    const groups = groupByRun(batch)

    const errors: FlushError[] = []
    const retained: ReturnType<typeof buildEvent>[] = []
    let submitted = 0

    for (const [runId, events] of groups) {
      let result: TransportResponse
      try {
        result = await this.transport.sendEvents(events, { apiKey: this.config.apiKey })
      } catch (err) {
        // Transport implementations must not throw, but a buggy custom
        // Transport that does must land in FlushResult.errors — never reject
        // flush() into customer agent code. Retain the events for retry.
        result = {
          success: false,
          retryable: true,
          error: `Transport threw: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      if (result.success) {
        submitted += events.length
        this.debugLog(`flush ok: ${events.length} event(s) submitted for run "${runId}"`)
        continue
      }

      if (result.code !== undefined && NON_RETRYABLE_RUN_ERROR_CODES.has(result.code)) {
        // PERMANENT rejection for this run (run already terminal server-side, or
        // sequence range already claimed). Retrying can never succeed, and
        // retaining these events would poison every future flush and strand all
        // other runs. Drop them (observably) and move on.
        this.notifyDrop(events.length, 'rejected_by_server')
        errors.push({
          eventIndex: -1,
          error: `Run "${runId}": batch permanently rejected by server (${result.code}): ${result.error}. ${events.length} event(s) dropped.`,
          retryable: false,
        })
        this.debugLog(`flush: run "${runId}" permanently rejected (${result.code}), ${events.length} event(s) dropped`)
        continue
      }

      // DURABILITY: the send failed transiently, so this run's events are NOT
      // persisted. Retain them for a later flush — losing terminal
      // (run.completed/run.failed) events is the worst failure mode for a
      // flight recorder; never discard on transient failure.
      this.debugLog(`flush failed for run "${runId}" (${events.length} event(s) retained): ${result.error}`)
      errors.push({
        eventIndex: -1,
        error: `Run "${runId}": ${result.error}`,
        retryable: result.retryable,
      })
      retained.push(...events)
    }

    // Return retained events to the FRONT of the buffer (ahead of any events
    // appended during the awaits), preserving their original relative order —
    // `retained` was filled in batch order, so per-run sequences stay ascending.
    if (retained.length > 0) {
      this.eventBuffer.unshift(...retained)
    }

    // Spool resync: acknowledged AND permanently-rejected events are removed;
    // whatever is still unacknowledged (the current buffer) plus any pending
    // status intents are rewritten. The snapshot is taken synchronously here;
    // events recorded later queue their own appends AFTER this resync on the
    // spool chain, so nothing is duplicated or lost.
    this.resyncSpool()

    return {
      success: errors.length === 0,
      eventsSubmitted: submitted,
      errors,
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
    // failing, re-arm the background flush timer and keep retrying in the
    // background instead of losing the telemetry.
    const maxFinalizeAttempts = 3
    let result: FlushResult = { success: true, eventsSubmitted: 0, errors: [], droppedEvents: this.droppedEventCount }
    for (let attempt = 0; attempt < maxFinalizeAttempts; attempt++) {
      result = await this.flush()
      if (result.success || this.eventBuffer.length === 0) break
    }

    const runHasUndelivered = this.eventBuffer.some((e) => e.runId === runId)
    const endedAt = Date.now()

    if (runHasUndelivered) {
      // Do NOT transition the run status while this run's terminal event is
      // still undelivered. The server reconciles run status from the terminal
      // event when it arrives; patching the status first would close the run
      // server-side and make the pending events permanently rejectable
      // (RUN_NOT_ACTIVE) — the stranded-run poison pill. Defer the transition
      // to event delivery (background retries / recover()).
      result = { ...result, statusTransitionDeferred: true }
      this.debugLog(
        `finalize: run "${runId}" status transition deferred — terminal event undelivered; server will reconcile on event arrival`
      )
    } else {
      // All of this run's events are delivered — transition the status. A failed
      // transition must NOT be swallowed, otherwise the run is stuck "running"
      // forever, invisibly. Surface it into the returned FlushResult.
      const statusResult = await this.transport.updateRunStatus(runId, status, endedAt, {
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
        // Persist the status-transition intent so recover() (in this or a later
        // process) can complete the transition. Without a spool the intent is
        // retried by nothing — the run stays "running" server-side until a human
        // or a reaper intervenes; the returned error is the only signal.
        const intent: StoredEvent & { kind: 'status' } = { kind: 'status', runId, status, endedAt }
        this.pendingStatusIntents.push(intent)
        if (this.config.options?.spool) {
          this.spoolAppend([intent])
        }
      }
    }

    // Keep retrying in the background whenever ANY events remain buffered —
    // including a previous stranded run's — but only report THIS run's terminal
    // event as undelivered when it actually is.
    if (this.eventBuffer.length > 0) {
      this.scheduleFlush()
    }
    const undelivered = this.eventBuffer.filter((e) => e.runId === runId).length
    if (undelivered > 0) {
      // The terminal event (and possibly earlier events) could NOT be delivered
      // after all attempts. Surface an explicit error so the caller knows the
      // run's telemetry is incomplete, keep retrying in the background
      // best-effort, and — critically — do NOT wedge the recorder: runContext
      // is cleared below so a new run can start.
      const spooled = this.config.options?.spool !== undefined
      result = {
        ...result,
        success: false,
        errors: [
          ...result.errors,
          {
            eventIndex: -1,
            error:
              `Terminal event for run "${runId}" is UNDELIVERED after ${maxFinalizeAttempts} flush attempts ` +
              `(${undelivered} event(s) still buffered). The run status transition is deferred until the ` +
              'terminal event is delivered (the server reconciles status from it). ' +
              (spooled
                ? 'The events are persisted in the spool — call recover() (e.g. on next startup) to re-send them.'
                : 'No spool is configured: the events remain in memory and will be retried in the background, but are LOST if the process exits.'),
            retryable: true,
          },
        ],
      }
      this.scheduleFlush()
    }

    // Ensure pending spool writes (write-ahead events + any status intent) have
    // settled before we return, so a caller that exits immediately after
    // endRun()/failRun() leaves a complete spool behind. The chain never rejects.
    if (this.config.options?.spool) {
      await this.spoolChain
    }

    // Always release the recorder — a run that failed to finalize cleanly must
    // not block future runs. Undelivered events stay in the buffer/spool and
    // carry their own runId, so background retries and recover() still deliver
    // them after a new run starts.
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

  /**
   * Re-send everything a previous process (or a failed finalize) left
   * undelivered in the configured spool: spooled events go through
   * `transport.sendEvents` (batched PER RUN, so one undeliverable run cannot
   * block the others), spooled status-transition intents through
   * `transport.updateRunStatus`.
   *
   * Drain semantics are peek → send → ack: entries are READ without being
   * removed, delivery is attempted, and only then is the spool rewritten with
   * the entries that could not be delivered. A crash mid-recovery therefore
   * re-sends duplicates (deduped server-side by run + sequenceNumber), never
   * loses data. Runs the server rejects permanently (`RUN_NOT_ACTIVE` /
   * `SEQUENCE_CONFLICT`) are dropped from the spool and reported via
   * `onDrop(count, 'rejected_by_server')`.
   *
   * Call this on startup, BEFORE starting new runs, when using a spool. A
   * no-op returning `success: true` when no spool is configured or the spool
   * is empty. Never throws; spool/transport failures are reported in the
   * returned `FlushResult.errors`.
   */
  async recover(): Promise<FlushResult> {
    const spool = this.config.options?.spool
    if (!spool) {
      return { success: true, eventsSubmitted: 0, errors: [], droppedEvents: this.droppedEventCount }
    }

    let entries: StoredEvent[]
    try {
      // Let any pending write-ahead appends settle first (the chain never
      // rejects), then peek. Call recover() before starting new runs so no
      // concurrent appends race the peek → rewrite window.
      await this.spoolChain
      entries = await spool.peek()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.notifySpoolError(`spool peek failed during recover: ${message}`)
      return {
        success: false,
        eventsSubmitted: 0,
        errors: [{ eventIndex: -1, error: `Spool peek failed: ${message}`, retryable: true }],
        droppedEvents: this.droppedEventCount,
      }
    }

    this.spoolEntryCount = entries.length
    if (entries.length === 0) {
      return { success: true, eventsSubmitted: 0, errors: [], droppedEvents: this.droppedEventCount }
    }
    this.debugLog(`recover: recovering ${entries.length} spooled entr(y/ies)`)

    const errors: FlushResult['errors'] = []
    /** Entries that must survive in the spool for a later recover(). */
    const kept: StoredEvent[] = []
    let submitted = 0

    const events = entries.filter((e): e is StoredEvent & { kind: 'event' } => e.kind === 'event')
    const groups = new Map<string, (StoredEvent & { kind: 'event' })[]>()
    for (const entry of events) {
      const group = groups.get(entry.event.runId)
      if (group) group.push(entry)
      else groups.set(entry.event.runId, [entry])
    }

    for (const [runId, runEntries] of groups) {
      let res: TransportResponse
      try {
        res = await this.transport.sendEvents(
          runEntries.map((e) => e.event),
          { apiKey: this.config.apiKey }
        )
      } catch (err) {
        res = {
          success: false,
          retryable: true,
          error: `Transport threw: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (res.success) {
        submitted += runEntries.length
        continue
      }
      if (res.code !== undefined && NON_RETRYABLE_RUN_ERROR_CODES.has(res.code)) {
        // Permanently undeliverable — drop from the spool instead of retrying
        // forever on every future recover().
        this.notifyDrop(runEntries.length, 'rejected_by_server')
        errors.push({
          eventIndex: -1,
          error: `Recovery: run "${runId}" permanently rejected by server (${res.code}): ${res.error}. ${runEntries.length} spooled event(s) dropped.`,
          retryable: false,
        })
        continue
      }
      errors.push({
        eventIndex: -1,
        error: `Recovery send failed for run "${runId}": ${res.error}`,
        retryable: res.retryable,
      })
      kept.push(...runEntries)
    }

    for (const intent of entries) {
      if (intent.kind !== 'status') continue
      const res = await this.transport.updateRunStatus(intent.runId, intent.status, intent.endedAt, {
        apiKey: this.config.apiKey,
      })
      if (res.success || (!res.success && res.code !== undefined && NON_RETRYABLE_RUN_ERROR_CODES.has(res.code))) {
        // Delivered — or the run is already terminal server-side, which means
        // the transition is moot. Either way the intent is retired.
        this.pendingStatusIntents = this.pendingStatusIntents.filter(
          (p) => !(p.runId === intent.runId && p.status === intent.status)
        )
        continue
      }
      errors.push({
        eventIndex: -1,
        error: `Recovery status transition for run "${intent.runId}" failed: ${res.error}`,
        retryable: res.retryable,
      })
      kept.push(intent)
    }

    // Ack: rewrite the spool with only the entries that could not be delivered.
    // This runs AFTER the sends — a crash before this point leaves the spool
    // intact (duplicates on next recover, never losses).
    this.spoolOp(async (s) => {
      await s.clear()
      if (kept.length > 0) await s.append(kept)
      this.spoolEntryCount = kept.length
    })
    await this.spoolChain

    return {
      success: errors.length === 0,
      eventsSubmitted: submitted,
      errors,
      droppedEvents: this.droppedEventCount,
    }
  }

  /**
   * Launch a fire-and-forget flush whose failure is routed to `onFlushError`
   * (and debug logging) instead of being silently discarded. Used by the flush
   * timer and the maxBatchSize trigger, whose FlushResults have no caller.
   */
  private backgroundFlush(): void {
    void this.flush()
      .then((result) => {
        if (!result.success) {
          this.notifyFlushError(result.errors.map((e) => e.error).join('; '))
        }
      })
      .catch((err) => {
        this.notifyFlushError(err instanceof Error ? err.message : String(err))
      })
  }

  private notifyFlushError(error: string): void {
    this.debugLog(`background flush failed: ${error}`)
    try {
      this.config.options?.onFlushError?.(error)
    } catch {
      // Consumer callback must never crash the recorder.
    }
  }

  private notifySpoolError(error: string): void {
    this.debugLog(`spool error: ${error}`)
    try {
      this.config.options?.onSpoolError?.(error)
    } catch {
      // Consumer callback must never crash the recorder.
    }
  }

  /** Count dropped events and fire the onDrop callback (never throws). */
  private notifyDrop(count: number, reason: DropReason): void {
    this.droppedEventCount += count
    this.debugLog(`dropped ${count} event(s) (${reason}; cumulative: ${this.droppedEventCount})`)
    try {
      this.config.options?.onDrop?.(count, reason)
    } catch {
      // Consumer callback must never crash the recorder.
    }
  }

  /**
   * Enqueue a best-effort spool operation on the serialization chain. No-op
   * when no spool is configured (zero cost). Failures never propagate — they
   * are surfaced via `onSpoolError`.
   */
  private spoolOp(op: (spool: EventSpool) => Promise<void>): void {
    const spool = this.config.options?.spool
    if (!spool) return
    this.spoolChain = this.spoolChain
      .then(() => op(spool))
      .catch((err) => {
        this.notifySpoolError(err instanceof Error ? err.message : String(err))
      })
  }

  /**
   * Append entries to the spool and enforce `maxSpoolEntries`. On overflow the
   * OLDEST non-lifecycle spooled events are dropped — from the spool AND from
   * the in-memory buffer, so the two stay consistent — and
   * `onDrop(count, 'spool_overflow')` fires.
   */
  private spoolAppend(entries: StoredEvent[]): void {
    if (!this.config.options?.spool) return
    const max = this.config.options?.maxSpoolEntries ?? 50_000
    this.spoolOp(async (spool) => {
      await spool.append(entries)
      this.spoolEntryCount += entries.length
      if (this.spoolEntryCount <= max) return

      // Overflow: rewrite the spool without the oldest droppable events.
      const all = await spool.peek()
      let toDrop = all.length - max
      const kept: StoredEvent[] = []
      const droppedKeys = new Set<string>()
      for (const entry of all) {
        if (toDrop > 0 && entry.kind === 'event' && !PROTECTED_EVENT_TYPES.has(entry.event.type)) {
          toDrop--
          droppedKeys.add(`${entry.event.runId}#${entry.event.sequenceNumber}`)
          continue
        }
        kept.push(entry)
      }
      await spool.clear()
      if (kept.length > 0) await spool.append(kept)
      this.spoolEntryCount = kept.length

      if (droppedKeys.size > 0) {
        // Mirror the drop into the in-memory buffer so the same events are not
        // re-sent from memory after being evicted from the spool.
        this.eventBuffer = this.eventBuffer.filter(
          (ev) => !droppedKeys.has(`${ev.runId}#${ev.sequenceNumber}`)
        )
        this.notifyDrop(droppedKeys.size, 'spool_overflow')
      }
    })
  }

  /**
   * Rewrite the spool so it holds exactly the unacknowledged state: the
   * current in-memory buffer plus any pending status-transition intents.
   * Used after a flush (acked/rejected events removed) and after buffer
   * overflow drops (dropped events removed).
   */
  private resyncSpool(): void {
    if (!this.config.options?.spool) return
    const remaining: StoredEvent[] = [
      ...this.eventBuffer.map((event): StoredEvent => ({ kind: 'event', event })),
      ...this.pendingStatusIntents,
    ]
    this.spoolOp(async (spool) => {
      await spool.clear()
      if (remaining.length > 0) await spool.append(remaining)
      this.spoolEntryCount = remaining.length
    })
  }

  /** Log a diagnostic line when `options.debug` is enabled. */
  private debugLog(message: string): void {
    if (this.config.options?.debug) {
      console.log(`[afr-sdk] ${message}`)
    }
  }

  private scheduleFlush(): void {
    const interval = this.config.options?.flushIntervalMs ?? 1000
    this.flushTimer = setTimeout(() => {
      // Guard the fire-and-forget flush: a throwing custom Transport must not
      // surface as an unhandled rejection in the host process. Failures are
      // routed to onFlushError instead of being silently discarded.
      this.backgroundFlush()
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
