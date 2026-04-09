# Agent Flight Recorder SDK

Record agent executions for debugging, replay, and comparison.

## Installation

```bash
npm install @agent-flight-recorder/sdk
```

## Quick Start

```typescript
import { Recorder, Events } from '@agent-flight-recorder/sdk'

// 1. Create a recorder
const recorder = new Recorder({
  endpoint: 'https://your-afr-instance.example.com',
  apiKey: 'your_api_key',
  agentId: 'agent_support_bot',
})

// 2. Start a run
const run = await recorder.startRun({ query: 'Help me with my order' })
console.log('Run ID:', run.runId)

// 3. Record events as your agent executes
recorder.recordEvent(
  'llm.request',
  Events.llmRequest('gpt-4o', [{ role: 'user', content: 'Help me with my order' }]).payload
)

recorder.recordEvent(
  'llm.response',
  Events.llmResponse(
    'gpt-4o',
    'Sure, I can help with that.',
    { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    'stop'
  ).payload
)

recorder.recordEvent(
  'tool.call',
  Events.toolCall('lookup_order', { order_id: '12345' }, 'call_001').payload
)

recorder.recordEvent(
  'tool.result',
  Events.toolResult('call_001', { status: 'shipped' }, 95).payload
)

// 4. Complete the run — flushes all buffered events
const result = await recorder.endRun({ reply: 'Your order has shipped.' })
console.log('Events submitted:', result.eventsSubmitted)

// Error path
try {
  await recorder.startRun({ query: 'Another query' })
  throw new Error('Something went wrong')
} catch (err) {
  await recorder.failRun(err as Error)
}
```

## API Reference

### `new Recorder(config, transport?)`

Creates a new recorder instance.

| Config field | Type | Required | Description |
|---|---|---|---|
| `endpoint` | `string` | Yes | Base URL of the Agent Flight Recorder ingestion API |
| `apiKey` | `string` | Yes | Organization API key for authentication |
| `agentId` | `string` | Yes | Agent ID this recorder is attached to |
| `agentVersionId` | `string` | No | Optional agent version identifier (semver recommended) |
| `options.flushIntervalMs` | `number` | No | Flush buffered events every N ms. Default: `1000` |
| `options.maxBatchSize` | `number` | No | Force-flush when buffer reaches this size. Default: `100` |
| `options.maxRetries` | `number` | No | Max retry attempts for failed sends. Default: `3` |
| `options.retryBackoffMs` | `number` | No | Initial retry backoff in ms. Default: `500` |
| `options.debug` | `boolean` | No | Log debug output to console. Default: `false` |

The optional second argument `transport` accepts any object implementing the `Transport` interface. When omitted, `HttpTransport` is used.

---

### `recorder.startRun(input, config?)`

Starts a new run and returns a `RunContext`.

```typescript
const ctx: RunContext = await recorder.startRun(
  { query: 'user message' },  // input — any serializable value
  { env: 'production' }       // config — arbitrary metadata stored on the run
)
// ctx.runId   — server-assigned run ID
// ctx.agentId — agent ID from recorder config
// ctx.status  — 'running'
// ctx.startedAt — epoch ms
```

Throws if a run is already active.

---

### `recorder.recordEvent(type, payload, options?)`

Records an event in the currently active run. Events are buffered and flushed in batches.

```typescript
recorder.recordEvent('llm.request', Events.llmRequest('gpt-4o', messages).payload)

// With options
recorder.recordEvent('custom', { data: 'value' }, {
  sequenceNumber: 5,    // override auto-incrementing sequence number
  parentEventId: 'evt_parent',  // link to a parent event
  timestamp: Date.now(),        // override event timestamp
})
```

Throws if no run is active.

---

### `recorder.endRun(output)`

Completes the run successfully, flushes all buffered events, and returns a `FlushResult`.

```typescript
const result: FlushResult = await recorder.endRun({ answer: 'Done!' })
// result.success          — boolean
// result.eventsSubmitted  — number of events sent
// result.errors           — array of FlushError (empty on success)
```

Throws if no run is active.

---

### `recorder.failRun(error)`

Fails the run with an error, flushes all buffered events, and returns a `FlushResult`.

```typescript
const result: FlushResult = await recorder.failRun(new Error('Timeout'))
// or pass a plain object:
await recorder.failRun({ message: 'Upstream 503', code: 'SERVICE_UNAVAILABLE' })
```

Throws if no run is active.

---

### `recorder.flush()`

Manually flush all buffered events to the server. Returns a `FlushResult`.

```typescript
const result: FlushResult = await recorder.flush()
```

Safe to call at any time; no-ops if the buffer is empty.

---

## Events

The `Events` namespace provides typed builders for all standard event types. Each builder returns `{ type, payload }` — pass `.payload` to `recordEvent`.

### `Events.llmRequest(model, messages, options?)`

```typescript
recorder.recordEvent('llm.request', Events.llmRequest(
  'gpt-4o',
  [{ role: 'user', content: 'Hello' }],
  { temperature: 0.7, max_tokens: 512 }
).payload)
```

### `Events.llmResponse(model, content, usage, finish_reason)`

```typescript
recorder.recordEvent('llm.response', Events.llmResponse(
  'gpt-4o',
  'Hi there!',
  { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  'stop'
).payload)
```

### `Events.toolCall(name, input, call_id)`

```typescript
recorder.recordEvent('tool.call', Events.toolCall(
  'search_docs',
  { query: 'refund policy' },
  'call_xyz'
).payload)
```

### `Events.toolResult(call_id, output, duration_ms)`

```typescript
recorder.recordEvent('tool.result', Events.toolResult(
  'call_xyz',
  [{ title: 'Refund Policy', url: '...' }],
  45
).payload)
```

### `Events.httpRequest / httpResponse`

```typescript
recorder.recordEvent('http.request', Events.httpRequest('GET', 'https://api.example.com/orders', ['Authorization']).payload)
recorder.recordEvent('http.response', Events.httpResponse(200, ['Content-Type'], 1024, 88).payload)
```

### `Events.custom(data)`

```typescript
recorder.recordEvent('custom', Events.custom({ step: 'router', decision: 'support' }).payload)
```

---

## Transport

The `Transport` interface abstracts the network layer:

```typescript
interface Transport {
  createRun(req: CreateRunRequest, auth: TransportAuth): Promise<CreateRunResponse>
  sendEvents(events: CreateEventRequest[], auth: TransportAuth): Promise<TransportResponse>
  updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<void>
}
```

`HttpTransport` is the default implementation and targets the Agent Flight Recorder HTTP API. You can inject a custom transport (e.g., for testing) via the second argument to `new Recorder(config, transport)`.

> **Note:** `HttpTransport` is currently stubbed and will throw `not yet implemented`. Full HTTP transport is coming in v1.1. For now, supply your own `Transport` implementation or use the `MockTransport` shown in `examples/basic_run.ts`.

---

## Version

v0.1.0 — transport implementation coming in v1.1.
