# @afr/sdk

Agent Flight Recorder SDK — instrument your agent code to record structured execution traces.

## What it does

The AFR SDK provides a lightweight instrumentation layer for AI agent code. It lets you:

- **Start runs** — create a `RunHandle` representing a single agent execution
- **Record events** — capture LLM calls, tool invocations, memory operations, retrieval queries, errors, and custom events with typed payloads
- **Buffer and flush** — events are batched in-memory and sent to the AFR ingest API automatically (by count or timer), or on-demand
- **End runs** — mark runs as completed, failed, or cancelled; all buffered events are flushed before the status update

> **v1 note:** The HTTP transport is structurally complete (correct URLs, headers, retry logic) but throws `NotImplementedError` until the server-side API is deployed. Use a mock transport (see Testing below) to exercise the SDK logic today.

---

## Installation

```sh
npm install @afr/sdk
# or
pnpm add @afr/sdk
```

---

## Quick start

```typescript
import {
  FlightRecorder,
  llmRequestEvent,
  llmResponseEvent,
  toolCallEvent,
  toolResultEvent,
  errorEvent,
} from "@afr/sdk";

const recorder = new FlightRecorder({
  endpoint: "https://your-afr-instance.com",
  apiKey: process.env.AFR_API_KEY ?? "",
  agentId: "agent_my_assistant",
  projectId: "proj_production",
});

async function runMyAgent(input: string): Promise<string> {
  const run = await recorder.startRun({
    metadata: { input },
    tags: ["production"],
  });

  try {
    await run.record(llmRequestEvent({ model: "claude-3-5-sonnet", provider: "anthropic" }));

    // ... your agent logic ...

    await run.record(llmResponseEvent({ inputTokens: 400, outputTokens: 120, latencyMs: 800 }));

    await run.record(toolCallEvent({ toolName: "web_search", args: { query: input } }));
    // ... tool executes ...
    await run.record(toolResultEvent({ toolName: "web_search", latencyMs: 250 }));

    await run.complete({ result: "done" });
    return "done";
  } catch (err) {
    await run.fail({
      message: err instanceof Error ? err.message : String(err),
      errorType: "AgentError",
    });
    throw err;
  }
}
```

---

## API Reference

### `FlightRecorder`

The main entry point. Holds configuration and creates run handles.

```typescript
const recorder = new FlightRecorder(config: FlightRecorderConfig);
```

#### Methods

| Method | Description |
|--------|-------------|
| `startRun(input?: StartRunInput): Promise<RunHandle>` | Start a new run. Returns a handle for recording events. |
| `FlightRecorder.withTransport(config, transport)` | Static factory — create a recorder with a custom transport (useful for tests). |

---

### `RunHandle`

Returned by `startRun()`. All recording goes through this handle.

| Method | Description |
|--------|-------------|
| `record(event: RecordEventInput): Promise<void>` | Record a single event. Auto-flushes if buffer is full. |
| `recordBatch(events: RecordEventInput[]): Promise<void>` | Record multiple events efficiently. |
| `complete(output?: Record<string, unknown>): Promise<void>` | Mark the run as completed. Flushes all events first. |
| `fail(error: RunFailureInput): Promise<void>` | Mark the run as failed. Records an error event and flushes. |
| `cancel(reason?: string): Promise<void>` | Mark the run as cancelled. Flushes all events first. |
| `flush(): Promise<void>` | Force-flush buffered events without ending the run. |

**Properties:** `runId`, `agentId`, `projectId`

---

### Event builders

All builders return a `RecordEventInput` ready to pass to `run.record()`.

| Builder | Description |
|---------|-------------|
| `lifecycleEvent(kind, opts?)` | Run/step lifecycle events |
| `llmRequestEvent(opts)` | LLM request (model, provider, prompt) |
| `llmResponseEvent(opts)` | LLM response (tokens, latency, finish reason) |
| `toolCallEvent(opts)` | Tool invocation (name, callId, args) |
| `toolResultEvent(opts)` | Tool result (name, callId, latency, result) |
| `toolErrorEvent(opts)` | Tool error (name, callId, error message) |
| `errorEvent(opts)` | Structured error event |
| `customEvent(type, data)` | Arbitrary structured data |
| `memoryReadEvent(opts?)` | Memory read operation |
| `memoryWriteEvent(opts?)` | Memory write operation |
| `retrievalEvent(kind, opts?)` | Vector store / retrieval query or result |

---

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | required | Base URL of the AFR ingest API |
| `apiKey` | `string` | required | API key for `Authorization: Bearer` header |
| `agentId` | `string` | required | Default agent ID for runs |
| `projectId` | `string` | required | Default project ID for runs |
| `agentVersionId` | `string` | — | Optional agent version tag |
| `batchSize` | `number` | `50` | Max events to buffer before auto-flush |
| `flushIntervalMs` | `number` | `2000` | Auto-flush interval in milliseconds |
| `retry.maxAttempts` | `number` | `3` | Max retry attempts on 5xx errors |
| `retry.initialDelayMs` | `number` | `500` | Initial retry delay (ms) |
| `retry.backoffMultiplier` | `number` | `2` | Exponential backoff multiplier |
| `logger` | `Logger` | `console` | Custom logger (debug/info/warn/error) |

---

## Testing with a mock transport

```typescript
import { FlightRecorder, type Transport } from "@afr/sdk";
import { vi } from "vitest";

const mockTransport: Transport = {
  createRun: vi.fn().mockResolvedValue({ runId: "run_test_123" }),
  sendEvents: vi.fn().mockResolvedValue({ accepted: 1 }),
  updateRunStatus: vi.fn().mockResolvedValue(undefined),
};

const recorder = FlightRecorder.withTransport(
  { endpoint: "http://localhost", apiKey: "test", agentId: "a", projectId: "p" },
  mockTransport,
);
```

---

## v1 transport status

The `HttpTransport` is structurally complete:
- Correct endpoint URLs (`POST /api/runs`, `POST /api/events`, `PATCH /api/runs/:id`)
- `Authorization: Bearer {apiKey}` and `Content-Type: application/json` headers
- Exponential backoff retry for 5xx responses (configurable)
- Request body shapes match `@afr/contracts` API types

**Server-side integration is coming in the next build.** Until then, transport methods will throw `NotImplementedError`.
