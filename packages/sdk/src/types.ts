import type { RunStatus, EventCategory } from "@afr/contracts";

/** Configuration for the FlightRecorder instance */
export interface FlightRecorderConfig {
  /** The base URL of the AFR ingest endpoint (e.g. https://your-app.com) */
  readonly endpoint: string;
  /** API key for authentication */
  readonly apiKey: string;
  /** Default agent ID for runs started from this recorder */
  readonly agentId: string;
  /** Default project ID */
  readonly projectId: string;
  /** Optional: default agent version */
  readonly agentVersionId?: string;
  /** Max events to buffer before auto-flush (default: 50) */
  readonly batchSize?: number;
  /** Max ms to hold events before auto-flush (default: 2000) */
  readonly flushIntervalMs?: number;
  /** Retry strategy config */
  readonly retry?: RetryConfig;
  /** Optional logger (defaults to console) */
  readonly logger?: Logger;
}

export interface RetryConfig {
  /** Max retry attempts (default: 3) */
  readonly maxAttempts: number;
  /** Initial retry delay in ms (default: 500) */
  readonly initialDelayMs: number;
  /** Backoff multiplier (default: 2) */
  readonly backoffMultiplier: number;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Represents an in-progress run. Returned by FlightRecorder.startRun() */
export interface RunHandle {
  readonly runId: string;
  readonly agentId: string;
  readonly projectId: string;

  /**
   * Record an event for this run.
   * If payload is large (> 8KB when serialized), it will be flagged
   * for externalization by the server.
   */
  record(event: RecordEventInput): Promise<void>;

  /**
   * Record multiple events in a single call.
   * More efficient than calling record() in a loop.
   */
  recordBatch(events: RecordEventInput[]): Promise<void>;

  /** Mark the run as successfully completed. Flushes all buffered events. */
  complete(output?: Record<string, unknown>): Promise<void>;

  /** Mark the run as failed. Flushes all buffered events. */
  fail(error: RunFailureInput): Promise<void>;

  /** Mark the run as cancelled. Flushes all buffered events. */
  cancel(reason?: string): Promise<void>;

  /** Force-flush all buffered events without ending the run. */
  flush(): Promise<void>;
}

export interface RecordEventInput {
  /** Dot-notation type, e.g. "llm.request", "tool.call" */
  readonly type: string;
  readonly category: EventCategory;
  readonly payload?: unknown;
  readonly parentEventId?: string;
  readonly metadata?: Record<string, unknown>;
  /** Override timestamp (unix ms). Defaults to Date.now() */
  readonly timestamp?: number;
}

export interface StartRunInput {
  readonly agentId?: string;        // override FlightRecorderConfig.agentId
  readonly agentVersionId?: string;
  readonly projectId?: string;      // override FlightRecorderConfig.projectId
  readonly metadata?: Record<string, unknown>;
  readonly tags?: string[];
}

export interface RunFailureInput {
  readonly message: string;
  readonly code?: string;
  readonly errorType?: string;
}

/** Transport layer interface — pluggable, stable contract */
export interface Transport {
  /** Create a new run on the server */
  createRun(request: CreateRunTransportRequest): Promise<{ runId: string }>;
  /** Send a batch of events */
  sendEvents(request: SendEventsTransportRequest): Promise<{ accepted: number }>;
  /** Update run status */
  updateRunStatus(request: UpdateRunStatusRequest): Promise<void>;
}

export interface CreateRunTransportRequest {
  readonly agentId: string;
  readonly agentVersionId?: string;
  readonly projectId: string;
  readonly metadata: Record<string, unknown>;
  readonly tags: string[];
}

export interface SendEventsTransportRequest {
  readonly runId: string;
  readonly events: TransportEvent[];
}

export interface TransportEvent {
  readonly type: string;
  readonly category: string;
  readonly sequence: number;
  readonly timestamp: number;
  readonly payload: unknown;
  readonly parentEventId?: string;
  readonly metadata: Record<string, unknown>;
}

export interface UpdateRunStatusRequest {
  readonly runId: string;
  readonly status: RunStatus;
  readonly completedAt: number;
  readonly errorMessage?: string;
  readonly errorCode?: string;
}

/** Batching buffer interface */
export interface BatchBuffer<T> {
  add(item: T): boolean;   // returns true if buffer is now full
  drain(): T[];
  size(): number;
  clear(): void;
}
