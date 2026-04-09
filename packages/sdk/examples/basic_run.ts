/**
 * basic_run.ts
 *
 * Demonstrates the full SDK lifecycle:
 *   startRun → recordEvent (llm.request, llm.response, tool.call, tool.result)
 *            → endRun
 *            → failRun (error path)
 *
 * Uses a MockTransport so this can be run without a live server:
 *   pnpm tsx packages/sdk/examples/basic_run.ts
 */

import {
  Recorder,
  Events,
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
// MockTransport — logs to console instead of sending HTTP requests
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
// Happy-path run
// ---------------------------------------------------------------------------

async function runHappyPath() {
  console.log('\n=== Happy-path run ===\n')

  // 1. Create a recorder with the mock transport
  const transport = new MockTransport()
  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000', // not used by MockTransport
      apiKey: 'demo_key_abc123',
      agentId: 'agent_support_bot',
      agentVersionId: 'ver_1_0_0',
      options: {
        flushIntervalMs: 5000,  // flush every 5 s in real use
        maxBatchSize: 50,
      },
    },
    transport
  )

  // 2. Start a run — returns a RunContext with the assigned runId
  const runCtx = await recorder.startRun(
    { query: 'Help me track my order #98765' },
    { env: 'production', region: 'us-east-1' }
  )
  console.log('\nRun started:', runCtx.runId, '  agentId:', runCtx.agentId)

  // 3. Record an LLM request event
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

  // 4. Record an LLM response event
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

  // 5. Record a tool call (looking up the order)
  recorder.recordEvent(
    'tool.call',
    Events.toolCall(
      'lookup_order',
      { order_id: '98765' },
      'call_abc001'
    ).payload
  )
  console.log('Recorded tool.call')

  // 6. Record the tool result
  recorder.recordEvent(
    'tool.result',
    Events.toolResult(
      'call_abc001',
      { order_id: '98765', status: 'shipped', eta: '2024-04-10' },
      120  // duration_ms
    ).payload
  )
  console.log('Recorded tool.result')

  // 7. End the run — flushes all buffered events and marks the run completed
  const result = await recorder.endRun({
    reply: 'Your order #98765 has been shipped and is expected to arrive on April 10th.',
  })

  console.log('\nRun ended. FlushResult:', result)
  console.log('activeRun after endRun:', recorder.activeRun) // should be null
}

// ---------------------------------------------------------------------------
// Error-path run — demonstrates failRun
// ---------------------------------------------------------------------------

async function runErrorPath() {
  console.log('\n=== Error-path run ===\n')

  const transport = new MockTransport()
  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000',
      apiKey: 'demo_key_abc123',
      agentId: 'agent_support_bot',
    },
    transport
  )

  await recorder.startRun({ query: 'Trigger a failure' })
  console.log('Run started')

  // Record an LLM request that leads to a failure
  recorder.recordEvent(
    'llm.request',
    Events.llmRequest('gpt-4o', [{ role: 'user', content: 'Trigger a failure' }]).payload
  )

  // Simulate an upstream error
  const upstreamError = new Error('LLM provider returned 503 Service Unavailable')

  // failRun records a run.failed event, flushes, and closes the run
  const result = await recorder.failRun(upstreamError)
  console.log('\nRun failed. FlushResult:', result)
  console.log('activeRun after failRun:', recorder.activeRun) // should be null
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

;(async () => {
  try {
    await runHappyPath()
    await runErrorPath()
    console.log('\nAll examples completed successfully.')
  } catch (err) {
    console.error('Example failed:', err)
    process.exit(1)
  }
})()
