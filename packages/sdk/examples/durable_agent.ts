/**
 * durable_agent.ts
 *
 * PRODUCTION-SHAPE usage of `Recorder`: the shape you'd actually run in a
 * long-lived worker or a Lambda that gets reused across invocations.
 *
 * What this demonstrates that `basic_run.ts` does not:
 *   1. A `FileSpool` write-ahead log, so buffered events survive a process
 *      crash (SIGKILL, OOM, power loss) instead of living only in memory.
 *   2. `recorder.recover()` on startup, BEFORE any new run is started — this
 *      re-sends anything a previous process crashed before delivering.
 *   3. `onDrop` / `onFlushError` / `onSpoolError` wired to real logging, so
 *      telemetry loss is observable instead of silent.
 *   4. `captureProcessExit: true`, so a `beforeExit` best-effort flush and an
 *      `uncaughtException` -> failRun handler are installed automatically.
 *   5. A try/catch/finally around the actual agent work that always ends the
 *      run — completed on the happy path, failed on the error path — so a run
 *      is never left dangling in "running" state.
 *
 * Run (no server required — uses MockTransport under the hood):
 *   pnpm tsx packages/sdk/examples/durable_agent.ts
 *
 * Run against a live server:
 *   AFR_API_KEY=... AFR_AGENT_ID=... AFR_BASE_URL=http://localhost:3000 \
 *   pnpm tsx packages/sdk/examples/durable_agent.ts --live
 */

import * as os from 'node:os'
import * as path from 'node:path'

import {
  Recorder,
  Events,
  FileSpool,
  HttpTransport,
  type Transport,
  type TransportAuth,
  type TransportResponse,
} from '@agent-flight-recorder/sdk'

import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// MockTransport — stands in for HttpTransport so this example runs without a
// server. Swap in real `HttpTransport` (see bottom of file) for production.
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  private runCounter = 0

  async createRun(req: CreateRunRequest, _auth: TransportAuth): Promise<CreateRunResponse> {
    this.runCounter++
    const runId = `run_durable_${this.runCounter.toString().padStart(3, '0')}`
    console.log(`[MockTransport] createRun -> ${runId}`)
    return {
      run: {
        id: runId,
        orgId: 'org_demo',
        projectId: 'proj_demo',
        agentId: req.agentId,
        // exactOptionalPropertyTypes: only spread optional fields when defined
        ...(req.agentVersionId !== undefined && { agentVersionId: req.agentVersionId }),
        status: 'running',
        startedAt: Date.now(),
        metadata: req.metadata ?? {},
        tags: req.tags ?? [],
        ...(req.triggeredBy !== undefined && { triggeredBy: req.triggeredBy }),
        ...(req.sdkVersion !== undefined && { sdkVersion: req.sdkVersion }),
      },
    }
  }

  async sendEvents(events: CreateEventRequest[], _auth: TransportAuth): Promise<TransportResponse> {
    console.log(`[MockTransport] sendEvents — ${events.length} event(s)`)
    return { success: true, eventIds: events.map((_, i) => `evt_${Date.now()}_${i}`) }
  }

  async updateRunStatus(runId: string, status: string): Promise<TransportResponse> {
    console.log(`[MockTransport] updateRunStatus -> ${runId} = ${status}`)
    return { success: true, eventIds: [] }
  }
}

// ---------------------------------------------------------------------------
// Build a Recorder the way you would in production: FileSpool + observability
// callbacks + captureProcessExit. This is the config block worth copy/pasting.
// ---------------------------------------------------------------------------

