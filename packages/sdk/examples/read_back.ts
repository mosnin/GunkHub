/**
 * read_back.ts
 *
 * Demonstrates the full write-then-read round trip: record a run with the
 * SDK's `Recorder` (as every other example does), then read it back with the
 * SDK's own `FlightReader` — the typed client over the public v1 read API
 * (`GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/events`,
 * `GET /api/v1/runs/:id/replay`) that `afr` (packages/cli) is now a thin
 * wrapper over too (see `packages/cli/src/apiClient.ts`).
 *
 * Record-and-read is a single-package story: `Recorder` for the write half,
 * `FlightReader` for the read half, no separate HTTP client needed.
 *
 * --- Run with MockTransport + a simulated v1 API response (default) ---
 *   pnpm tsx packages/sdk/examples/read_back.ts
 *
 * --- Run against a live server for BOTH the write and the read ---
 *   AFR_API_KEY=your-key AFR_AGENT_ID=your-agent-id AFR_BASE_URL=http://localhost:3000 \
 *   pnpm tsx packages/sdk/examples/read_back.ts --live
 */

import {
  Recorder,
  Events,
  FlightReader,
  type Transport,
  type TransportAuth,
  type TransportResponse,
  type V1FetchLike,
} from '@agent-flight-recorder/sdk'

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
// Read half — `FlightReader`, the SDK's typed client over the v1 read API.
// Auth is `x-api-key` with `read` scope (a write-scoped key from
// `startRun`/`recordEvent` above works here too, since `read` is implied by
// any valid key with no `scopes` array — see docs/api_reference.md).
//
// Without --live, `FlightReader` is given a fake `fetchImpl` that returns a
// canned envelope, so this example never needs a real server.
// ---------------------------------------------------------------------------

/** A canned `fetchImpl` used when running without --live, so this example never needs a server. */
function fakeV1Fetch(runId: string): V1FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
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
          } satisfies Run,
          eventCount: 5,
          artifactCount: 0,
        },
      }
    },
    async text() {
      return '(see json())'
    },
    headers: { get: () => null },
  })
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

  console.log('\n=== Read half: read the same run back with FlightReader ===\n')
  console.log(`FlightReader.getRun(${run.runId})   GET ${baseUrl}/api/v1/runs/${run.runId}   (header: x-api-key: <redacted>)`)

  const reader = new FlightReader({ baseUrl, apiKey }, useLive ? undefined : fakeV1Fetch(run.runId))

  if (!useLive) {
    console.log('(using a simulated v1 API response — no server required; pass --live to hit a real one)')
  }

  const { run: readRun, eventCount } = await reader.getRun(run.runId)

  console.log('\napiVersion: v1')
  console.log('run.status:', readRun.status)
  console.log('eventCount:', eventCount)
  console.log(
    '\nThis is the same `FlightReader` that `afr runs get <runId> --json` prints, and that `afr replay`/`afr tail`/`afr export` build on — see packages/cli/src/apiClient.ts.'
  )

  console.log('\nRead-back round trip completed successfully.')
})().catch((err: unknown) => {
  console.error('read_back example failed:', err)
  process.exit(1)
})
