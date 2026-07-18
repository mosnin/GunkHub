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
   * Return ALL spooled entries, in append order, WITHOUT removing them.
   * `Recorder.recover()` peeks, attempts delivery, and only then rewrites the
   * spool with the entries that were NOT acknowledged (peek → send → ack). A
   * crash mid-recovery therefore re-sends already-delivered entries on the
   * next recover — duplicates (deduped server-side by run + sequenceNumber),
   * never losses.
   */
  peek(): Promise<StoredEvent[]>
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

/**
 * Why events were dropped, as reported to `RecorderOptions.onDrop`:
 * - `'buffer_overflow'` — the in-memory buffer exceeded `maxBufferSize`.
 * - `'spool_overflow'` — the persistent spool exceeded `maxSpoolEntries`.
 * - `'rejected_by_server'` — the server permanently rejected a run's batch
 *   (`RUN_NOT_ACTIVE` / `SEQUENCE_CONFLICT`); retrying can never succeed.
 */
export type DropReason = 'buffer_overflow' | 'spool_overflow' | 'rejected_by_server'

export interface RecorderOptions {
  /** Flush events after this many ms of inactivity. Must be >= 1. Default: 1000 */
  flushIntervalMs?: number
  /** Max events to buffer before force-flush. Must be >= 1. Default: 100 */
  maxBatchSize?: number
  /**
   * Hard cap on the number of events retained in the in-memory buffer. When a
   * degraded server can't accept flushes, the buffer would otherwise grow until
   * the host process runs out of memory. On overflow the recorder DROPS the
   * OLDEST non-terminal events, always preserving lifecycle-critical events
   * (run.started and the terminal run.completed/run.failed/run.cancelled). The
   * number of dropped events is surfaced via `FlushResult.droppedEvents`.
   * Must be >= 1. Default: 10000.
   */
  maxBufferSize?: number
  /**
   * Hard cap on the number of entries retained in the persistent spool (when
   * `spool` is configured). On overflow the recorder drops the OLDEST
   * non-lifecycle spooled events (from both the spool and the in-memory
   * buffer, so the two stay consistent) and fires
   * `onDrop(count, 'spool_overflow')`. Must be >= 1. Default: 50000.
   */
  maxSpoolEntries?: number
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
   * Called when events are dropped. `count` is the number of events dropped
   * by this occurrence (not cumulative); `reason` is one of {@link DropReason}
   * (`'buffer_overflow'`, `'spool_overflow'`, or `'rejected_by_server'`).
   * Must not throw; exceptions are swallowed.
   */
  onDrop?: (count: number, reason: DropReason) => void
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
  /**
   * Override the auto-assigned sequence number.
   *
   * HAZARD: the server requires sequence numbers within a run to be
   * contiguous, ascending, and non-repeating, starting at 1. The recorder's
   * internal counter does NOT advance when you pass an override, so a value
   * ahead of (or behind) the auto counter makes the whole batch permanently
   * undeliverable (`SEQUENCE_CONFLICT`) and the affected run's events will be
   * DROPPED. Only use this if you assign EVERY sequence number for the run
   * yourself. Almost all callers should omit it.
   */
  sequenceNumber?: number
  parentEventId?: string
  timestamp?: number
}

export interface FlushResult {
  success: boolean
  eventsSubmitted: number
  errors: FlushError[]
  /**
   * Cumulative count of events dropped so far (buffer overflow, spool
   * overflow, or permanent server rejection — see {@link DropReason}). Zero in
   * the normal case. A non-zero value means telemetry was lost.
   */
  droppedEvents?: number
  /**
   * Set by `endRun()`/`failRun()` when the run-status transition was NOT
   * issued because the terminal event is still undelivered (buffered/spooled).
   * The server reconciles the run's status from the terminal event when it
   * arrives, so patching the status first would prematurely close the run and
   * make the pending events permanently rejectable (`RUN_NOT_ACTIVE`). The
   * transition is deferred to event delivery instead.
   */
  statusTransitionDeferred?: boolean
}

export interface FlushError {
  eventIndex: number
  error: string
  retryable: boolean
}

export type TransportResponse = {
  success: true
  /**
   * Server-assigned event IDs, in submission order, when the response body
   * provides them (`{ eventIds: [...] }`). Empty for responses that don't
   * (e.g. status updates).
   */
  eventIds: string[]
} | {
  success: false
  error: string
  retryable: boolean
  /**
   * Stable machine-readable error code parsed from the server's JSON error
   * body (`{ code, message }`) when present — e.g. `RUN_NOT_ACTIVE`,
   * `SEQUENCE_CONFLICT`, `RATE_LIMITED`. The recorder uses it to distinguish
   * permanently-rejected batches from transient failures.
   */
  code?: string
}

// Ensure imported types are used (re-exported via index)
export type { EventType, EventPayload, RunStatus }
