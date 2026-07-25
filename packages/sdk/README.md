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
| `options.maxBufferSize` | `number` | No | Hard cap on buffered events; oldest non-lifecycle events are dropped on overflow. Default: `10000` |
| `options.maxSpoolEntries` | `number` | No | Hard cap on spooled entries; oldest non-lifecycle spooled events are dropped on overflow (from the buffer too). Default: `50000` |
| `options.maxRetries` | `number` | No | Max retry attempts for failed sends. Default: `3` |
| `options.retryBackoffMs` | `number` | No | Initial retry backoff in ms. Default: `500` |
| `options.debug` | `boolean` | No | Log SDK diagnostics (flush results, drops, spool errors) to console. Default: `false` |
| `options.spool` | `EventSpool` | No | Persistent write-ahead spool for at-least-once delivery (see Durability). Default: none |
| `options.onDrop` | `(count, reason) => void` | No | Called when events are dropped. `reason` is `'buffer_overflow'`, `'spool_overflow'`, or `'rejected_by_server'` |
| `options.onFlushError` | `(error) => void` | No | Called when a background (timer / maxBatchSize) flush fails |
| `options.onSpoolError` | `(error) => void` | No | Called when spool I/O fails (spool writes are best-effort) |
| `options.allowInsecureEndpoint` | `boolean` | No | Suppress the plain-HTTP endpoint warning. Default: `false` |

The optional second argument `transport` accepts any object implementing the `Transport` interface. When omitted, `HttpTransport` is used.

Numeric options (`flushIntervalMs`, `maxBatchSize`, `maxBufferSize`, `maxSpoolEntries`) must be `>= 1`; the constructor throws a `TypeError` otherwise. The same applies to `HttpTransportOptions.timeoutMs` and `FlightRecorderConfig.maxConcurrentRequests`.

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
  parentEventId: 'evt_parent',  // link to a parent event
  timestamp: Date.now(),        // override event timestamp
})
```

Throws if no run is active, or if a terminal event (`run.completed` / `run.failed` / `run.cancelled`) has already been recorded for the current run — the server rejects events after the terminal one, so accepting more would poison the pending batch.

> **`sequenceNumber` override hazard.** `RecordEventOptions.sequenceNumber` overrides the auto-assigned sequence number, but the recorder's internal counter does NOT advance for overrides, and the server requires sequence numbers to be contiguous, ascending, and non-repeating within a run. A stray override makes the run's whole batch permanently undeliverable (`SEQUENCE_CONFLICT`), and its events will be dropped. Only use it if you assign every sequence number for the run yourself; almost all callers should omit it.

---

### `recorder.endRun(output)`

Completes the run successfully, flushes all buffered events, and returns a `FlushResult`.

```typescript
const result: FlushResult = await recorder.endRun({ answer: 'Done!' })
// result.success                  — boolean
// result.eventsSubmitted          — number of events sent
// result.errors                   — array of FlushError (empty on success)
// result.statusTransitionDeferred — true when the run-status transition was
//   skipped because the terminal event is still undelivered; the server
//   reconciles the run's status from the terminal event when it arrives
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

**Searchable error text (`errorSummary`).** `failRun`/`RunRecorder.fail()` compute a short summary — the error message plus the first stack frame, bounded to 512 characters — and attach it as an `errorSummary` string field on the `run.failed` event payload (a sibling of `error`/`duration_ms`, not nested inside `error`). It goes through the same redaction pipeline as every other payload field, and it is preserved even when the rest of the payload is too large (>10 KB) and gets externalized to an artifact — a large stack trace no longer means the failure's error text is unsearchable server-side. See `src/error-summary.ts` for the exact field shape.

---

### `recorder.flush()`

Manually flush all buffered events to the server. Returns a `FlushResult`.

```typescript
const result: FlushResult = await recorder.flush()
```

Safe to call at any time; no-ops if the buffer is empty.

---

### `recorder.recover()`

Re-sends everything a previous process left undelivered in the configured spool (events and pending run-status transitions), batched per run so one undeliverable run cannot block the others. Uses peek → send → ack semantics: entries are read without being removed, and the spool is only rewritten (keeping undelivered entries) after delivery is attempted — a crash mid-recovery re-sends duplicates, never loses data. Runs the server rejects permanently (`RUN_NOT_ACTIVE` / `SEQUENCE_CONFLICT`) are dropped and reported via `onDrop(count, 'rejected_by_server')`. Call on startup, before starting new runs. No-op (returns `success: true`) when no spool is configured.

```typescript
const recovered: FlushResult = await recorder.recover()
```

---

## Durability & delivery semantics

### Without a spool (default): at-most-once

Events live only in the in-memory buffer until a flush succeeds. The loss window is everything not yet acknowledged by the server, bounded by:

- up to `flushIntervalMs` (default 1 s) of recent events between background flushes, plus
- up to `maxBatchSize` (default 100) events awaiting the next forced flush, plus
- anything retained after failed flushes, capped at `maxBufferSize` (default 10 000) events.

All of it is lost if the process exits (crash, OOM, SIGKILL) before delivery. `endRun()`/`failRun()` retry the final flush 3 times; if the terminal event still cannot be delivered, the returned `FlushResult` contains an explicit "terminal event UNDELIVERED" error plus `statusTransitionDeferred: true`, background retries continue best-effort, and the recorder is released so a new run can start.

Flushes are batched **per run**: buffered events are grouped by `runId` and each run's batch is sent separately, so a stranded run (e.g. one whose payload cannot be externalized) never blocks delivery for other runs. Per-run failures are reported individually in `FlushResult.errors`. While a run's terminal event is undelivered, the SDK does **not** patch the run's status — the server reconciles status from the terminal event when it arrives; patching first would close the run server-side and make the pending events permanently rejectable (`RUN_NOT_ACTIVE`). Batches the server rejects permanently (`RUN_NOT_ACTIVE` / `SEQUENCE_CONFLICT` in the error body's `code`) are dropped observably instead of being retried forever.

### With a spool: at-least-once

Configure `options.spool` to get a persistent write-ahead log:

```typescript
import { Recorder, FileSpool } from '@agent-flight-recorder/sdk'

const recorder = new Recorder({
  endpoint, apiKey, agentId,
  options: { spool: new FileSpool('/var/tmp/afr/worker-1.jsonl') },
})
await recorder.recover() // re-send anything a previous process left behind
```

- `recordEvent` appends to the spool (best-effort, non-blocking; failures go to `onSpoolError`) before delivery is attempted.
- A successful flush removes the acknowledged events from the spool. Permanently rejected events are removed too (and reported via `onDrop`).
- If a terminal flush fails, the terminal event is persisted before `endRun`/`failRun` returns; the run-status transition is deferred to its delivery (`statusTransitionDeferred: true`).
- `recover()` (next startup) re-sends with **peek → send → ack** semantics: spooled entries are read *without* being removed, delivery is attempted per run, and only then is the spool rewritten with what could not be delivered. A crash at any point during recovery re-sends duplicates on the next attempt — it never loses entries.
- The spool is capped at `maxSpoolEntries` (default 50 000); overflow drops the oldest non-lifecycle entries and fires `onDrop(count, 'spool_overflow')`.

