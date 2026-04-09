/**
 * basic_run.ts
 *
 * Demonstrates the full SDK lifecycle using FlightRecorder (real HTTP calls)
 * and MockTransport (no server required, safe to run locally).
 *
 * --- Run against a live server ---
 *   AFR_API_KEY=your-key AFR_AGENT_ID=your-agent-id AFR_BASE_URL=http://localhost:3000 \
 *   pnpm tsx packages/sdk/examples/basic_run.ts --live
 *
 * --- Run with MockTransport (no server needed) ---
 *   pnpm tsx packages/sdk/examples/basic_run.ts
 *
 * --- Run with FlightRecorder (needs server) ---
 *   pnpm tsx packages/sdk/examples/basic_run.ts --flight-recorder
 */

import {
  Recorder,
  Events,
  HttpTransport,
  FlightRecorder,
  type Transport,
  type TransportAuth,
} from '@agent-flight-recorder/sdk'
import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
} from '@agent-flight-recorder/contracts'
import type { TransportResponse } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// MockTransport — logs to console instead of sending HTTP requests.
// Used when the example is run without --live flag.
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  private runCounter = 0
  private eventCounter = 0

  async createRun(req: CreateRunRequest, _auth: TransportAuth): Promise<CreateRunResponse> {
    this.runCounter++
    const runId = `run_mock_${this.runCounter.toString().padStart(3, '0')}`
    console.log(`[MockTransport] createRun → ${runId}`, { agentId: req.agentId, tags: req.tags })
    return {
      run: {
        id: runId,
        orgId: 'org_demo',
        projectId: 'proj_demo',
        agentId: req.agentId,
        agentVersionId: req.agentVersionId,
        status: 'running',
        startedAt: Date.now(),
        metadata: req.metadata ?? {},
        tags: req.tags ?? [],
        triggeredBy: req.triggeredBy,
        sdkVersion: req.sdkVersion,
      },
    }
  }

  async sendEvents(events: CreateEventRequest[], _auth: TransportAuth): Promise<TransportResponse> {
    this.eventCounter += events.length
    console.log(`[MockTransport] sendEvents — batch of ${events.length} (total so far: ${this.eventCounter})`)
    for (const evt of events) {
      console.log(`  seq=${evt.sequenceNumber}  type=${evt.type}`)
    }
    return { success: true, eventIds: events.map((_, i) => `evt_mock_${Date.now()}_${i}`) }
  }

  async updateRunStatus(runId: string, status: string, endedAt?: number, _auth?: TransportAuth): Promise<void> {
    console.log(`[MockTransport] updateRunStatus → ${runId} = ${status}  endedAt=${endedAt}`)
  }
}

// ---------------------------------------------------------------------------
// Happy-path run using Recorder + MockTransport
// ---------------------------------------------------------------------------

async function runHappyPath(transport: Transport) {
  console.log('\n=== Happy-path run (Recorder + MockTransport) ===\n')

  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000', // used by HttpTransport; ignored by MockTransport
      apiKey: process.env['AFR_API_KEY'] ?? 'demo_key_abc123',
      agentId: process.env['AFR_AGENT_ID'] ?? 'agent_support_bot',
      agentVersionId: 'ver_1_0_0',
      options: {
        flushIntervalMs: 5000,
        maxBatchSize: 50,
      },
    },
    transport
  )

  // Start a run — returns a RunContext with the assigned runId
  const runCtx = await recorder.startRun(
    { query: 'Help me track my order #98765' },
    { env: 'production', region: 'us-east-1' }
  )
  console.log('\nRun started:', runCtx.runId, '  agentId:', runCtx.agentId)

  // Record an LLM request event
  recorder.recordEvent(
    'llm.request',
    Events.llmRequest(
      'gpt-4o',
      [
        { role: 'system', content: 'You are a helpful support agent.' },
        { role: 'user', content: 'Help me track my order #98765' },
      ],
      { temperature: 0.3, max_tokens: 1024 }
    ).payload
  )
  console.log('Recorded llm.request')

  // Record an LLM response event
  recorder.recordEvent(
    'llm.response',
    Events.llmResponse(
      'gpt-4o',
      "I'll look up order #98765 for you right away.",
      { prompt_tokens: 42, completion_tokens: 14, total_tokens: 56 },
      'stop'
    ).payload
  )
  console.log('Recorded llm.response')

  // Record a tool call
  recorder.recordEvent(
    'tool.call',
    Events.toolCall(
      'lookup_order',
      { order_id: '98765' },
      'call_abc001'
    ).payload
  )
  console.log('Recorded tool.call')

  // Record the tool result
  recorder.recordEvent(
    'tool.result',
    Events.toolResult(
      'call_abc001',
      { order_id: '98765', status: 'shipped', eta: '2024-04-10' },
      120  // duration_ms
    ).payload
  )
  console.log('Recorded tool.result')

  // End the run — flushes all buffered events and marks the run completed
  const result = await recorder.endRun({
    reply: 'Your order #98765 has been shipped and is expected to arrive on April 10th.',
  })

  console.log('\nRun ended. FlushResult:', result)
  console.log('activeRun after endRun:', recorder.activeRun) // null
}

