import type { EventType, EventPayload, RunStatus, CreateEventRequest } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Durability: persistent event spool
// ---------------------------------------------------------------------------

/**
 * A single durably-spooled entry. The spool is a write-ahead log of everything
 * the recorder has accepted but the server has not yet acknowledged, so an
 * entry is either a recorded event or a pending run-status transition (the
 * "intent" persisted when a terminal status update could not be delivered).
 */
export type StoredEvent =
  | {
      /** A recorded event awaiting server acknowledgement. */
      kind: 'event'
      event: CreateEventRequest
    }
  | {
      /** A run status transition that could not be delivered. */
      kind: 'status'
      runId: string
      status: RunStatus
      endedAt: number
    }

/**
 * Pluggable persistent spool giving the recorder at-least-once delivery.
 *
 * When configured via `RecorderOptions.spool`, every recorded event is
 * appended (write-ahead) before delivery is attempted, a successful flush
 * removes the acknowledged events, and `Recorder.recover()` drains the spool
 * on startup to re-send anything a previous process failed to deliver.
 *
 * Implementations must be safe against a crash between operations: entries
 * appended but never cleared are re-sent on recovery, so delivery becomes
 * at-least-once (duplicates are deduped server-side by run + sequenceNumber).
 * All methods are async and must reject (not throw synchronously) on failure;
 * the recorder routes failures to `RecorderOptions.onSpoolError` and never
 * lets them crash the host.
 */
export interface EventSpool {
  /** Append entries to the spool (durable before resolve). */
  append(entries: StoredEvent[]): Promise<void>
  /**
   * Return ALL spooled entries, in append order, and remove them from the
   * spool. The caller (Recorder.recover) re-appends whatever it fails to
   * deliver, so a crash mid-recovery loses at most what drain() handed out
   * after it was already re-sent — duplicates, not losses.
   */
  drain(): Promise<StoredEvent[]>
  /** Remove all entries from the spool. */
  clear(): Promise<void>
}

export interface RecorderConfig {
  /** Base URL of the Agent Flight Recorder ingestion endpoint */
  endpoint: string
  /** Organization API key for authentication */
  apiKey: string
  /** Agent ID this recorder is attached to */
  agentId: string
  /** Optional agent version */
  agentVersionId?: string
  /** SDK behavior options */
  options?: RecorderOptions
}

export interface RecorderOptions {
  /** Flush events after this many ms of inactivity. Default: 1000 */
  flushIntervalMs?: number
  /** Max events to buffer before force-flush. Default: 100 */
  maxBatchSize?: number
  /**
   * Hard cap on the number of events retained in the in-memory buffer. When a
   * degraded server can't accept flushes, the buffer would otherwise grow until
   * the host process runs out of memory. On overflow the recorder DROPS the
   * OLDEST non-terminal events, always preserving lifecycle-critical events
   * (run.started and the terminal run.completed/run.failed/run.cancelled). The
   * number of dropped events is surfaced via `FlushResult.droppedEvents`.
   * Default: 10000.
   */
  maxBufferSize?: number
  /** Max retry attempts for failed sends. Default: 3 */
  maxRetries?: number
  /** Initial retry backoff in ms. Default: 500 */
  retryBackoffMs?: number
  /**
   * Log SDK diagnostics (flush results, buffer drops, spool errors) to the
   * console with an `[afr-sdk]` prefix. Default: false.
   */
  debug?: boolean
  /**
   * Persistent write-ahead spool for at-least-once delivery. When set, every
   * recorded event is appended to the spool before delivery is attempted and
   * removed once the server acknowledges it, so events survive a process
   * crash; call `recover()` on startup to re-send anything left behind by a
   * previous process. When unset (the default) the recorder is purely
   * in-memory and delivery is at-most-once. See `FileSpool` for the shipped
   * Node implementation.
   */
  spool?: EventSpool
  /**
   * Called when spool I/O fails (append/clear). Spool failures are best-effort
   * and never crash the host or block recording — this callback is the only
   * signal. Must not throw; exceptions are swallowed.
   */
  onSpoolError?: (error: string) => void
  /**
   * Called when events are dropped from the in-memory buffer. Currently the
   * only reason is `'buffer_overflow'` (see `maxBufferSize`). `count` is the
   * number of events dropped by this occurrence (not cumulative). Must not
   * throw; exceptions are swallowed.
   */
  onDrop?: (count: number, reason: 'buffer_overflow') => void
  /**
   * Called when a background (fire-and-forget) flush fails — the timer-driven
   * flush and the maxBatchSize-triggered flush, whose `FlushResult`s have no
   * caller to return to. Foreground `flush()`/`endRun()`/`failRun()` callers
   * get errors via the returned `FlushResult` and do NOT fire this callback.
   * Must not throw; exceptions are swallowed.
   */
  onFlushError?: (error: string) => void
  /**
   * Suppress the one-time console warning emitted when `endpoint` uses plain
   * HTTP to a non-localhost host (API key would transit in cleartext).
   * Default: false.
   */
  allowInsecureEndpoint?: boolean
  /**
   * Install best-effort process handlers so buffered events are not lost when
   * the host process winds down. As an observability library the SDK stays out
   * of the host's control flow: it registers only `beforeExit` (flush buffered
   * events) and `uncaughtException` (mark the active run failed + flush). It does
   * NOT force `process.exit`, does NOT intercept SIGINT/SIGTERM, and does NOT
   * treat an unrelated `unhandledRejection` as a run failure. On an uncaught
   * exception it sets `process.exitCode = 1` without terminating, so the host's
   * own crash semantics still apply. Node-only; a no-op where `process` is
   * unavailable. Default: false (opt-in, since it registers global handlers).
   */
  captureProcessExit?: boolean
}

export interface RunContext {
  runId: string
  agentId: string
  status: RunStatus
  startedAt: number
}

export interface RecordEventOptions {
  sequenceNumber?: number
  parentEventId?: string
  timestamp?: number
}

export interface FlushResult {
  success: boolean
  eventsSubmitted: number
  errors: FlushError[]
  /**
   * Cumulative count of events dropped from the buffer due to overflow
   * (see `RecorderOptions.maxBufferSize`). Zero in the normal case. A non-zero
   * value means telemetry was lost because the server could not keep up.
   */
  droppedEvents?: number
}

export interface FlushError {
  eventIndex: number
  error: string
  retryable: boolean
}

export type TransportResponse = {
  success: true
  eventIds: string[]
} | {
  success: false
  error: string
  retryable: boolean
}

// Ensure imported types are used (re-exported via index)
export type { EventType, EventPayload, RunStatus }
