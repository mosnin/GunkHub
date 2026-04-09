import type { CreateEventRequest, CreateRunRequest, CreateRunResponse, CreateEventResponse } from '@agent-flight-recorder/contracts'
import type { TransportResponse } from './types.js'

export interface Transport {
  createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse>
  sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse>
  updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<void>
}

export interface TransportAuth {
  apiKey: string
  orgId?: string
}

export interface BatchingStrategy {
  shouldFlush(bufferedCount: number, lastFlushMs: number): boolean
  maxBatchSize: number
}

export interface RetryStrategy {
  shouldRetry(attempt: number, error: TransportResponse & { success: false }): boolean
  delayMs(attempt: number): number
}

export class HttpTransport implements Transport {
  private readonly endpoint: string

  constructor(endpoint: string) {
    this.endpoint = endpoint
  }

  async createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse> {
    // TODO: Implement HTTP POST to /api/runs
    // This is a stub — real implementation sends to the ingestion endpoint
    throw new Error('HttpTransport.createRun not yet implemented')
  }

  async sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse> {
    // TODO: Implement batch HTTP POST to /api/events
    // Batch events to reduce request count
    throw new Error('HttpTransport.sendEvents not yet implemented')
  }

  async updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<void> {
    // TODO: Implement PATCH to /api/runs/:id/status
    throw new Error('HttpTransport.updateRunStatus not yet implemented')
  }
}

export const defaultBatchingStrategy: BatchingStrategy = {
  maxBatchSize: 100,
  shouldFlush(bufferedCount: number, lastFlushMs: number): boolean {
    return bufferedCount >= this.maxBatchSize || (Date.now() - lastFlushMs) > 1000
  },
}

export const defaultRetryStrategy: RetryStrategy = {
  shouldRetry(attempt: number, error: TransportResponse & { success: false }): boolean {
    return attempt < 3 && error.retryable
  },
  delayMs(attempt: number): number {
    return 500 * Math.pow(2, attempt)
  },
}