// ---------------------------------------------------------------------------
// Error-path run — demonstrates failRun
// ---------------------------------------------------------------------------

async function runErrorPath(transport: Transport) {
  console.log('\n=== Error-path run (Recorder + MockTransport) ===\n')

  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000',
      apiKey: process.env['AFR_API_KEY'] ?? 'demo_key_abc123',
      agentId: process.env['AFR_AGENT_ID'] ?? 'agent_support_bot',
    },
    transport
  )

  await recorder.startRun({ query: 'Trigger a failure' })
  console.log('Run started')

  recorder.recordEvent(
    'llm.request',
    Events.llmRequest('gpt-4o', [{ role: 'user', content: 'Trigger a failure' }]).payload
  )

  // Simulate an upstream error
  const upstreamError = new Error('LLM provider returned 503 Service Unavailable')

  // failRun records a run.failed event, flushes, and closes the run
  const result = await recorder.failRun(upstreamError)
  console.log('\nRun failed. FlushResult:', result)
  console.log('activeRun after failRun:', recorder.activeRun) // null
}

// ---------------------------------------------------------------------------
// FlightRecorder example — uses the high-level API against a real server.
// Only executed when --flight-recorder or --live flags are passed.
// ---------------------------------------------------------------------------

async function runFlightRecorder() {
  console.log('\n=== FlightRecorder example (live server) ===\n')

  const recorder = new FlightRecorder({
    apiKey: process.env['AFR_API_KEY'] ?? 'test-key',
    baseUrl: process.env['AFR_BASE_URL'] ?? 'http://localhost:3000',
    agentId: process.env['AFR_AGENT_ID'] ?? 'test-agent',
  })

  const run = await recorder.startRun({
    metadata: { model: 'gpt-4o', temperature: 0.7 },
    tags: ['example', 'demo'],
    triggeredBy: 'manual',
  })

  console.log(`Run started: ${run.runId}`)

  // Record a sequence of events
  await run.recordEvent('RUN_STARTED', { source: 'basic_run example' })
  await run.recordEvent('LLM_REQUEST', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Hello, agent!' }],
  })
  await run.recordEvent('LLM_RESPONSE', {
    model: 'gpt-4o',
    content: 'Hello! How can I help you today?',
    usage: { promptTokens: 10, completionTokens: 15 },
  })
  await run.recordEvent('RUN_COMPLETED', { duration_ms: 1234 })

  await run.complete()

  console.log(`Run completed: ${run.runId}`)
  console.log(
    `View at: ${process.env['AFR_BASE_URL'] ?? 'http://localhost:3000'}/runs/${run.runId}`
  )
}

// ---------------------------------------------------------------------------
// Entry point — selects transport based on CLI flags
// ---------------------------------------------------------------------------

;(async () => {
  const useLive = process.argv.includes('--live')
  const useFlightRecorder = process.argv.includes('--flight-recorder')

  if (useFlightRecorder || useLive) {
    console.log('Using FlightRecorder (live server at', process.env['AFR_BASE_URL'] ?? 'http://localhost:3000', ')')
    try {
      await runFlightRecorder()
      console.log('\nFlightRecorder example completed successfully.')
    } catch (err) {
      console.error('FlightRecorder example failed:', err)
      process.exit(1)
    }
  } else {
    console.log('Using MockTransport (no server required)')
    const transport = new MockTransport()

    try {
      await runHappyPath(transport)
      await runErrorPath(transport)
      console.log('\nAll examples completed successfully.')
    } catch (err) {
      console.error('Example failed:', err)
      process.exit(1)
    }
  }
})()
