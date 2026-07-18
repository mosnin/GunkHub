/**
 * unbuffered_quickstart.ts
 *
 * `FlightRecorder` / `RunRecorder` is the UN-buffered path: every
 * `recordEvent` call POSTs immediately and awaits the response, instead of
 * batching into a buffer that a timer or `maxBatchSize` later flushes.
 *
 * When to choose FlightRecorder over Recorder
 * --------------------------------------------
 * Choose `FlightRecorder` when:
 *   - Your process is SHORT-LIVED (a CLI invocation, a one-shot script, a
 *     cron job, a Lambda handling a single request) and may exit right after
 *     the last event — there's no time window for a background flush timer
 *     to ever fire, and you don't want to remember to call `flush()`/
 *     `shutdown()` yourself.
 *   - You want each event acknowledged (or to throw) before your code moves
 *     on, e.g. because you need the returned event ID immediately.
 *   - Simplicity matters more than throughput: no buffer, no spool, no flush
 *     timer, no batching strategy to reason about.
 *
 * Choose the buffered `Recorder` when:
 *   - Your process is LONG-LIVED (a server, a worker pool, a durable agent
 *     loop) and emits many events — batching amortizes HTTP overhead across
 *     up to `maxBatchSize` (default 100) events per request instead of one
 *     request per event.
 *   - You need at-least-once delivery across a crash (`FileSpool` +
 *     `recover()` — see `durable_agent.ts`). FlightRecorder has no spool.
 *   - You want `onDrop`/`onFlushError`/`onSpoolError` observability hooks, or
 *     retry/batching strategies you can swap out.
 *
 * | | `Recorder` (buffered) | `FlightRecorder` (un-buffered) |
 * |---|---|---|
 * | Delivery timing | Batched: timer (`flushIntervalMs`, default 1000 ms) or `maxBatchSize` (default 100) | Immediate: one HTTP request per `recordEvent` |
 * | Crash durability | Optional `FileSpool` write-ahead log + `recover()` | None — an un-awaited event in flight is simply lost |
 * | Concurrency control | N/A (single flush chain, serialized) | `Semaphore`, default limit 8 in-flight requests (`maxConcurrentRequests`) |
 * | Custom transport | Yes — inject any `Transport` (e.g. `MockTransport` for tests) | No — always real `fetch`; there is no injectable transport seam |
 * | Best for | Long-lived servers / workers / durable agents | Short scripts, CLIs, one-shot jobs |
 *
 * Concurrency semaphore note
 * --------------------------
 * If you fan out `recordEvent` calls with `Promise.all` (e.g. instrumenting
 * several parallel tool calls at once), `FlightRecorder` bounds how many of
 * those HTTP requests are in flight at the same time via a FIFO counting
 * semaphore (`maxConcurrentRequests`, default 8) shared across ALL
 * `RunRecorder`s created from one `FlightRecorder`. This prevents an
 * unbounded connection fan-out; it does NOT reorder events — sequence
 * numbers are assigned synchronously, in call order, before a call ever
 * queues on the semaphore, so contiguity is preserved regardless of which
 * request actually completes first.
 *
 * No-buffering tradeoff
 * ----------------------
 * Because there is no buffer, there is nothing to lose if the process is
 * killed AFTER a `recordEvent`/`complete`/`fail` call resolves — the event is
 * already acknowledged by the server. But there is also no write-ahead spool:
 * if the process dies WHILE a `recordEvent` call is in flight (before you
 * `await` it), that one event is simply lost, with no local record to replay
 * from. For a short script this window is usually acceptable; for anything
 * you need at-least-once delivery for even across a hard crash, use the
 * buffered `Recorder` with a `FileSpool` instead (`durable_agent.ts`).
 *
 * Run (requires a live server — FlightRecorder has no injectable transport):
 *   AFR_API_KEY=your-key AFR_AGENT_ID=your-agent-id AFR_BASE_URL=http://localhost:3000 \
 *   pnpm tsx packages/sdk/examples/unbuffered_quickstart.ts --live
 *
 * Without --live this prints what it WOULD do and exits, so the example
 * still typechecks and runs cleanly with no server available.
 */

import { FlightRecorder } from '@agent-flight-recorder/sdk'

async function main(): Promise<void> {
  const baseUrl = process.env['AFR_BASE_URL'] ?? 'http://localhost:3000'
  const apiKey = process.env['AFR_API_KEY'] ?? 'demo_key_abc123'
  const agentId = process.env['AFR_AGENT_ID'] ?? 'agent_cli_job'

  if (!process.argv.includes('--live')) {
    console.log('unbuffered_quickstart.ts: pass --live (with AFR_* env vars set) to run against a real server.')
    console.log(`Would connect to: ${baseUrl}  agentId=${agentId}`)
    return
  }

  const recorder = new FlightRecorder({
    apiKey,
    baseUrl,
    agentId,
    // Default is 8; lower it if your downstream API has tighter connection
    // limits, or raise it if you're fanning out many independent tool calls.
    maxConcurrentRequests: 8,
  })

  // startRun() already emits the required RUN_STARTED-equivalent event
  // (run.started) for you — see FlightRecorder.startRun in flight-recorder.ts.
  const run = await recorder.startRun({
    metadata: { source: 'unbuffered_quickstart example' },
    tags: ['example', 'cli'],
  })
  console.log('Run started:', run.runId)

  try {
    // Each call here is a full round-trip POST /api/events, awaited in turn.
    // sequence numbers are assigned automatically, starting at 1.
    await run.recordEvent('llm.request', {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Summarize this file.' }],
    })
    await run.recordEvent('llm.response', {
      type: 'llm.response',
      model: 'gpt-4o',
      content: 'Here is the summary...',
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      finish_reason: 'stop',
    })

    // Example of a bounded fan-out: three independent tool calls issued
    // concurrently, each still individually awaited, all sharing the
    // semaphore's 8-request cap.
    await Promise.all([
      run.recordEvent('tool.call', { type: 'tool.call', name: 'read_file', input: { path: 'a.ts' }, call_id: 'c1' }),
      run.recordEvent('tool.call', { type: 'tool.call', name: 'read_file', input: { path: 'b.ts' }, call_id: 'c2' }),
      run.recordEvent('tool.call', { type: 'tool.call', name: 'read_file', input: { path: 'c.ts' }, call_id: 'c3' }),
    ])

    // complete() records the terminal run.completed event and PATCHes the
    // run's status. A failure to record the terminal event now THROWS
    // (it is not swallowed) — losing terminal telemetry is the worst failure
    // mode for a flight recorder.
    await run.complete({ summary: 'Here is the summary...' })
    console.log('Run completed:', run.runId)
  } catch (err) {
    // fail() records run.failed, PATCHes status to 'failed', and re-throws
    // the ORIGINAL error (not a wrapped one) so your own error handling and
    // logging see the real cause.
    await run.fail(err instanceof Error ? err : new Error(String(err)))
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exitCode = 1
})
