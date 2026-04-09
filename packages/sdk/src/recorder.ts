import type {
  FlightRecorderConfig,
  Transport,
  RunHandle,
  StartRunInput,
  RecordEventInput,
  RunFailureInput,
  TransportEvent,
} from "./types.js";
import { HttpTransport } from "./transport.js";

/**
 * Simple in-memory batch buffer for events.
 * Flushes when size >= batchSize or flush() is called.
 */
class EventBatchBuffer {
  private buffer: TransportEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /** Add an event. Returns true if the buffer is now at or over capacity. */
  add(event: TransportEvent): boolean {
    this.buffer.push(event);
    return this.buffer.length >= this.maxSize;
  }

  /** Drain and return all buffered events, clearing the buffer. */
  drain(): TransportEvent[] {
    const items = [...this.buffer];
    this.buffer = [];
    return items;
  }

  size(): number {
    return this.buffer.length;
  }
}

/**
 * Handle for an active run.
 * Use record(), recordBatch(), complete(), fail(), cancel() to instrument.
 */
class RunHandleImpl implements RunHandle {
  readonly runId: string;
  readonly agentId: string;
  readonly projectId: string;

  private sequence = 0;
  private readonly buffer: EventBatchBuffer;
  private readonly transport: Transport;
  private readonly logger: FlightRecorderConfig["logger"];
  private readonly flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private ended = false;

  constructor(config: {
    runId: string;
    agentId: string;
    projectId: string;
    transport: Transport;
    batchSize: number;
    flushIntervalMs: number;
    logger?: FlightRecorderConfig["logger"];
  }) {
    this.runId = config.runId;
    this.agentId = config.agentId;
    this.projectId = config.projectId;
    this.transport = config.transport;
    this.buffer = new EventBatchBuffer(config.batchSize);
    this.flushIntervalMs = config.flushIntervalMs;
    this.logger = config.logger ?? console;

    // Auto-flush on interval
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.logger?.warn("RunHandle: auto-flush failed", { error: err });
      });
    }, this.flushIntervalMs);
  }

  async record(event: RecordEventInput): Promise<void> {
    if (this.ended) {
      this.logger?.warn("RunHandle.record called after run ended — ignoring", {
        runId: this.runId,
        eventType: event.type,
      });
      return;
    }

    const transportEvent = this.toTransportEvent(event);
    const isFull = this.buffer.add(transportEvent);

    if (isFull) {
      await this.flushBuffer();
    }
  }

  async recordBatch(events: RecordEventInput[]): Promise<void> {
    if (this.ended) {
      this.logger?.warn("RunHandle.recordBatch called after run ended — ignoring", {
        runId: this.runId,
        count: events.length,
      });
      return;
    }

    for (const event of events) {
      const transportEvent = this.toTransportEvent(event);
      const isFull = this.buffer.add(transportEvent);
      if (isFull) {
        // Flush mid-batch to avoid accumulating too many events
        await this.flushBuffer();
      }
    }
  }

  async complete(output?: Record<string, unknown>): Promise<void> {
    if (output !== undefined) {
      // Record a final custom event with the output payload before completing
      await this.record({
        type: "lifecycle.run_completed",
        category: "lifecycle",
        payload: {
          category: "lifecycle",
          kind: "run_completed",
          ...(output !== undefined ? { output } : {}),
        },
      });
    }
    await this.endRun("completed");
  }

  async fail(error: RunFailureInput): Promise<void> {
    // Record error event before marking run as failed
    await this.record({
      type: "error",
      category: "error",
      payload: {
        category: "error",
        errorType: error.errorType ?? "RunFailure",
        message: error.message,
        recoverable: false,
        ...(error.code !== undefined ? { code: error.code } : {}),
      },
    });
    await this.endRun("failed", {
      errorMessage: error.message,
      errorCode: error.code,
    });
  }

  async cancel(reason?: string): Promise<void> {
    if (reason !== undefined) {
      await this.record({
        type: "lifecycle.run_cancelled",
        category: "lifecycle",
        payload: {
          category: "lifecycle",
          kind: "run_cancelled",
        },
        metadata: { reason },
      });
    }
    await this.endRun("cancelled");
  }

  async flush(): Promise<void> {
    await this.flushBuffer();
  }

  private nextSeq(): number {
    return ++this.sequence;
  }

  private toTransportEvent(input: RecordEventInput): TransportEvent {
    return {
      type: input.type,
      category: input.category,
      sequence: this.nextSeq(),
      timestamp: input.timestamp ?? Date.now(),
      payload: input.payload ?? null,
      ...(input.parentEventId !== undefined
        ? { parentEventId: input.parentEventId }
        : {}),
      metadata: input.metadata ?? {},
    };
  }

  private stopTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async flushBuffer(): Promise<void> {
    const events = this.buffer.drain();
    if (events.length === 0) return;

    this.logger?.debug("RunHandle: flushing events", {
      runId: this.runId,
      count: events.length,
    });

    await this.transport.sendEvents({
      runId: this.runId,
      events,
    });
  }

  private async endRun(
    status: "completed" | "failed" | "cancelled",
    opts?: { errorMessage?: string; errorCode?: string },
  ): Promise<void> {
    if (this.ended) {
      this.logger?.warn("RunHandle: endRun called multiple times — ignoring", {
        runId: this.runId,
        status,
      });
      return;
    }

    this.ended = true;
    this.stopTimer();

    // Flush any remaining buffered events before updating status
    await this.flushBuffer();

    await this.transport.updateRunStatus({
      runId: this.runId,
      status,
      completedAt: Date.now(),
      errorMessage: opts?.errorMessage,
      errorCode: opts?.errorCode,
    });

    this.logger?.info("RunHandle: run ended", {
      runId: this.runId,
      status,
      totalEvents: this.sequence,
    });
  }
}