Delivery becomes at-least-once: re-sends are deduplicated server-side by run + `sequenceNumber`. `FileSpool` is Node-only (JSONL file, created lazily; the SDK's main entry stays browser/edge-safe because `node:fs` is loaded via a guarded dynamic import only when FileSpool is used). It is deliberately `flock`-free: one recorder in one process per spool path — use distinct paths per worker. By default appends land in the OS page cache (durable across a process crash, not across power loss); pass `new FileSpool(path, { fsync: true })` to fsync every append to stable storage.

### Observability of loss

- `onDrop(count, reason)` fires whenever events are dropped, with `reason` one of `'buffer_overflow'` (`maxBufferSize`), `'spool_overflow'` (`maxSpoolEntries`), or `'rejected_by_server'` (permanent `RUN_NOT_ACTIVE` / `SEQUENCE_CONFLICT` rejection). Lifecycle events are never dropped by the overflow policies.
- `onFlushError(error)` fires when a fire-and-forget background flush (timer or maxBatchSize trigger) fails; foreground `flush()`/`endRun()`/`failRun()` report errors via their returned `FlushResult` instead.
- `FlushResult.droppedEvents` carries the cumulative drop count.

---

## Redaction

`RecorderOptions.redact` strips sensitive data out of every recorded event payload BEFORE it is buffered, spooled, or sent — and before externalization measures its size, so a redacted (smaller) payload decides whether it gets shipped inline or externalized. Both recorder paths (`Recorder` and `FlightRecorder`/`RunRecorder`) apply it identically.

```typescript
import { Recorder } from '@agent-flight-recorder/sdk'

const recorder = new Recorder({
  endpoint, apiKey, agentId,
  options: {
    redact: {
      paths: ['messages.*.content'],       // dot-paths with `*` wildcards
      patterns: ['email', 'api_key', 'jwt', 'credit_card', 'ssn', 'phone', /internal-[a-z]+/],
      replacement: '[REDACTED]',            // default
      custom: (payload, eventType) => payload, // last transform applied, see below
    },
    onRedactionError: (error) => console.error('[redaction]', error),
  },
})
```

**Shared responsibility.** This pipeline is best-effort defense in depth, not a compliance guarantee — it catches common shapes (well-known secret prefixes, common PII formats) but cannot know your application's own sensitive fields. Use `paths` for anything you know by name (e.g. `input.password`, `messages.*.content`); use `patterns` as a safety net for what leaks despite that. Read `redaction.ts`'s JSDoc for each built-in pattern's documented false-positive/false-negative tradeoffs (e.g. `credit_card` runs a Luhn check to avoid flagging arbitrary 16-digit numbers; `api_key` only matches known vendor prefixes, so a bespoke unprefixed secret needs a `paths` entry or a custom `RegExp`).

**Order of operations & failure handling:** `paths` → `patterns` → `custom`. `paths`/`patterns` always run (this is what guarantees the payload is never sent unredacted). If `custom` throws, the already-`paths`/`patterns`-redacted payload is used as-is, `onRedactionError` fires, and the payload carries `_redactionDegraded: true` so you can detect (and alert on) a broken custom transform in production instead of silently losing its coverage.

**Safety:** the pipeline deep-clones before mutating (never touches your original objects), refuses to traverse through `__proto__`/`constructor`/`prototype` (proto-pollution safe), and bounds traversal depth (32) and node count (10 000) so a pathological payload can't hang the recorder.

## Sampling

`RecorderOptions.sampling` head-samples which runs actually ship telemetry — useful at high volume where recording every run is unaffordable, while still keeping full traces of the runs that matter most: the ones that fail.

```typescript
options: {
  sampling: {
    rate: 0.1,                 // sample in 10% of runs (decided once, at startRun())
    alwaysKeepFailures: true,   // tail bias: an unsampled run that fails ships anyway
    seedFromRunName: true,      // deterministic decision from runConfig.name, for reproducibility
    decider: (ctx) => ctx.tags.includes('debug'), // full override; wins over `rate`
  },
}
```

An unsampled run records NOTHING by default: `startRun()` never calls the transport, `recordEvent()` is a no-op, and `endRun()`/`failRun()` discard silently (observable via `onDrop(count, 'sampled_out')`). There is no separate "sampled-out handle" type — you call the exact same `Recorder` methods either way; only the internal behavior (send vs. discard) differs, so instrumented agent code never has to branch on whether this particular run happened to be sampled in.

With `alwaysKeepFailures: true`, an unsampled run's events are held in a bounded shadow buffer (capped at `maxBufferSize`, same as normal buffering) instead of discarded immediately. If the run ends via `failRun()`, the recorder materializes it for real — calling `transport.createRun()` for the first time — and ships the whole shadow buffer (including the original `run.started`) with contiguous sequence numbers, so the failure's full trace is never lost to sampling. A run that ends via `endRun()` (success) still discards the shadow buffer.

`decider` fully overrides `rate` when provided, and fails open (samples the run IN) if it throws — a broken decider must not silently blackhole telemetry. `seedFromRunName` derives the decision from a stable hash of `runConfig.name` (the `name` field you pass as the second argument to `startRun`) instead of `Math.random()`, so re-running the same named run reproduces the same sampling decision; it falls back to `Math.random()` when no run name is provided.

---

## Security

- **Transport security is TLS via the platform's `fetch`.** The SDK uses the runtime's default certificate validation (Node's bundled CA store, or the platform trust store). There is no certificate pinning and no custom TLS configuration; if you need either, inject a custom `Transport`.
- **Plain-HTTP warning.** Configuring a non-`https` endpoint that is not localhost logs a one-time `console.warn` (the API key and payloads would transit in cleartext). Suppress with `allowInsecureEndpoint: true` if you terminate TLS elsewhere (e.g. a sidecar).
- **Authentication** is the `x-api-key` header on every request. Every request also carries the wire protocol version as `x-afr-protocol` (currently `1`) so future backends can gate protocol changes.
- **Rate limiting.** The backend enforces a per-API-key ingest rate limit over a fixed one-minute window; run creation and artifact uploads each charge 1 unit against the same window as events. Exceeding it returns the `RATE_LIMITED` error code — the SDK retains the affected events and retries them on a later flush.
- **Redaction is defense in depth, not a compliance guarantee.** `RecorderOptions.redact` (see [Redaction](#redaction) below) is regex/path-based pattern matching applied client-side. It has documented false-negatives: an unprefixed/bespoke API key, an SSN written without dashes, or deliberately obfuscated text (e.g. `user (at) example.com`) will NOT be caught by the built-in patterns — only by a `paths` entry you add for your own known-sensitive fields, or a custom `RegExp`. Treat it as a safety net that reduces accidental leakage, never as proof that a payload is free of sensitive data. If you have a regulatory/compliance requirement, do not record sensitive fields in the first place — redact or omit them before calling `recordEvent`, rather than relying on this pipeline to catch them after the fact.

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
  updateRunStatus(runId: string, status: string, endedAt?: number, auth?: TransportAuth): Promise<TransportResponse>
}
```

`updateRunStatus` returns a `TransportResponse` so a failed terminal status transition is surfaced (via `FlushResult.errors`) instead of leaving the run stuck "running".

`TransportResponse` carries the server-assigned `eventIds` on success, and on failure an optional stable `code` parsed from the server's JSON error body (e.g. `RUN_NOT_ACTIVE`, `SEQUENCE_CONFLICT`) that the recorder uses to recognize permanently rejected batches.

`HttpTransport` is the default implementation and targets the Agent Flight Recorder HTTP API. Its retry and batching strategies are injectable:

```typescript
new HttpTransport(endpoint, {
  timeoutMs: 10_000,
  retryStrategy: createRetryStrategy({ maxRetries: 5, backoffMs: 250 }),
})
```

You can inject a custom transport (e.g., for testing) via the second argument to `new Recorder(config, transport)`. When you let `Recorder` construct its own `HttpTransport`, `RecorderOptions.maxRetries` / `retryBackoffMs` are threaded into the retry strategy.

---

## FlightRecorder (un-buffered path)

`FlightRecorder`/`RunRecorder` POST each event immediately instead of buffering. Additional config:

| Config field | Type | Required | Description |
|---|---|---|---|
| `maxConcurrentRequests` | `number` | No | Cap on concurrent in-flight requests across `Promise.all` fan-outs. Default: `8` |
| `allowInsecureEndpoint` | `boolean` | No | Suppress the plain-HTTP endpoint warning. Default: `false` |

---

## Choosing `Recorder` vs `FlightRecorder`

The SDK ships two entry points. Both cover the same event log rules (append-only,
`run.started` first, terminal event last, automatic >10 KB payload
externalization) — they differ in delivery timing, durability, and how much
control you get over the transport.

| | `Recorder` (buffered) | `FlightRecorder` / `RunRecorder` (un-buffered) |
|---|---|---|
| Delivery timing | Batched — flushed on a timer (`flushIntervalMs`, default 1000 ms) or at `maxBatchSize` (default 100) | Immediate — one HTTP request per `recordEvent`, awaited |
| Crash durability | Optional `FileSpool` write-ahead log + `recover()` for at-least-once delivery | None — an event lost mid-flight (process killed before the `await` resolves) is simply gone |
| Concurrency control | N/A — a single serialized flush chain | FIFO `Semaphore`, default `maxConcurrentRequests: 8`, shared across all `RunRecorder`s from one `FlightRecorder` |
| Custom transport | Yes — inject any `Transport` via `new Recorder(config, transport)` (e.g. `MockTransport` in tests) | No — always real `fetch`; there is no injectable seam |
| Best for | Long-lived servers, worker pools, durable agent loops | Short scripts, CLIs, one-shot jobs, Lambda invocations |

Rule of thumb: if your process might exit right after the last event with no
time for a background flush timer to ever fire, use `FlightRecorder`. If your
process runs for a while and emits many events, use the buffered `Recorder` —
batching amortizes HTTP overhead, and a `FileSpool` protects you from losing
telemetry across a crash. See `examples/unbuffered_quickstart.ts` for the full
tradeoff writeup, including the concurrency-semaphore note.

---

## Reading runs back (`FlightReader`)

`Recorder`/`FlightRecorder` are write-only — they record. `FlightReader` is
the read half: a typed client over the public v1 read API
(`GET /api/v1/runs...`, documented in full in `docs/api_reference.md`), so
"record with `Recorder`, read back with `FlightReader`" is a single-package
story — no separate HTTP client needed. It's also what
`@agent-flight-recorder/cli` (`afr runs list|get`, `afr replay`, `afr tail`,
`afr export`) is built on: `packages/cli/src/apiClient.ts` is a thin wrapper
over this same class.

```typescript
import { FlightReader } from '@agent-flight-recorder/sdk'

const reader = new FlightReader({
  baseUrl: 'https://your-afr-instance.example.com',
  apiKey: process.env.AFR_READ_KEY!, // a key carrying the "read" scope
})

// List runs
const { runs, nextCursor } = await reader.listRuns({ status: 'failed', limit: 25 })

// Get one run
const { run, eventCount, artifactCount } = await reader.getRun(runs[0].id)

// Page through a run's events manually...
const { events, nextCursor: eventsCursor } = await reader.getRunEvents(run.id, { limit: 200 })

// ...or let iterateEvents() page transparently
for await (const event of reader.iterateEvents(run.id)) {
  console.log(event.sequenceNumber, event.type)
}

// The server-computed replay projection (same derivation the web UI uses —
// CLAUDE.md: replay is a derived projection, never stored)
const { projection, failureSummary } = await reader.getReplay(run.id)

// The root-cause explanation for a run (the "explainability layer", ADR-004)
const { explanation } = await reader.getExplanation(run.id)
if (explanation) {
  console.log(explanation.failureClass, explanation.summary, explanation.rootCause)
  console.log('cited events:', explanation.citedSequenceNumbers)
} else {
  // null covers BOTH "run hasn't failed" and "failed but not explained yet" —
  // see getExplanation()'s doc / the table below for how to tell them apart.
  console.log('nothing to show yet')
}
```

Record-and-read together:

```typescript
import { Recorder, FlightReader, Events } from '@agent-flight-recorder/sdk'

const recorder = new Recorder({ endpoint, apiKey, agentId: 'agent_support_bot' })
const run = await recorder.startRun({ query: 'Help me with my order' })
recorder.recordEvent('llm.request', Events.llmRequest('gpt-4o', messages).payload)
await recorder.endRun({ reply: 'Done.' })

const reader = new FlightReader({ baseUrl: endpoint, apiKey })
const { run: readRun, eventCount } = await reader.getRun(run.runId)
console.log(`${readRun.status} — ${eventCount} events`)
```

See `examples/read_back.ts` for the full runnable version.

### Methods

| Method | Endpoint | Returns |
|---|---|---|
| `listRuns(filters?)` | `GET /api/v1/runs` | `{ runs, nextCursor?, pageSize?, total? }` |
| `getRun(runId, { fields? })` | `GET /api/v1/runs/:id` | `{ run, eventCount, artifactCount }` |
| `getRunEvents(runId, { limit?, cursor?, fields? })` | `GET /api/v1/runs/:id/events` | `{ events, nextCursor? }` |
| `getRunEventWindow(runId, { fromSequence? \| aroundSequence?, limit?, fields? })` | `GET /api/v1/runs/:id/events?fromSequence=` | `{ events, fromSequence, nextCursor? }` |
| `iterateEvents(runId, { pageSize? })` | (pages `getRunEvents` transparently) | `AsyncGenerator<Event>` |
| `getReplay(runId)` | `GET /api/v1/runs/:id/replay` | `{ projection, failureSummary }` |
| `getExplanation(runId)` | `GET /api/v1/runs/:id/explanation` | `{ explanation, status?, runStatus?, runEndedAt? }` |
| `getFailurePatterns(filters?)` | `GET /api/v1/patterns` | `{ patterns, nextCursor?, fixConfidence? }` |
| `getFailurePatternEvidence(fingerprintHash)` | `GET /api/v1/patterns/:hash/evidence` | `PatternResolutionEvidence` |

`filters` for `listRuns`: `status`, `agentId`, `environment`, `sessionId`, `limit`, `cursor`, `fields` (all optional).

`filters` for `getFailurePatterns`: `agentId`, `spiking`, `muted`, `status`, `regressed`, `state`, `limit`, `cursor`, `fields` (all optional).

### `fields` — asking for less of each document

Every read that returns stored documents — `listRuns`, `getRun`,
`getRunEvents`, `getRunEventWindow`, `getFailurePatterns` — takes an optional
`fields?: string[]`, forwarded verbatim as `?fields=a,b,c`. Ask for less and
less comes back:

```typescript
// A run list for a status board: two fields per run instead of twenty-five.
const { runs } = await reader.listRuns({ status: 'failed', limit: 200, fields: ['status', 'startedAt'] })

// An event index with no payloads — payload is what makes an event page big.
const { events } = await reader.getRunEvents(runId, { limit: 500, fields: ['type', 'sequenceNumber', 'timestamp'] })

// Composes with the window read.
const { events: slice } = await reader.getRunEventWindow(runId, { aroundSequence: 5000, fields: ['type'] })
```

- **Omit `fields` for the full document.** That is the default and what every
  pre-0.15.0 caller already does — nothing about an existing call changed.
- **The identity field always comes back**, named or not, so a projected row is
  always re-identifiable. Don't spend a slot on it. It is **not `id` on every
  resource** — a run is keyed by its document id, an event by `sequenceNumber`
  (event-log rule 4), a failure pattern by `fingerprintHash`. See the exported
  `PROJECTION_IDENTITY_FIELDS` table.
- **The field vocabulary is the server's.** This SDK holds no second copy of
  the projectable field list to check yours against — a client-side copy drifts
  and starts rejecting fields a newer deployment supports. An unknown field is
  the server's `400 INVALID_ARGUMENT` naming the offender, surfacing as
  `V1ApiError` with `kind: 'invalid_response'` and `status: 400`.
- **Malformed lists are rejected, never repaired.** An empty list, an empty or
  whitespace-padded entry, an entry containing a comma, or a duplicate all
  throw a `RangeError` before any request goes out. These are *shape* rules,
  not vocabulary: the route rejects the same inputs, and quietly trimming
  `' status '` or deduping would hide a caller whose field list was built wrong.
- **Typing caveat:** results are still typed as the full `Run`/`Event`/
  `FailurePattern` (so adding this parameter broke no signature). When you
  project, treat them as `Partial<T>` plus the identity field — unrequested
  fields are absent at runtime even though the type says otherwise.

**Server support required — and verified, not assumed.** Exactly like
`fromSequence` (below), a deployment that predates `?fields=` silently *drops*
the unknown query parameter and returns the **full document** — which is
indistinguishable, to a caller reading `run.status`, from a projection that
happened to include everything it looked at. So the projection is checked
rather than trusted: if any returned document carries a field outside
`requested ∪ identity`, the server did not honor the request and the call throws
`V1ApiError` (`kind: 'invalid_response'`) naming the missing support, instead
of handing back a full document dressed as a projection.

The check only ever fires on evidence, never on a guess. *Extra* fields are
proof the parameter was ignored — a server that applied it cannot emit a field
nobody asked for. *Missing* fields prove nothing and are never flagged: most
entity fields are optional (`endedAt`, `sessionId`, `muted`, …), so a correctly
projected document routinely lacks fields that were requested. And where there
is no evidence at all — no `fields` requested, an empty page, an absent
document — it stays silent.

`getRunEventWindow` always adds `sequenceNumber` to whatever you name, because
its ignored-`fromSequence` check reads it; projecting it away would silently
disarm that check and let the head of the log come back as "the window". (It is
also the events identity field, so the server returns it anyway — asking
explicitly means the guarantee does not rest on that.)
`getFailurePatterns`'s `fixConfidence.entries` are keyed by `fingerprintHash`
and are not projected — keep `fingerprintHash` in your list if you mean to join
them back.

### `getRunEventWindow(runId, options)` — a bounded slice of the event log

`getRunEvents`/`iterateEvents` page forward from the head of the log: to reach
sequence 5 000 with a cursor you must first fetch the 4 999 events before it.
For a consumer that already knows *where* to look — a `RunExplanation`'s
`citedSequenceNumbers`, a failing tool call, the tail of a 20 000-event run —
that means paying for the whole run to get a hundred events of signal.
`getRunEventWindow` addresses the log by `sequenceNumber` instead:

```typescript
// Read the failing region an explanation points at, and nothing else.
const { explanation } = await reader.getExplanation(runId)
const cited = explanation?.citedSequenceNumbers[0]
if (cited !== undefined) {
  const { events } = await reader.getRunEventWindow(runId, { aroundSequence: cited, limit: 40 })
  // events covers roughly cited-20 .. cited+20 — the preceding context plus the failure
}

// Or walk forward from a known floor. Continue with the last sequence + 1 —
// stateless, restartable, no cursor to keep alive.
let from = 1
for (;;) {
  const page = await reader.getRunEventWindow(runId, { fromSequence: from, limit: 200 })
  if (page.events.length === 0) break
  from = page.events[page.events.length - 1]!.sequenceNumber + 1
}
```

Pass **either** `fromSequence` **or** `aroundSequence`, never both (that throws
a `RangeError` before any request is made, as do non-positive or non-integer
bounds). `aroundSequence` is resolved client-side to
`fromSequence = max(1, aroundSequence - floor(limit / 2))`, defaulting `limit`
to `DEFAULT_EVENT_WINDOW_SIZE` (100) — so the backend only ever needs one new
primitive, a sequence floor, not two.

**This method never slices client-side.** It does not fetch the run and cut a
window out of it — that would spend exactly the cost the window exists to
avoid.

**Server support required.** The v1 events endpoint has long accepted
`limit`/`cursor`; `fromSequence` is newer. An older deployment *ignores* an
unknown query parameter and returns the first page of the log — events 1..N,
looking exactly like a window that just happened to start at the beginning.
Rather than hand back that wrong answer, this method detects it and throws
`V1ApiError` with `kind: 'invalid_response'` naming the missing support. The
check is exact, not a heuristic: sequence numbers are positive and contiguous,
so a server that honored the floor can never return an event below it, and one
that ignored it always does whenever the run has any events.

### `getFailurePatterns(filters?)` — recurring failure patterns (PREVENTION cycle 1, ADR-005; `spiking` filter added cycle 2; `muted` field/filter added cycle 3)

Lists recurring failure fingerprints for the key's organization, most-recently-seen first — a durable memory of failures that keep recurring across runs, derived from `RunExplanation`s. Each `FailurePattern` carries `class`, `label`, `count`, `firstSeenAt`/`lastSeenAt`, a bounded sample of `representativeRunIds`, the `affectedAgentVersionIds` it's been seen on, an optional `lastSpikeAssessment` (`isSpiking`, `recentCount`, `baselineMean`, `z`) from the periodic spike-rollup cron, and optional `muted`/`mutedAt` — whether an org admin has muted future alerts for this fingerprint.

```typescript
const { patterns } = await reader.getFailurePatterns({ agentId: 'agent_123', limit: 20 })
for (const pattern of patterns) {
  console.log(`${pattern.label} — seen ${pattern.count}x, last at ${new Date(pattern.lastSeenAt).toISOString()}`)
}

// Proactive prevention (cycle 2): only patterns the spike-rollup cron currently flags as spiking.
const { patterns: spiking } = await reader.getFailurePatterns({ spiking: true })

// Mute reflection (cycle 3): only patterns an admin has muted, or only active (unmuted) ones.
const { patterns: muted } = await reader.getFailurePatterns({ muted: true })
const { patterns: active } = await reader.getFailurePatterns({ muted: false })
```

Pass `spiking: true` to narrow to patterns whose `lastSpikeAssessment.isSpiking === true` — patterns with no assessment yet, or a non-spiking one, are excluded. Omit it (or pass `false`) to see all patterns regardless of spike status.

Pass `muted: true`/`muted: false` to narrow to muted/active patterns; omit it to see all patterns regardless of mute state. **This is a read-only filter.** There is no method on `FlightReader` to mute or unmute a pattern — muting is an admin-only, audited, Clerk-authed action taken through the web app, not a key-authed write. Mute suppresses future *alerts* for a fingerprint; it never hides the pattern from `getFailurePatterns` — a muted, spiking pattern still reports `lastSpikeAssessment.isSpiking === true` alongside `muted: true`.

Like every other query surface in this system (CLAUDE.md), this is **observability-grade derived data, never source of truth** — the event log and each run's own `RunExplanation` remain the only facts about what happened on any single run. `@agent-flight-recorder/cli`'s `afr patterns` is a thin wrapper over this method.

### `getExplanation(runId)` — the "explainability layer" root-cause read (ADR-004)

Fetches the cached root-cause explanation for a run. Resolves `{ explanation }`, mirroring the existing Clerk-authed `GET /api/runs/:id/explanation` exactly — `explanation` is a `RunExplanation` (`kind: 'heuristic' | 'llm'`, `summary`, `rootCause`, `suggestedFix?`, `citedSequenceNumbers`, `failureClass`, `generatedAt`, `model?` when `kind === 'llm'`) when one is cached, or `null` when there's nothing to show yet. `null` resolving is a *successful* call, not an error — never wrap this in try/catch to detect it.

**The coarse-null gap is closed where `status` is present.** `explanation: null` on its own covers BOTH "this run will never have an explanation" (not failed/timed_out/cancelled) AND "eligible, but generation hasn't landed yet." The response now carries an explicit `status` discriminant (`'not_eligible' | 'pending' | 'ready'`) plus `runStatus`/`runEndedAt`, so a caller can tell those apart — and apply a grace period — without a second round-trip:

```typescript
const { explanation, status, runStatus } = await reader.getExplanation(runId)
if (status === 'ready') {
  console.log(explanation!.rootCause)
} else if (status === 'pending') {
  // eligible, still analyzing — try again shortly
} else if (status === 'not_eligible') {
  // this run didn't fail; there is nothing to explain
} else {
  // status absent: deployment predates the discriminant. Fall back to pairing
  // `null` with the run's own status, which is what `afr explain` does.
  const { run } = await reader.getRun(runId)
  void run, runStatus
}
```

`status`, `runStatus` and `runEndedAt` are typed as optional precisely so a consumer pinned to an older deployment still typechecks. See `packages/cli/src/commands/explain.ts` for the same branching in the CLI.

`V1ApiError` is still thrown for genuine failures (the run doesn't exist: `kind: 'not_found'`; auth; rate limiting; network; malformed response) — exactly like every other `FlightReader` method.

**Server-side status:** `GET /api/v1/runs/:id/explanation` is live (`apps/web/app/api/v1/runs/[runId]/explanation/route.ts`, backed by `convex/read_api.ts`'s `apiGetExplanation`). Earlier releases of this README described it as unbuilt; that is no longer true.

### Errors

Every method throws a `V1ApiError` (never a raw fetch error) on any
auth/not-found/rate-limit/server/network/malformed-response failure:

| `err.kind` | Meaning |
|---|---|
| `'auth'` | Missing/invalid/expired/revoked key, or the key lacks the `read` scope |
| `'not_found'` | The run/resource does not exist, or does not belong to the key's org |
| `'rate_limited'` | Per-key rate limit exceeded — `err.retryAfterSeconds` is set when the server sent `retry-after` |
| `'server'` | 5xx from the backend — safe to retry with backoff |
| `'network'` | The request itself failed (DNS, connection refused, timeout) |
| `'invalid_response'` | The response body didn't match the expected `{ apiVersion, data }` envelope; a bad request rejected by the server (HTTP 400 — e.g. `fields` naming a field it doesn't know, `err.status === 400`); or the server silently ignored a capability that was asked for (`fromSequence`, `fields` — no `err.status`, and the message names the missing support) |

`err.status` (HTTP status, when there was one) and `err.code` (the v1
envelope's `error.code`, e.g. `RUN_NOT_ACTIVE`, when the body provided one)
are also available.

### Shared implementation note

The fetch call, envelope parsing, and HTTP-status → `kind` mapping used by
`FlightReader` live in `packages/sdk/src/v1-client.ts` (`fetchV1` /
`V1ApiError`) — this is the ONE source of truth for that logic.
`@agent-flight-recorder/cli`'s `apiClient.ts` wraps the same `V1ApiError` in
its own `ApiClientError` (which additionally carries a CLI process exit
code) rather than re-implementing the mapping.

---

## Recipes

Runnable, self-contained examples in `packages/sdk/examples/`. Each has a
"Run" comment at the top with the exact `pnpm tsx` command.

- **`basic_run.ts`** — the full lifecycle (`startRun` → `recordEvent` →
  `endRun`/`failRun`) against a `MockTransport`, plus an optional
  `FlightRecorder` path against a live server (`--live`).
- **`durable_agent.ts`** — the production shape: `FileSpool` +
  `recover()` on startup + `onDrop`/`onFlushError`/`onSpoolError` wired to
  logging + `captureProcessExit` + a try/catch/finally that always ends the
  run. Copy this as your starting point for a real worker.
- **`llm_agent_loop.ts`** — instrumenting a realistic loop: `llm.request` /
  `llm.response` around a model call, `tool.call` / `tool.result` around a
  tool invocation, and the error path into `failRun` — including a documented
  gotcha about preserving an error's `.code`.
- **`large_payloads.ts`** — builds an intentionally oversized (>10 KB)
  payload and records it exactly like any other event, with inline comments
  explaining the automatic artifact-pointer + SHA-256 checksum story (Event
  Log Rule 3).
- **`unbuffered_quickstart.ts`** — the `FlightRecorder`/`RunRecorder` path for
  short-lived scripts: the decision table above, the concurrency semaphore,
  and the no-buffering tradeoff, in one file.

---

## Instrumenting popular agent shapes

Short, framework-agnostic sketches for wiring the SDK into common agent
patterns. These are **illustrative pseudocode, not real package APIs** —
adapt the shape to whatever provider SDK or framework you actually use; only
the `@agent-flight-recorder/sdk` calls are real.

### (a) A plain OpenAI/Anthropic-style chat loop

```typescript
const recorder = new Recorder({ endpoint, apiKey, agentId })
await recorder.startRun({ query: userMessage })

const messages = [{ role: 'user', content: userMessage }]
recorder.recordEvent('llm.request', Events.llmRequest(model, messages).payload)

// const response = await client.chat.completions.create({ model, messages })  // sketch
const response = { choices: [{ message: { content: '...' } }], usage: { /* ... */ } }

recorder.recordEvent(
  'llm.response',
  Events.llmResponse(model, response.choices[0].message.content, {
    prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, // map from response.usage
  }, 'stop').payload
)

await recorder.endRun({ reply: response.choices[0].message.content })
```

### (b) A LangChain-style callback handler (sketch)

Most agent frameworks expose a callback/hook interface with lifecycle events
that map directly onto `Events.*` builders — treat each hook as a
`recordEvent` call, using the framework's own request/run ID as a
`parentEventId` for tree-shaped traces where it has one:

```typescript
// class AfrCallbackHandler implements FrameworkCallbackHandler {  // sketch — not a real base class
//   constructor(private recorder: Recorder) {}
//
//   onLLMStart(model: string, prompts: string[]) {
//     this.recorder.recordEvent('llm.request',
//       Events.llmRequest(model, prompts.map(p => ({ role: 'user', content: p }))).payload)
//   }
//   onLLMEnd(output: { text: string; usage: object }) {
//     this.recorder.recordEvent('llm.response',
//       Events.llmResponse(model, output.text, output.usage as never, 'stop').payload)
//   }
//   onToolStart(toolName: string, input: unknown, callId: string) {
//     this.recorder.recordEvent('tool.call', Events.toolCall(toolName, input, callId).payload)
//   }
//   onToolEnd(callId: string, output: unknown, durationMs: number) {
//     this.recorder.recordEvent('tool.result', Events.toolResult(callId, output, durationMs).payload)
//   }
//   onChainError(error: Error) {
//     void this.recorder.failRun(error)
//   }
// }
```

### (c) A plain while-loop tool agent

```typescript
const recorder = new Recorder({ endpoint, apiKey, agentId })
await recorder.startRun({ query: userMessage })

try {
  let done = false
  while (!done) {
    recorder.recordEvent('llm.request', Events.llmRequest(model, messages).payload)
    const step = await callModel(messages) // your own function
    recorder.recordEvent('llm.response', Events.llmResponse(model, step.content, step.usage, step.finishReason).payload)

    if (step.toolCall) {
      recorder.recordEvent('tool.call', Events.toolCall(step.toolCall.name, step.toolCall.input, step.toolCall.id).payload)
      const output = await runTool(step.toolCall) // your own function
      recorder.recordEvent('tool.result', Events.toolResult(step.toolCall.id, output, output.durationMs).payload)
      messages.push({ role: 'tool', content: JSON.stringify(output) })
    } else {
      done = true
      await recorder.endRun({ reply: step.content })
    }
  }
} catch (err) {
  await recorder.failRun(err instanceof Error ? err : new Error(String(err)))
}
```

See `examples/llm_agent_loop.ts` for a fully compiling, runnable version of
this pattern (including the tool-error path).

---

## Version

v0.26.0 — **Three unreadable questions produced an org-wide `healthy`, and nothing named it. The most serious defect of this work.** `isFleetHealthAnalysisComplete` applied the CONSUMER accessor to `unanswered`. Both accessors were correct; the DIRECTION was wrong for the one collection that is completeness-bearing. Executed, against a report whose scan is genuinely complete so `unanswered` is the only thing withholding certification: `[]` -> healthy (right), `[real question]` -> indeterminate (right), **`[null]` -> HEALTHY, `[null,null,null]` -> HEALTHY**. Dropping an element from `unanswered` does not lose a row on a screen — it deletes the reason the analysis was not allowed to certify. An unreadable question is the STRONGEST ground for `indeterminate` there is; it had become the weakest. Same family as the negative-clause vacuity: a completeness predicate satisfied by an absence it created itself. **A sibling was found while fixing it**: `correlations` also gates the verdict, so `correlations: [null]` turned an unreadable claim about the fleet into an absence of claims — `healthy` again. **The fix is not "use the other accessor here".** Direction is now declared ONCE PER COLLECTION in a `REPORT_COLLECTIONS` table (`correlations`/`unanswered` gate; `hypotheses`/`roster` display), for the same reason the container-only helper was deleted rather than documented: any direction chosen at a call site is a direction someone can get wrong again. The table also drives `fleetReportUnusableFields`, which now covers four collections of four BY CONSTRUCTION — it had covered three, and the missing one was precisely the completeness-bearing one, which is why nothing named the defect. A malformed element in a DISPLAY collection is still named but does not block certification, so the fix is not "declare everything indeterminate". `not_a_correlation` is renamed `malformed_element`, accurate for all four. **The verification gained a second dimension**: the export sweep enumerated FUNCTIONS asking "does it throw", and `fleetReportUnusableFields` did not throw on a malformed `unanswered` element — it ignored it. A sweep over COLLECTIONS asking "does it report" is now in the suite, derived from the report's own shape with a named-anchor positive clause, and verified by removing `unanswered` from the table and watching it go red. A generalized attack is only as general as its dimensions. Requires contracts >= 0.23.0.

v0.25.0 — **Three more functions had the null-array-element defect, and the recurrence is the finding.** v0.24.0 fixed the rule in `fleetReportIncoherences`, `rankFleetCorrelations` and `citedAgentCount` — three of the SIX that needed it, the three whose call sites happened to be open. `hypothesesFor`, `orphanHypotheses` and — read twice — **`fleetReportUnusableFields`, whose entire job is reporting unusable fields**, still threw on one. The same shape had already recurred once with NaN. So the repair is not "remember harder at six call sites": **the raw read is deleted.** Nothing in `fleet_health.ts` touches `report.correlations`/`.hypotheses`/`.roster`/`.unanswered` or `correlation.observedBy` directly any more; they go through accessors that validate CONTENTS and not just the container, and the container-only helper that made the mistake easy is gone. Two accessors, not one, because reporters and consumers genuinely differ: a REPORTER keeps a malformed element and names its position (silently dropping one turns a malformed cluster into an absent one), a CONSUMER drops it and computes over the rest (a view that crashes tells an operator less than one showing the sound clusters). `fleetReportUnusableFields` now reports `not_a_correlation` for a bad element in any of the four collections rather than dying on the first. `orphanHypotheses` also now treats an empty/missing `restingOn` as the orphan condition it is — `.some()` over an empty list is false. **The durable half is `tests/unit/fleet_export_tolerance.test.ts`**, which enumerates this module's exports FROM ITS OWN SOURCE: a new exported function without a malformed-contents probe fails the suite, and so does a stale probe for a function that no longer exists. A hand-written list structurally cannot catch this class, because the thing that goes wrong IS the list being incomplete — verified by appending a function and watching it go red. Scoped to malformed contents in a well-formed container, the shape wire JSON produces. Requires contracts >= 0.22.0.

v0.24.0 — **`correlationIncoherences` relied on comparisons, and NaN does not FAIL a comparison — it SKIPS it.** A correlation with `agentCount: NaN` and NaN timestamps returned ZERO incoherence codes and passed as sound, then counted toward `correlationCount`, produced `correlated_failures`, and paged someone at 3am off a cluster made of NaN. A UI correctly rendering `—` for a NaN count is what made it invisible at the one place a human might have caught it. **This is the lesson v0.22.0 wrote into the contract — that correct-by-IEEE-coincidence is wrong-and-lucky — applied to the OTHER HALF OF THE SAME GATE, which the same author left relying on the pattern he had just documented as unsafe.** `correlationIncoherences` now validates its own numeric inputs FIRST and returns `unusable_numbers`, unconditionally rather than relying on `fleetReportUnusableFields` having run: it is exported and the web reaches it directly, so a check that is only correct when something else ran first has an ordering dependency nobody can see from the call site. An INFINITE `burstWindowMs` stays legal — that is how `isCorrelationSelfConsistent` expresses "I cannot see the scan" — while a NaN width, which silently disables the span rule, is refused. **Also fixed, latent:** `fleetReportIncoherences`, `rankFleetCorrelations` and `citedAgentCount` threw on a null ARRAY ELEMENT — the elements of required arrays were still trusted after every required field had stopped being. They now report a `malformed_correlation` addressed by position and rank it LAST, never dropping it, because a silently shorter list turns a malformed cluster into an absent one. **Two invisible dependencies are now pinned by tests** rather than left to be rearranged: the SDK's certainty loop must run before the coherence sweep (which is why the null-element case was never reachable through the SDK), and the CLI ranks UNGATED — safe only because `apiClient.getFleetHealth` routes through `FlightReader`, which refuses a non-empty incoherence list before the CLI sees it. Requires contracts >= 0.21.0.

v0.23.0 — **Two "no data reads as good news" defects, both closed the same way.** (1) `summarizeResolutionHealth` scored an org with NO patterns at **100 — perfect health**, so an org whose pattern ingestion is silently broken presents identically to an org with nothing wrong. Contracts now declares the canonical `ResolutionHealthSummary` with `healthScore: number | null` (and `provenHealthScore` likewise): there is no number that correctly represents "we have no data" — `0` reads as catastrophe, `100` reads as perfect, and a sentinel gets rendered as a number by whoever forgets — so the type says there is no score. `healthScoreLabel()` renders it. **This is the same rule as `FleetShareMeasurement.unaffectedSharing`: an unmeasured quantity is not a measured extreme**, and it generalises to any summary statistic with an empty input, because the empty input is the one nobody writes a test for and the one ordinary operation produces most often. (2) `FailurePattern.affectedAgentIds` caps at 20 most-recent-first and said nothing, so a saturated "20" was indistinguishable from a real 20 — and it **undercounts precisely on the widest-spreading failures**, which are the ones worth knowing about. It also CHURNS: most-recent-first dedup means two reads seconds apart return different members, so a saturated set is unstable as well as incomplete. Adds `affectedAgentIdsTruncated?: boolean` and `affectedAgentCountLabel()`, which renders `"20+"` and treats a set AT the cap as truncated even when the flag is absent — the flag is optional and missing on every pre-existing row, so trusting its absence would render exactly those rows as exact. Requires contracts >= 0.20.0. Both are additive; no existing API changed.

v0.22.0 — **Base-rate blindness could defeat the base-rate guard, via the neighbours of `null`.** `null` itself was airtight at every layer — it was the case the design was built for. Its neighbours were not, because the guard asked `=== null` ("did they SAY they measured it?") when the property the verdict needs is "CAN I DO ARITHMETIC WITH THIS?". For inputs nobody designed for, a guard written as a comparison does not reject the value, it takes the other branch, and whether that branch is safe is luck: **counts arriving as the STRINGS `'0'` and `'188'` returned `discriminating`** (JS coercion makes `'0'/'188'` zero), and **a DROPPED `measurementTruncated` flag returned `discriminating`** (`undefined` is falsy, so the truncation guard failed OPEN and floors were compared as totals). Both promote a guess to "read this first" from unvalidated wire data — base-rate blindness defeating the exact mechanism built to prevent it. Absent fields returned `not_discriminating`, a MEASURED verdict from no measurement. NaN was safe only by the coincidence that every IEEE comparison with NaN is false, which is being wrong and lucky. **The class is the same one that produced the burst-span hole: a gate that verifies a field is PRESENT has not verified that its CONTENTS ARE USABLE.** So the fix is not in `discriminationOf`: `fleetReportUnusableFields` asks the question directly, once, at the BOUNDARY, for every field that feeds a verdict, a gate or the ranking — scan counts and timestamps, `correlationBasis`, `agentsFailing`, correlation timestamps and breadth, citation timestamps, roster counts, and every `sharedBy` — and the SDK refuses the report, because a measurement that arrives unusable is a report to refuse rather than a value every downstream function must defend against forever. It runs BEFORE all arithmetic and AFTER the structural checks, so a conflated finding still reports the conflation rather than a missing-field symptom of it. `baseRateUsability` is three-valued (`usable` / `not_measured` / `unusable`) so an honest `null` stays legal and only malformed input is refused; `discriminationOf` additionally fails CLOSED on anything non-usable, since it is exported and reachable without the gate. Counts must be non-negative integers, which rejects NaN, infinities, strings, negatives and non-integers in one predicate; the truncation flag must be an actual boolean, so a dropped flag fails closed. The sweep never throws — a validator that crashes on malformed input has handed a monitoring loop an exit code nobody wrote a meaning for. **This also closed two holes nobody had reported**: garbage correlation timestamps made the burst-span rule silently unenforceable (every comparison evaluating to `false` reports NO incoherence), and a NaN `agentsFailing` turned a failing fleet into `healthy`. Requires contracts >= 0.19.0.

v0.21.0 — **Hardening of the fleet contract after three adversarial passes. Five defects, four of them one class.** **The class, named because it produced four holes on its own: verifying that a field is PRESENT and internally well-formed is not the same as verifying that the NUMBERS IT CARRIES agree with the OTHER numbers in the same report.** (1) **A "four-minute burst" could declare a twenty-four-hour span.** The gate checked the `burstWindowMs` ECHO (did the server honour the parameter?) and never the SPAN (does the returned burst fit that width?) — the same wrong answer the echo check exists to prevent, arriving by the other route. Fixed by `fleetReportIncoherences`, which is the only entry point holding both the correlation and the scan; `isCorrelationSelfConsistent` takes no scan and therefore structurally cannot see this, is documented as not-a-gate, and the seam is pinned by a test rather than left implicit. (2) `orphanHypotheses` asked whether ANY `restingOn` key resolved rather than whether ALL did, so `['real-key','fabricated-key']` passed as grounded — and a partially-grounded explanation is *more* persuasive than a wholly invented one, because the half that resolves lends credibility to the half that does not. (3) `agentCount` — the number that decides what an operator reads first — was never compared to the agents listed or cited. Now sound rather than heuristic: `agentIds` is bounded at a KNOWN ceiling, so a list below that ceiling is COMPLETE and `agentCount` must equal it; beyond the ceiling the claim must be corroborated by at least two distinct cited agents. Fixed at the source rather than by demoting breadth in the ranking, which would have traded away a correct product rule to work around an unchecked input. (4) Coverage of a claimed breadth is not checkable from a bounded evidence sample — but **coverage of the SAMPLE is**, and twelve citations that all name one agent is one agent retrying, not an outage. (5) **`candidateExplanation` is removed.** Every other barrier in this contract stops a CONSUMER promoting suspicion to fact by forgetting something; a free-prose headline let the ENGINE do it in one keystroke — `'model m-4 is failing'` was a compiling, contract-valid hypothesis, and during an incident that sentence is what someone acts on. A hypothesis now carries `kind` + `sharedValue` and its sentence is COMPOSED by `hypothesisQuestion()`, always interrogative, so the mood is a property of the type rather than of whoever wrote the engine. A regex on prose was considered and rejected: strict enough to reject "m-4 is degrading" also rejects valid English, and loose enough to accept valid English is satisfied by inserting "may". The reader additionally refuses any transmitted headline field on the wire. **BREAKING for producers of `HypothesisedCause`** (`candidateExplanation` -> `sharedValue`). Requires contracts >= 0.18.0.

v0.20.0 — **New: `FlightReader.getFleetHealth()` — the org-wide altitude.** Every other read in this SDK is one run or one agent, which is the wrong altitude for an org running hundreds: the thing worth catching is not "agent 41 failed", it is "twelve agents started failing inside four minutes". `getFleetHealth({ since, until, burstWindowMs })` returns a roster with a health state per agent plus CROSS-AGENT correlations — the same failure fingerprint on N agents, or N agents beginning to fail inside one window. **Correlation and causation are separate, mutually unassignable types, and that is the whole feature.** `ObservedCorrelation` holds what demonstrably happened, each one citing the recorded failures it is made of (`observedBy` is a non-empty tuple). `HypothesisedCause` holds proposed readings of those — and carries a REQUIRED base-rate measurement (`sharedBy`), because "all 12 failing agents use model m-4" is worthless when 198 of the org's 200 agents use m-4, and the denominator is the only thing that separates those two readings; `unaffectedSharing: null` means NOT MEASURED and is never read as zero. A hypothesis also must name the observation it rests on (`restingOn`, non-empty), so it can never float free of the facts. **A hypothesis cannot move the verdict:** `computeFleetHealthVerdict` has no hypothesis-count parameter, by design — a guess cannot page anyone. Response verification refuses an ignored window parameter (a dropped `burstWindowMs` turns a day of background failure into a four-minute "incident"), a missing scan record, a correlation citing evidence outside the window it claims, a conflated finding, an orphan hypothesis, a hypothesis with no denominator, and a verdict that contradicts its own contents. `isFleetHealthScanComplete` carries two positive clauses (`agentsAssessed > 0` and a `whole_roster` correlation basis) for the reasons in v0.19.1 plus one specific to this altitude: a page-local correlation pass reports zero clusters over a fleet that is visibly on fire, because it never held enough of the fleet in one place to see one. **There is deliberately no page-merge helper** — cross-agent correlation does not compose across pages. Requires contracts >= 0.17.0. Additive; no existing API changed.

v0.19.1 — **Fix: completeness was vacuously true on an empty analysis, producing `compatible` from zero evidence.** `isFleetScanComplete` returned `true` for a window that scanned nothing (`runsAnalyzed: 0`), and `isDivergenceCoverageComplete` returned `true` for coverage that assessed no dimension and read no event — so `computeDivergenceVerdict` turned both into `compatible`: a green light for a deploy, derived from an analysis that examined nothing. Both predicates were built entirely from NEGATIVE clauses (nothing truncated, nothing skipped, nothing unassessed, no pages left), every one of which an empty analysis satisfies. **The category error is worth naming, because it has now produced defects in three layers of this feature: the predicates were answering "was anything truncated?" when the property they must express is "do we have enough evidence to conclude?".** Those coincide on every input where something was examined and diverge only on the empty one, which is why a sweep of 16 non-empty window shapes agreed and the bug survived. An empty window is not exotic — it is what ordinary operation produces once a version's runs age out of the retention window (ADR-001), exactly when someone is asking whether an old version can be retired. Fixed by adding a POSITIVE clause to each: `runsAnalyzed > 0`, and `assessed.length > 0 && eventsExamined > 0` (sound rather than merely cautious — Event Log Rule 5 guarantees every run has at least a `RUN_STARTED`, so `eventsExamined: 0` never means "an empty run"). The boundary is one, not more: a single analysed run is complete, so a low-traffic agent does not become permanently inconclusive. **The divergence engine's local `runsAnalyzed > 0` override, which existed only because this helper was wrong here, should now be deleted rather than kept in sync** — a contract helper that disagrees with the server about the same facts is the seam this whole feature exists to remove. `computeDivergenceVerdict`'s `complete` input is now documented as helper-only, never hand-rolled. No API change; behaviour change is confined to the empty case.

v0.19.0 — **Structured config snapshots, so the divergence engine can answer something.** `AgentVersion.configSnapshot` is free-form by decision (ADR-0019), and a free-form blob makes no checkable claims — so the divergence engine correctly, and uselessly, answers `indeterminate` for nearly every real run. New exports build a snapshot it can reason over: `buildAgentConfigSnapshot`, `enumeratedTools`, `partialTools`, `toolsFromCalls`, `digestSystemPrompt`, plus contracts' `AgentConfigSnapshot` / `readAgentConfigSnapshot` / `declaredDimensions` / `supportsProof` / `AGENT_CONFIG_SNAPSHOT_SCHEMA` (>= contracts 0.16.0). **Additive and opt-in: free-form snapshots stay legal, are never re-interpreted, and need no migration** — `AgentVersion` is immutable, so there is no rewriting one, and an unmarked snapshot reads exactly as it does today. **Declaration is per dimension**, so declaring only your tools buys real proofs about tools and an honest unanswered question about everything else, rather than all-or-nothing. **A partial list can never produce a proof:** completeness is claimed explicitly (`enumerated` vs `partial`), because a half-captured tool list treated as complete would report `tool_removed` for every tool that simply was not enumerated — a fabricated certainty produced by a capture bug. `toolsFromCalls` (inferring a list from observed `tool.call` events) is therefore *always* `partial` and cannot be made otherwise. **Declaring emptiness is a real claim:** `{ declared: 'none' }` / `{ declared: 'unbounded' }` are complete, checkable answers, which turns a permanent `indeterminate` into a real verdict for free. `digestSystemPrompt` hashes with WebCrypto (no `node:crypto`, so the main entry stays edge-safe), carries a digest rather than prompt text — the engine only ever asks "did this change?" — and degrades to `{ declared: 'unknown' }` rather than falling back to a weak hash, because a colliding prompt digest would report an edited prompt as unchanged. Also new: `divergenceByDimension` / `DIVERGENCE_DIMENSIONS` (per-dimension outcomes, so a partial analysis says "tools BROKEN, model clean, budgets UNDECLARED" instead of one word), `mergeFleetDivergenceReports` (the one exact page merge), `ConfigDivergenceReport` (config-only tier — it has no `verdict` and no `proven` field *by construction*, because with no run in hand there is nothing to prove and a verdict from no evidence is the thing this feature exists to prevent), and `AgentDivergenceParams.cursor`. `DivergenceScanWindow` gains `runsSkippedForBudget` and `nextCursor`, both folded into `isFleetScanComplete` — **an outstanding cursor now makes a scan incomplete**, so a first page can never read as `compatible`. Breaking for producers of divergence values: `ProvenDivergence`/`SpeculativeDivergence` gain a required `dimension`, and `IndeterminateDivergence.affectedDimension` is renamed `dimension` (one name across all three, so per-dimension folding needs no special cases).

v0.18.0 — **Version divergence: "would this run still have been possible on that version?"** Two new `FlightReader` reads — `getRunDivergence(runId, { targetVersionId })` and `getAgentDivergence(agentId, { targetVersionId, since?, limit? })` — over `GET /api/v1/runs/:id/divergence` and `GET /api/v1/agents/:id/divergence`, returning contracts' `DivergenceReport` / `FleetDivergenceReport` (>= contracts 0.15.0). No execution: the engine compares a run's recorded event history against a target `AgentVersion`'s `configSnapshot`, the same idea as a Temporal replay test. **The report separates three things that must never be conflated, and the separation is structural rather than a `severity` field a consumer can ignore:** `ProvenDivergence` (the run called a tool the target does not declare — it could not have done this; carries a non-empty `provenBy` citing the recorded event), `SpeculativeDivergence` (the prompt changed, so behaviour may differ — carries a required `speculativeBecause`), and `IndeterminateDivergence` (the question was reached and could not be answered — carries a required `unknownBecause`). The three are mutually unassignable, share no `message`/`summary` field, live in separate arrays, and are deliberately **not** re-exported as a convenience union; a consumer that needs to hold two must name both types, and that is the point. **Both methods refuse a clean report they cannot verify**, in the same spirit as `getRunEventWindow`'s ignored-`fromSequence` check: a missing or mismatched `targetVersionId` echo (an older deployment drops the unknown parameter and answers about the run's OWN version, against which every recorded run is trivially compatible), a missing `coverage`/`window` record (an empty `proven` list then means "safe" or "checked nothing", indistinguishably), a speculative finding served inside `proven[]` (TypeScript's guarantee stops at the wire, so the segregation is re-checked at runtime), an ignored `since` on a fleet scan, or a `verdict` that contradicts the report's own contents — each throws `V1ApiError` (`kind: 'invalid_response'`) rather than resolving. An honestly-declared incomplete analysis is **not** refused: it already forces `verdict: 'indeterminate'`, and deciding that an unfinished analysis blocks a deploy is the gate's job (`afr compat` exits 11). Also re-exported from contracts: `computeDivergenceVerdict`, `divergenceReportVerdict`, `fleetDivergenceVerdict`, `isDivergenceAnalysisComplete`, `isFleetDivergenceAnalysisComplete`, `isDivergenceCoverageComplete`, `isFleetScanComplete`, `MAX_DIVERGENCE_REPRESENTATIVE_RUNS`, and the report/finding types. Additive throughout — no existing signature, return type, or export changed. Server-side note: neither route is wired yet, so both currently surface `kind: 'not_found'` (the same position `getExplanation` shipped in).

v0.17.0 — **The triage ranking lives here now, so there is only one of it.** New exports: the `afr_triage` / `afr triage` ranking — `toTriageResult`, `classifySignal`, `scorePattern`, `choosePointer`, `toTriageItem`, the `SIGNAL_WEIGHT` / `RECENCY_*` / `VOLUME_*` / `MUTE_DEMOTION` / `MAX_TIEBREAK` weights, the `SCAN_LIMIT` / `MAX_ITEMS` / `LABEL_BYTE_CAP` / `TRIAGE_UNEVALUATED_SAMPLE_CAP` caps, the `TRIAGE_COLUMNS` / `TRIAGE_FIELDS` / `TRIAGE_RANKING_SOURCES` / `TRIAGE_REQUEST_FIELDS` field tables, and the types `TriageResult`, `TriageItem`, `TriagePointer`, `TriageSignal`, `TriageVerdict`. Also new: the generic projection primitives `ProjectedColumn`, `columnsOf`, `requestFieldsOf` and `truncateProse`. All of these were previously **internal to `packages/mcp`**. They moved because the CLI's `afr triage` (>= 0.11.0) must answer the same question with the same ordering and the same next-hop targets as the MCP tool, and `packages/mcp` is a leaf application (a `bin`) rather than a shared library — a CLI depending on it would invert the dependency graph and pull an MCP server and its stdio transport into a published command-line binary. They were **split, not copied**: `truncateProse` emits an in-band `…[truncated, N more chars]` marker that callers and tests both read, and two copies of a truncation marker drift into disagreeing about what "truncated" looks like on the wire — the same failure shape as two rankings that can disagree, one level down. `packages/mcp` now re-exports all of it from here, so every existing MCP importer is unchanged and the MCP token budgets re-measure identically (tier 1 284, tier 2 423, tier 3 121, tier 4 3,844 — byte-for-byte unmoved by the move). Purely additive to this package: no existing signature, return type, or export changed.

v0.16.0 — **The truncation marker is readable.** `V1ListFailurePatternsData` gains optional `scanTruncated`, `scannedRows` and `scanRowCeiling` — the fields `GET /api/v1/patterns` has been returning since the scan-window fix but which this type did not declare, so they arrived at runtime and were invisible to every consumer. A filtered pattern request overfetches a bounded window and filters it, so a short or empty page can be produced purely by the server's row ceiling; while `scanTruncated` is `true`, an empty `patterns` array is NOT evidence that nothing matched, and a caller must page on `nextCursor` (or report the question unanswered) rather than read it as clean. All three are optional so a consumer pinned to an older deployment still typechecks. New export: `isPatternScanComplete(data)` — the single place that decides what an ABSENT marker means (reported as complete, so an older deployment behaves exactly as it already did, rather than turning every request into a permanent "inconclusive" that teaches people to disable the check). `getFailurePatterns` deliberately does **not** throw on truncation, unlike `getRunEventWindow` on an ignored `fromSequence` or the `fields` projection check: those refuse because the server returned a wrong answer indistinguishable from a right one, whereas here the server told the truth in a field and the only defect was that nothing read it — and throwing would break the correct remedy (paging) by turning a resumable state into an exception. Deciding that an incomplete scan is fatal belongs to the gate; `afr patterns` (CLI >= 0.10.0) makes that call with exit 11. Additive throughout — no existing signature, return type, or export changed.

v0.15.0 — **Field projection on the read API.** Every `FlightReader` read that returns stored documents — `listRuns`, `getRun`, `getRunEvents`, `getRunEventWindow`, `getFailurePatterns` — now takes an optional `fields?: string[]`, forwarded verbatim as `?fields=a,b,c`, so a caller that needs two fields out of a run (or an event index with no `payload`) stops paying for the whole document. Omitting `fields` returns the full document exactly as before — every existing call is unchanged. The identity field always comes back whether or not you name it — and it is NOT `id` on every resource (runs are keyed by their document id, events by `sequenceNumber`, patterns by `fingerprintHash`; see the exported `PROJECTION_IDENTITY_FIELDS`), and `getRunEventWindow` additionally always requests `sequenceNumber` because its ignored-`fromSequence` check reads it. Malformed lists (empty, blank/padded entry, embedded comma, duplicate) throw a `RangeError` before any request, matching the route's reject-never-coerce rule. The field vocabulary belongs to the server and is deliberately NOT re-validated client-side against a hardcoded copy that would drift; an unknown field is answered with HTTP 400 `INVALID_ARGUMENT`, surfacing as `V1ApiError` (`kind: 'invalid_response'`, `status: 400`). **Ignored-parameter detection, same as `fromSequence`:** an older deployment silently drops `?fields=` and returns the full document, which is indistinguishable from a projection that happened to include everything — so the response is checked, and if any document carries a field outside `requested ∪ identity` the call throws `V1ApiError` (`kind: 'invalid_response'`) naming the missing server support rather than passing a full document off as the requested projection. The check fires only on extra fields (proof) and never on missing ones (optional fields are routinely absent), and stays silent on an empty page or absent document. `getRun` gains an optional second parameter. New exports: `ProjectionParams`, `GetRunParams`, `ProjectableResource`, `PROJECTION_IDENTITY_FIELDS`. Additive throughout — no existing signature, return type, or export changed.

v0.14.0 — **Bounded, sequence-addressed event reads.** New `FlightReader.getRunEventWindow(runId, { fromSequence? | aroundSequence?, limit? })` returns a window of a run's event log addressed by `sequenceNumber` instead of by a cursor walked from the head, so a consumer that already knows where to look (an explanation's `citedSequenceNumbers`, the tail of a long run) no longer has to pull the whole run to reach it. It never slices client-side, and if the deployment's events endpoint ignores `fromSequence` it throws `V1ApiError` (`kind: 'invalid_response'`) rather than passing the head of the log off as the requested window — see the `getRunEventWindow` section for the exactness of that check. `V1GetExplanationData` gains optional `status` (`'not_eligible' | 'pending' | 'ready'`), `runStatus` and `runEndedAt`, closing the documented coarse-null gap where the server already sends them; optional so an older deployment still typechecks. New exports: `getRunEventWindow`, `DEFAULT_EVENT_WINDOW_SIZE`, `EventWindowParams`, `V1EventWindowData`, `RunExplanationQueryStatus`. Additive throughout — no existing signature, return type, or export changed.

v0.13.0 — **All four `state` values are answerable** (ADR-006 cycle 3). `FlightReader.getFailurePatterns({ state })` now accepts `'unproven'`/`'proving'`/`'confirmed'` as well as `'regressed'`: verdicts are served from a periodically refreshed per-pattern snapshot instead of a per-request exposure scan, so the filter no longer needs a scan it cannot afford. The param's name, type and meaning are unchanged — only the set of values the server will answer. `V1ListFailurePatternsData` gains an optional `fixConfidence` envelope (`V1ListFixConfidenceEnvelope`): `stalenessBoundMs` (transported, so no client hardcodes it), `entries[]` (one `FixConfidenceEntry` per returned pattern, carrying `state`/`score`/`computedAt`/`ageMs`/`stale`/`basis`), `staleCount`, and `unevaluated[]`. New exports: `V1ListFixConfidenceEnvelope`, `FixConfidenceEntry`. Requires `@agent-flight-recorder/contracts` >= 0.10.0. Additive — the envelope is optional, so a consumer pinned to an older deployment still typechecks.

Reading the envelope correctly: `stale: true` means a real verdict that has AGED, while `basis: 'none'` means there is no verdict at all — do not collapse them, and do not render either like a fresh verdict. A stale verdict is served rather than dropped because it can only under-report (soak and exposure accumulate, and `regressed` is written eagerly by the regression guard, never waiting for a refresh). `unevaluated[]` names patterns that have a live resolution but no usable snapshot: they cannot match a `state` filter, but "could not evaluate" is not "does not match", so they are named rather than silently dropped. `state: 'regressed'` additionally keeps an exact, snapshot-free path and matches if either it or the snapshot says so, so a CI gate on it is never weaker than before snapshots existed and never depends on cron liveness.

v0.12.0 — **Prove the fix held** (ADR-006 cycle 2). New method: `FlightReader.getFailurePatternEvidence(fingerprintHash)` -> `V1PatternEvidenceData` (`GET /api/v1/patterns/:fingerprintHash/evidence`), returning `{ pattern, resolution, exposure, transitions, confidence }` — the resolution claim, the run exposure accumulated since it, the lifecycle transition history (reconstructed from the append-only audit log, including the regression guard's automatic reopens under actor `"system"`), and a graded `confidence` verdict over all of it. `FlightReader.getFailurePatterns(filters?)` gains a `state` filter carrying the same fix-confidence vocabulary; only `'regressed'` is answerable on the list endpoint (the other three states depend on per-pattern run exposure, which cannot be measured across a page — they raise a 422 rather than silently returning an unfiltered page). Prefer `state: 'regressed'` over `regressed: true` for CI: the boolean also matches patterns whose regression predates their current resolution (regressed, then genuinely re-fixed), while `state` matches only a recurrence strictly after the live `resolvedAt`. New exports: `V1PatternEvidenceData`, `FixConfidence`, `FixConfidenceState`, `FixConfidenceLimit`, `FixVersionAttribution`, `PatternLifecycleTransition`, `PatternResolutionMetadata`, `PatternResolutionExposure`. `FailurePattern` (contracts 0.8.0) additionally carries `affectedAgentIds`, `resolvedInVersionId`, `resolvedAtRunCount`, `resolvedAtOccurrenceCount`, passed through unchanged. Read-only and additive — existing callers are unaffected, and there is still no method here that sets lifecycle state.

Reading the numbers correctly: `confidence.score` is a **0-1 fraction, never 1.0** (capped at 0.95 — no finite window proves the absence of a rare failure), not a percentage. `exposure.runCount` is a **floor** when `exposure.runCountTruncated` is true (render `2000+`). `exposure.baselineRunCount` is a 14-day trailing baseline for comparison — never subtract it from `runCount`. `heldSoFar: true` with `runCount: 0` means **untested, not proven**; `confidence.state` already encodes that as `'unproven'`, so gate CI on the state. A pattern auto-reopened by the regression guard keeps its `resolvedAt`, so `status: 'open'` with a non-null `exposure` is valid and expected; only a manual reopen clears it.

v0.11.0 — `FlightReader.getFailurePatterns(filters?)` gains `status` and `regressed` filters (Resolution cycle 1, ADR-006, "resolution reflection"): pass `status: 'open' | 'acknowledged' | 'resolved'` to narrow to an exact lifecycle status (a pattern with no `status` field set is treated as `'open'`), forwarded as a `status=<value>` query param; pass `regressed: true` to narrow to patterns with `regressedAt` set, forwarded as `regressed=true`. `FailurePattern` (contracts) now carries the full resolution-lifecycle fields (`status`, `acknowledgedAt`/`acknowledgedByUserId`, `resolvedAt`/`resolvedByUserId`/`resolutionNote`/`resolutionRef`, `regressedAt`), passed through unchanged — this method only ever reflects lifecycle state, it does not set it (acknowledging/resolving/reopening is a member-gated, Clerk-authed, audited write elsewhere, not part of this key-authed read surface). New export: `FailurePatternStatus` (re-exported from contracts). Additive/optional — existing callers are unaffected. Backs `afr patterns --status`/`--regressed` and the STATUS column (with its `REGRESSED` marker) in its table output.

v0.10.0 — `FlightReader.getFailurePatterns(filters?)` gains a `muted` filter (PREVENTION cycle 3, "mute reflection"): pass `true`/`false` to narrow to muted/active patterns, forwarded as a `muted=true`/`muted=false` query param; omit for all patterns regardless of mute state. `FailurePattern` (contracts) now carries `muted`/`mutedAt`, passed through unchanged — this method only ever reflects mute state, it does not set it (muting is an admin-only, Clerk-authed, audited write elsewhere, not part of this key-authed read surface). Additive/optional — existing callers are unaffected. Backs `afr patterns --muted`/`--active` and the MUTED column in its table output.

v0.9.0 — `FlightReader.getFailurePatterns(filters?)` gains a `spiking` filter (PREVENTION cycle 2): narrows the result to patterns whose `lastSpikeAssessment.isSpiking === true`, forwarded as a `spiking=true` query param. Additive/optional — existing callers are unaffected. Backs `afr patterns --spiking`.

v0.8.0 — `FlightReader.getFailurePatterns(filters?)`: a typed read method over the Failure Patterns endpoint (`GET /api/v1/patterns`, PREVENTION cycle 1 / ADR-005) — lists recurring failure fingerprints for the key's org, most-recently-seen first, optionally narrowed by `agentId`. New exports: `V1ListFailurePatternsData`, `ListFailurePatternsParams`, `FailurePattern`, `FailurePatternClass` (re-exported from contracts). Backs `@agent-flight-recorder/cli`'s new `afr patterns` command.

v0.7.0 — `FlightReader.getExplanation(runId)`: a typed read method over the "explainability layer" root-cause endpoint (`GET /api/v1/runs/:id/explanation`, ADR-004), resolving `{ explanation: RunExplanation | null }` — mirrors the already-shipped Clerk-authed `GET /api/runs/:id/explanation` exactly, including its documented coarse-null gap (`null` means either "not failed" or "not explained yet"; pair with `getRun` to disambiguate, as `afr explain` does). New exports: `V1GetExplanationData`, `RunExplanation`, `RunExplanationKind` (re-exported from contracts). The v1 route itself does not exist yet — see the method's JSDoc for the expected contract, pending platform/data team follow-up to wire it as a thin proxy over `convex/run_explanations.ts`.

v0.6.0 — Searchable error text for large failures (M4): `failRun`/`RunRecorder.fail()` now compute a short, bounded (512 char) `errorSummary` (message + top stack frame) and attach it as a sibling field on the `run.failed` payload; it is redacted like any other payload field and — critically — preserved on the `_externalized` envelope by `externalizePayloadIfLarge` when the full payload (e.g. a big stack trace) exceeds the 10 KB inline threshold, so a failure's error text stays searchable server-side regardless of payload size. New `RecorderOptions`/README security callout documenting redaction's guarantee model (regex/path-based defense in depth, not a compliance guarantee) and its known false-negatives. `FileSpool` now warns (once per path) if a second instance in the same process targets an already-open spool path.

v0.5.0 — `FlightReader`: a typed read client over the public v1 read API (`listRuns`/`getRun`/`getRunEvents`/`iterateEvents`/`getReplay`), so record-and-read is a single-package story. Its fetch/envelope/status-mapping core (`fetchV1`/`V1ApiError` in `src/v1-client.ts`) is the single source of truth shared with `@agent-flight-recorder/cli`'s `apiClient.ts` — the CLI no longer re-implements this logic. New exports: `FlightReader`, `V1ApiError`, `fetchV1`, `tryParseV1Json`, `messageFromV1Body`, plus the v1 data/config types.

v0.4.0 — Redaction pipeline (`RecorderOptions.redact`): dot-path + wildcard targeting, built-in named patterns (`email`/`api_key`/`jwt`/`credit_card`/`ssn`/`phone`) with documented false-positive tradeoffs, caller `custom` transform with guaranteed-redacted fallback on throw (`_redactionDegraded: true`), applied identically in both recorder paths before externalization measures payload size. Sampling (`RecorderOptions.sampling`): head sampling by `rate`, `decider` override (fails open), `seedFromRunName` for reproducible decisions, `alwaysKeepFailures` tail-bias shadow buffering so a sampled-out run that fails still ships its full trace. New `onDrop` reason `'sampled_out'`.

v0.3.1 — Stranded-run fix: the run-status transition is deferred (never patched) while the terminal event is undelivered, so retried events can no longer be poisoned into `RUN_NOT_ACTIVE`; flush and `recover()` batch events per run so one stranded run cannot block others; permanent server rejections (`RUN_NOT_ACTIVE`/`SEQUENCE_CONFLICT`) drop the affected run's events observably (`onDrop(count, 'rejected_by_server')`). Spool hardening: `recover()` uses peek → send → ack (crash mid-recovery duplicates, never loses; `EventSpool.drain` replaced by `peek` in the interface), `maxSpoolEntries` cap with `'spool_overflow'` drops, buffer-overflow drops now also remove the events from the spool, opt-in `FileSpool` `fsync`. Guards: constructor `TypeError`s for invalid numeric options, `recordEvent` throws after a terminal event, a throwing custom Transport lands in `FlushResult.errors`. `TransportResponse` now surfaces real server `eventIds` and error `code`s.

v0.3.0 — Durability: pluggable `EventSpool` write-ahead spool (`FileSpool` Node implementation), `recorder.recover()`, terminal-delivery guarantee (recorder is never wedged by a failed finalize; undelivered terminal events are surfaced and spooled). Observability: `onDrop` / `onFlushError` / `onSpoolError` callbacks, `debug` logging wired. Wire protocol: `x-afr-protocol` header on every request; `SDK_VERSION` single-sourced. Transport polish: plain-HTTP endpoint warning, `maxConcurrentRequests` bound on the un-buffered path.

v0.2.0 — `HttpTransport` implemented (retry, batching, timeout, payload externalization). `Transport.updateRunStatus` now returns `TransportResponse` (breaking).