function buildDurableRecorder(transport: Transport): Recorder {
  // In production, use a stable path per worker — e.g. include a worker/shard
  // ID so concurrent workers never share one spool file (FileSpool is
  // deliberately flock-free: one recorder, one process, one path).
  const spoolPath = path.join(os.tmpdir(), 'afr-example-spool', 'worker-1.jsonl')

  return new Recorder(
    {
      endpoint: process.env['AFR_BASE_URL'] ?? 'http://localhost:3000',
      apiKey: process.env['AFR_API_KEY'] ?? 'demo_key_abc123',
      agentId: process.env['AFR_AGENT_ID'] ?? 'agent_durable_worker',
      options: {
        // Durability: every recordEvent() is write-ahead logged here before
        // delivery is attempted. Survives a process crash (not a kernel panic
        // / power loss unless you also pass `{ fsync: true }`).
        spool: new FileSpool(spoolPath),

        // Observability: telemetry loss must never be silent. These are the
        // three ways the recorder can lose or fail to deliver events.
        onDrop: (count, reason) => {
          // reason is 'buffer_overflow' | 'spool_overflow' | 'rejected_by_server'
          console.warn(`[afr] DROPPED ${count} event(s): ${reason}`)
        },
        onFlushError: (error) => {
          console.warn(`[afr] background flush failed: ${error}`)
        },
        onSpoolError: (error) => {
          console.warn(`[afr] spool I/O failed (best-effort, non-fatal): ${error}`)
        },

        // Graceful shutdown: installs `beforeExit` (best-effort flush) and
        // `uncaughtException` (mark the active run failed, then flush)
        // handlers. Does NOT call process.exit and does NOT intercept
        // SIGINT/SIGTERM — the host's own shutdown behavior is untouched.
        captureProcessExit: true,

        debug: process.env['AFR_DEBUG'] === '1',
      },
    },
    transport
  )
}

// ---------------------------------------------------------------------------
// Pretend "agent work" — replace with your real agent loop.
// ---------------------------------------------------------------------------

async function doAgentWork(recorder: Recorder, input: string): Promise<string> {
  recorder.recordEvent(
    'llm.request',
    Events.llmRequest('gpt-4o', [{ role: 'user', content: input }], { temperature: 0.2 }).payload
  )

  // ... call your real LLM provider here ...
  const reply = `Acknowledged: ${input}`

  recorder.recordEvent(
    'llm.response',
    Events.llmResponse(
      'gpt-4o',
      reply,
      { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      'stop'
    ).payload
  )

  return reply
}

// ---------------------------------------------------------------------------
// Main: recover() first, then run the agent, always ending the run.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const useLive = process.argv.includes('--live')
  const transport: Transport = useLive ? new HttpTransport(process.env['AFR_BASE_URL'] ?? 'http://localhost:3000') : new MockTransport()

  const recorder = buildDurableRecorder(transport)

  // CRITICAL: call recover() BEFORE startRun(). It drains anything a PREVIOUS
  // process left in the spool (e.g. it crashed mid-flush) and re-sends it.
  // Calling this after starting new runs risks racing recover()'s peek against
  // concurrent spool appends from the new run.
  const recovered = await recorder.recover()
  if (recovered.eventsSubmitted > 0 || recovered.errors.length > 0) {
    console.log('[afr] recover():', recovered)
  }

  let outcome: 'completed' | 'failed' = 'completed'
  try {
    await recorder.startRun({ query: 'process this input' }, { worker: 'worker-1' })

    const reply = await doAgentWork(recorder, 'What is the status of order #98765?')
    console.log('Agent replied:', reply)

    // Happy path: flush + mark completed.
    const result = await recorder.endRun({ reply })
    if (!result.success) {
      // endRun() never throws on delivery failure — it returns a FlushResult
      // instead, so a slow/degraded server never crashes the agent. Errors
      // here mean telemetry (not the agent's actual output) may be delayed;
      // decide for yourself whether that should page anyone.
      console.warn('[afr] endRun reported delivery problems:', result.errors)
    }
  } catch (err) {
    outcome = 'failed'
    // Error path: record why, flush, and mark failed. Always call failRun()
    // in the catch/finally of your agent's top-level work — an uncaught
    // exception without it leaves the run "running" forever (unless
    // captureProcessExit's uncaughtException handler catches it first, which
    // is a safety net, not a substitute for handling errors explicitly here).
    if (recorder.activeRun) {
      const result = await recorder.failRun(err instanceof Error ? err : new Error(String(err)))
      if (!result.success) {
        console.warn('[afr] failRun reported delivery problems:', result.errors)
      }
    }
    console.error('Agent run failed:', err)
  } finally {
    console.log(`Run finished with outcome: ${outcome}`)
    // Optional but recommended before process exit in a script (as opposed to
    // a long-lived server): flush anything the timer hasn't caught yet and
    // remove the process handlers we installed.
    await recorder.shutdown()
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exitCode = 1
})