/** Main entry point for the AFR SDK */
export class FlightRecorder {
  private readonly config: Required<Omit<FlightRecorderConfig, "agentVersionId">> & {
    agentVersionId?: string;
  };
  private readonly transport: Transport;

  constructor(config: FlightRecorderConfig) {
    this.config = {
      batchSize: 50,
      flushIntervalMs: 2000,
      retry: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2 },
      logger: console,
      ...config,
    };
    this.transport = new HttpTransport({
      endpoint: this.config.endpoint,
      apiKey: this.config.apiKey,
      retry: this.config.retry,
      logger: this.config.logger,
    });
  }

  /** Start a new agent run. Returns a RunHandle for recording events. */
  async startRun(input?: StartRunInput): Promise<RunHandle> {
    const agentId = input?.agentId ?? this.config.agentId;
    const projectId = input?.projectId ?? this.config.projectId;
    const agentVersionId = input?.agentVersionId ?? this.config.agentVersionId;

    this.config.logger.debug("FlightRecorder.startRun", { agentId, projectId });

    const { runId } = await this.transport.createRun({
      agentId,
      projectId,
      ...(agentVersionId !== undefined ? { agentVersionId } : {}),
      metadata: input?.metadata ?? {},
      tags: input?.tags ?? [],
    });

    const handle = new RunHandleImpl({
      runId,
      agentId,
      projectId,
      transport: this.transport,
      batchSize: this.config.batchSize,
      flushIntervalMs: this.config.flushIntervalMs,
      logger: this.config.logger,
    });

    this.config.logger.info("FlightRecorder: run started", { runId, agentId, projectId });

    return handle;
  }

  /**
   * Create a FlightRecorder with a custom transport.
   * Useful for testing with a mock transport.
   */
  static withTransport(config: FlightRecorderConfig, transport: Transport): FlightRecorder {
    const recorder = new FlightRecorder(config);
    // Override the transport set by constructor
    (recorder as unknown as { transport: Transport }).transport = transport;
    return recorder;
  }
}
