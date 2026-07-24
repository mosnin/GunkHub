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
| `getRun(runId)` | `GET /api/v1/runs/:id` | `{ run, eventCount, artifactCount }` |
| `getRunEvents(runId, { limit?, cursor? })` | `GET /api/v1/runs/:id/events` | `{ events, nextCursor? }` |
| `iterateEvents(runId, { pageSize? })` | (pages `getRunEvents` transparently) | `AsyncGenerator<Event>` |
| `getReplay(runId)` | `GET /api/v1/runs/:id/replay` | `{ projection, failureSummary }` |
| `getExplanation(runId)` | `GET /api/v1/runs/:id/explanation` | `{ explanation: RunExplanation \| null }` |
| `getFailurePatterns(filters?)` | `GET /api/v1/patterns` | `{ patterns, nextCursor? }` |

`filters` for `listRuns`: `status`, `agentId`, `environment`, `sessionId`, `limit`, `cursor` (all optional).

`filters` for `getFailurePatterns`: `agentId`, `spiking`, `muted`, `limit`, `cursor` (all optional).

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

**Known gap (`docs/design/explanations.md` "Known gap: coarse null state"):** `null` covers BOTH "this run hasn't failed — nothing to explain" AND "this run failed but generation hasn't completed/been triggered yet." The endpoint cannot distinguish those two on its own. If you need to tell them apart, pair a `null` result with the run's own `status` (`getRun(runId)` — ADR-004 generates explanations for `'failed'` and `'timed_out'` runs):

```typescript
const [{ run }, { explanation }] = await Promise.all([reader.getRun(runId), reader.getExplanation(runId)])
if (explanation) {
  // ready
} else if (run.status === 'failed' || run.status === 'timed_out') {
  // pending — failed but not explained yet
} else {
  // not_failed — nothing to explain
}
```

This is exactly what `@agent-flight-recorder/cli`'s `afr explain` does — see `packages/cli/src/commands/explain.ts`.

`V1ApiError` is still thrown for genuine failures (the run doesn't exist: `kind: 'not_found'`; auth; rate limiting; network; malformed response) — exactly like every other `FlightReader` method.

**Server-side status (as of this cycle):** `GET /api/v1/runs/:id/explanation` (the key-authed v1 counterpart of the already-shipped Clerk-authed `GET /api/runs/:id/explanation`) does not exist yet — this method is written against the exact same response shape that route already returns (backed by `convex/run_explanations.ts`), so wiring the v1 route should be a thin proxy with no SDK-side change required. Calling it today surfaces a `V1ApiError` with `kind: 'not_found'` until the route is registered.

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
| `'invalid_response'` | The response body didn't match the expected `{ apiVersion, data }` envelope |

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
