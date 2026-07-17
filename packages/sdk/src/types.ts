import type { EventType, EventPayload, RunStatus } from '@agent-flight-recorder/contracts'

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
  /** Whether to log debug info. Default: false */
  debug?: boolean
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
