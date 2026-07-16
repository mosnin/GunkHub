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
  /** Max retry attempts for failed sends. Default: 3 */
  maxRetries?: number
  /** Initial retry backoff in ms. Default: 500 */
  retryBackoffMs?: number
  /** Whether to log debug info. Default: false */
  debug?: boolean
  /**
   * Install process handlers (beforeExit, SIGTERM, SIGINT, uncaughtException,
   * unhandledRejection) that best-effort flush buffered events and mark the active
   * run failed if the process is dying. For a flight recorder, losing the crash
   * telemetry is the worst failure mode. Node-only; a no-op where `process` is
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
