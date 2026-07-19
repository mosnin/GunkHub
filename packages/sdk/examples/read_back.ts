/**
 * read_back.ts
 *
 * Demonstrates the full write-then-read round trip: record a run with the
 * SDK (as every other example does), then read it back through the public
 * v1 read API (`GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/events`,
 * `GET /api/v1/runs/:id/replay`) that `afr` (packages/cli) also uses.
 *
 * The SDK itself never reads a run back — it is a write-only recording
 * library — so this example intentionally steps outside `Recorder`/
 * `Transport` for the "read" half and talks to the v1 API directly with a
 * plain `fetch`, exactly the way any consumer (a script, a dashboard, the
 * `afr` CLI) would.
 *
 * --- Run with MockTransport + a simulated v1 API response (default) ---
 *   pnpm tsx packages/sdk/examples/read_back.ts
 *
 * --- Run against a live server for BOTH the write and the read ---
 *   AFR_API_KEY=your-key AFR_AGENT_ID=your-agent-id AFR_BASE_URL=http://localhost:3000 \
 *   pnpm tsx packages/sdk/examples/read_back.ts --live
 */

import { Recorder, Events, type Transport, type TransportAuth, type TransportResponse } from '@agent-flight-recorder/sdk'

import type { CreateEventRequest, CreateRunRequest, CreateRunResponse, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// MockTransport — same shape used by basic_run.ts. Used for the WRITE half
// when --live is not passed.
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  public lastRunId = ''

  async createRun(req: CreateRunRequest, _auth: TransportAuth): Promise<CreateRunResponse> {
    this.lastRunId = `run_readback_${Date.now()}`
    console.log(`[MockTransport] createRun -> ${this.lastRunId}`)
    return {
      run: {
        id: this.lastRunId,
        orgId: 'org_demo',
        projectId: 'proj_demo',
        agentId: req.agentId,
        status: 'running',
        startedAt: Date.now(),
        metadata: req.metadata ?? {},
        tags: req.tags ?? [],
      } as Run,
    }
  }

  async sendEvents(events: CreateEventRequest[], _auth: TransportAuth): Promise<TransportResponse> {
    console.log(`[MockTransport] sendEvents — batch of ${events.length}`)
    return { success: true, eventIds: events.map((_, i) => `evt_readback_${i}`) }
  }

  async updateRunStatus(runId: string, status: string, _endedAt?: number, _auth?: TransportAuth): Promise<TransportResponse> {
    console.log(`[MockTransport] updateRunStatus -> ${runId} = ${status}`)
    return { success: true, eventIds: [] }
  }
}

// ---------------------------------------------------------------------------
// v1 read API envelope shapes — mirrors packages/cli/src/apiClient.ts.
// Every v1 response is wrapped: `{ apiVersion, data }` on success,
// `{ apiVersion, error: { code, message } }` on failure. Auth is `x-api-key`
// with `read` scope (a write-scoped key from `startRun`/`recordEvent` above
// works here too, since `read` is implied by any valid key in this API).
// ---------------------------------------------------------------------------

interface V1Envelope<T> {
  apiVersion: string
  data: T
}

interface V1RunData {
  run: Run
  eventCount: number
  artifactCount: number
}

/** A canned response used when running without --live, so this example never needs a server. */
function fakeV1RunResponse(runId: string): V1Envelope<V1RunData> {
  return {
    apiVersion: 'v1',
    data: {
      run: {
        id: runId,
        orgId: 'org_demo',
        projectId: 'proj_demo',
        agentId: 'agent_readback_demo',
        status: 'completed',
        startedAt: Date.now() - 1500,
        endedAt: Date.now(),
        metadata: {},
        tags: [],
      },
      eventCount: 5,
      artifactCount: 0,
    },
  }
}

/** Read a run back through the real v1 API — used only with --live. */
async function fetchRunFromV1Api(baseUrl: string, apiKey: string, runId: string): Promise<V1Envelope<V1RunData>> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/runs/${runId}`, {
    headers: { 'x-api-key': apiKey },
  })
  if (!res.ok) {
    throw new Error(`GET /api/v1/runs/${runId} failed: HTTP ${res.status}`)
  }
  return (await res.json()) as V1Envelope<V1RunData>
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

(async () => {
  const useLive = process.argv.includes('--live')
  const baseUrl = process.env['AFR_BASE_URL'] ?? 'http://localhost:3000'
  const apiKey = process.env['AFR_API_KEY'] ?? 'demo_key_abc123'

  console.log('=== Write half: record a run with the SDK ===\n')

  const transport: Transport = useLive
    ? new (await import('@agent-flight-recorder/sdk')).HttpTransport(baseUrl)
    : new MockTransport()

  const recorder = new Recorder(
    { endpoint: baseUrl, apiKey, agentId: process.env['AFR_AGENT_ID'] ?? 'agent_readback_demo' },
    transport
  )

  const run = await recorder.startRun({ query: 'read-back demo' })
  console.log('Run started:', run.runId)

  recorder.recordEvent('llm.request', Events.llmRequest('demo-model', [{ role: 'user', content: 'hi' }]).payload)
  recorder.recordEvent(
    'llm.response',
    Events.llmResponse('demo-model', 'hello', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, 'stop').payload
  )

  const flush = await recorder.endRun({ ok: true })
  console.log('Run ended. success =', flush.success, ' eventsSubmitted =', flush.eventsSubmitted)

  console.log('\n=== Read half: read the same run back through the v1 API ===\n')
  console.log(`GET ${baseUrl}/api/v1/runs/${run.runId}   (header: x-api-key: <redacted>)`)

  const envelope = useLive
    ? await fetchRunFromV1Api(baseUrl, apiKey, run.runId)
    : fakeV1RunResponse(run.runId)

  if (!useLive) {
    console.log('(using a simulated v1 API response — no server required; pass --live to hit a real one)')
  }

  console.log('\napiVersion:', envelope.apiVersion)
  console.log('run.status:', envelope.data.run.status)
  console.log('eventCount:', envelope.data.eventCount)
  console.log(
    '\nThis is exactly the shape `afr runs get <runId> --json` prints, and what `afr replay`/`afr tail`/`afr export` build on — see packages/cli/src/apiClient.ts.'
  )

  console.log('\nRead-back round trip completed successfully.')
})().catch((err: unknown) => {
  console.error('read_back example failed:', err)
  process.exit(1)
})
