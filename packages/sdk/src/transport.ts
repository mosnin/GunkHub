import type {
  Transport,
  CreateRunTransportRequest,
  SendEventsTransportRequest,
  UpdateRunStatusRequest,
  RetryConfig,
  Logger,
} from "./types.js";

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  backoffMultiplier: 2,
};

const DEFAULT_LOGGER: Logger = console;

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not yet implemented. This is a foundation stub.`);
    this.name = "NotImplementedError";
  }
}

/** Delay helper for retry backoff */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HttpTransport — the default transport for AFR SDK.
 *
 * Sends data to the AFR ingest API using the Fetch API.
 * Retry logic with exponential backoff is fully implemented.
 * Individual endpoint methods will throw NotImplementedError until
 * the server-side API is available.
 */
export class HttpTransport implements Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly retry: RetryConfig;
  private readonly logger: Logger;

  constructor(config: {
    endpoint: string;
    apiKey: string;
    retry?: RetryConfig;
    logger?: Logger;
  }) {
    this.endpoint = config.endpoint.replace(/\/$/, ""); // strip trailing slash
    this.apiKey = config.apiKey;
    this.retry = config.retry ?? DEFAULT_RETRY;
    this.logger = config.logger ?? DEFAULT_LOGGER;
  }

  /**
   * Create a new run on the server.
   * POST {endpoint}/api/runs
   */
  async createRun(request: CreateRunTransportRequest): Promise<{ runId: string }> {
    return this.withRetry(async () => {
      const url = `${this.endpoint}/api/runs`;
      this.logger.debug("HttpTransport.createRun", { url, agentId: request.agentId });

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          agentId: request.agentId,
          agentVersionId: request.agentVersionId,
          projectId: request.projectId,
          metadata: request.metadata,
          tags: request.tags,
        }),
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, "createRun");
      }

      const data = (await response.json()) as { runId: string };
      return { runId: data.runId };
    });
  }

  /**
   * Send a batch of events.
   * POST {endpoint}/api/events
   */
  async sendEvents(request: SendEventsTransportRequest): Promise<{ accepted: number }> {
    return this.withRetry(async () => {
      const url = `${this.endpoint}/api/events`;
      this.logger.debug("HttpTransport.sendEvents", {
        url,
        runId: request.runId,
        count: request.events.length,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          runId: request.runId,
          events: request.events,
        }),
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, "sendEvents");
      }

      const data = (await response.json()) as { accepted: number; runId: string };
      return { accepted: data.accepted };
    });
  }

  /**
   * Update run status.
   * PATCH {endpoint}/api/runs/{runId}
   */
  async updateRunStatus(request: UpdateRunStatusRequest): Promise<void> {
    await this.withRetry(async () => {
      const url = `${this.endpoint}/api/runs/${request.runId}`;
      this.logger.debug("HttpTransport.updateRunStatus", {
        url,
        runId: request.runId,
        status: request.status,
      });

      const response = await fetch(url, {
        method: "PATCH",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          status: request.status,
          completedAt: request.completedAt,
          errorMessage: request.errorMessage,
          errorCode: request.errorCode,
        }),
      });

      if (!response.ok) {
        await this.handleErrorResponse(response, "updateRunStatus");
      }
    });
  }

  /** Build standard request headers */
  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
      "X-AFR-SDK-Version": "0.1.0",
    };
  }

  /**
   * Handle non-OK HTTP responses.
   * Throws a retryable error for 5xx, a terminal error for 4xx.
   */
  private async handleErrorResponse(response: Response, operation: string): Promise<never> {
    const body = await response.text().catch(() => "(unreadable body)");

    if (response.status >= 500) {
      throw new TransportError(
        `AFR server error on ${operation}: ${response.status} ${response.statusText}`,
        response.status,
        true, // retryable
        body,
      );
    }

    throw new TransportError(
      `AFR client error on ${operation}: ${response.status} ${response.statusText}`,
      response.status,
      false, // not retryable
      body,
    );
  }

  /**
   * Exponential backoff retry wrapper.
   * Retries only on retryable errors (5xx) up to maxAttempts.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err instanceof TransportError ? err.retryable : false;

      if (!isRetryable || attempt >= this.retry.maxAttempts) {
        if (attempt > 1) {
          this.logger.error("HttpTransport: max retries exceeded", {
            attempt,
            maxAttempts: this.retry.maxAttempts,
            error: err,
          });
        }
        throw err;
      }

      const delayMs =
        this.retry.initialDelayMs *
        Math.pow(this.retry.backoffMultiplier, attempt - 1);

      this.logger.warn("HttpTransport: retrying after error", {
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });

      await delay(delayMs);
      return this.withRetry(fn, attempt + 1);
    }
  }
}

/** Error thrown by HttpTransport for non-OK HTTP responses */
export class TransportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    public readonly responseBody: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
