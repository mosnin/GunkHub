/**
 * llm_agent_loop.ts
 *
 * Instrumenting a realistic agent loop: an LLM call, a tool call the model
 * asked for, feeding the tool result back, and a final LLM response — plus
 * the error path when a tool blows up.
 *
 * This is the pattern to copy when wiring Agent Flight Recorder into an
 * actual agent: call the typed `Events.*` builders to get well-formed
 * payloads, then hand `.payload` to `recorder.recordEvent(type, payload)`.
 *
 * Run (no server required — uses MockTransport):
 *   pnpm tsx packages/sdk/examples/llm_agent_loop.ts
 */

import {
  Recorder,
  Events,
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
// MockTransport — see basic_run.ts for the same pattern. In a real agent you
// would omit the second constructor argument and let Recorder build its own
// HttpTransport pointed at your Agent Flight Recorder deployment.
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  private runCounter = 0

  async createRun(req: CreateRunRequest, _auth: TransportAuth): Promise<CreateRunResponse> {
    this.runCounter++
    const runId = `run_loop_${this.runCounter.toString().padStart(3, '0')}`
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
    for (const evt of events) {
      console.log(`  [sent] seq=${evt.sequenceNumber} type=${evt.type}`)
    }
    return { success: true, eventIds: events.map((_, i) => `evt_${Date.now()}_${i}`) }
  }

  async updateRunStatus(runId: string, status: string): Promise<TransportResponse> {
    console.log(`  [status] ${runId} -> ${status}`)
    return { success: true, eventIds: [] }
  }
}

// ---------------------------------------------------------------------------
// Fake tool + fake LLM client, standing in for your real provider SDK and
// real tool implementations. Swap these for `openai.chat.completions.create`,
// `anthropic.messages.create`, your retrieval call, etc.
// ---------------------------------------------------------------------------

interface FakeToolCall {
  name: string
  input: Record<string, unknown>
  callId: string
}

async function fakeLlmCall(_messages: Array<{ role: string; content: string }>): Promise<{
  content: string
  toolCall?: FakeToolCall
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}> {
  // Pretend the model decided to call a tool on the first turn.
  return {
    content: '',
    toolCall: { name: 'lookup_order', input: { order_id: '98765' }, callId: 'call_001' },
    usage: { prompt_tokens: 58, completion_tokens: 22, total_tokens: 80 },
  }
}

async function fakeTool(call: FakeToolCall): Promise<unknown> {
  if (call.name !== 'lookup_order') {
    throw Object.assign(new Error(`Unknown tool: ${call.name}`), { code: 'UNKNOWN_TOOL' })
  }
  // Simulate a downstream failure some fraction of the time. Flip this to
  // `true` to see the error path exercised.
  const shouldFail = false
  if (shouldFail) {
    throw Object.assign(new Error('Order service timed out'), { code: 'UPSTREAM_TIMEOUT' })
  }
  return { order_id: call.input['order_id'], status: 'shipped', eta: '2024-04-10' }
}

// ---------------------------------------------------------------------------
// The instrumented agent loop.
// ---------------------------------------------------------------------------

async function runAgentLoop(recorder: Recorder, userMessage: string): Promise<void> {
  await recorder.startRun({ query: userMessage })

  const messages = [
    { role: 'system', content: 'You are a helpful support agent.' },
    { role: 'user', content: userMessage },
  ]

  try {
    // 1. LLM turn — record the request BEFORE calling the provider, so the
    //    request is on the timeline even if the call itself throws.
    recorder.recordEvent('llm.request', Events.llmRequest('gpt-4o', messages, { temperature: 0.3 }).payload)
    const first = await fakeLlmCall(messages)
    recorder.recordEvent(
      'llm.response',
      Events.llmResponse('gpt-4o', first.content || '(tool call)', first.usage, first.toolCall ? 'tool_calls' : 'stop').payload
    )

    if (first.toolCall) {
      // 2. Tool turn — record the call, execute it, record the result (or let
      //    a thrown error propagate to the outer catch, which fails the run).
      recorder.recordEvent(
        'tool.call',
        Events.toolCall(first.toolCall.name, first.toolCall.input, first.toolCall.callId).payload
      )
      const startedAt = Date.now()
      const output = await fakeTool(first.toolCall)
      recorder.recordEvent(
        'tool.result',
        Events.toolResult(first.toolCall.callId, output, Date.now() - startedAt).payload
      )

      // 3. Feed the tool result back to the model for a final answer.
      const followUp = [...messages, { role: 'tool', content: JSON.stringify(output) }]
      recorder.recordEvent('llm.request', Events.llmRequest('gpt-4o', followUp).payload)
      const final = {
        content: 'Your order has shipped and should arrive on 2024-04-10.',
        usage: { prompt_tokens: 96, completion_tokens: 18, total_tokens: 114 },
      }
      recorder.recordEvent('llm.response', Events.llmResponse('gpt-4o', final.content, final.usage, 'stop').payload)

      const result = await recorder.endRun({ reply: final.content })
      console.log('Run completed:', result.success ? 'ok' : result.errors)
    } else {
      const result = await recorder.endRun({ reply: first.content })
      console.log('Run completed:', result.success ? 'ok' : result.errors)
    }
  } catch (err) {
    // Error path: failRun() accepts either an `Error` or a plain
    // `{ message, code? }` object.
    //
    // GOTCHA (verified against the current recorder.ts implementation):
    // failRun only copies `.code` onto the recorded run.failed payload when
    // the value passed does NOT have a `.stack` property. A real `Error`
    // instance (like the one `fakeTool` throws above, with `.code` attached
    // via `Object.assign`) always has `.stack`, so passing it straight
    // through SILENTLY DROPS `.code` — only `message` + `stack` are recorded.
    // To preserve a tool/provider error code, extract it into a plain object
    // yourself, as done below. See README "Instrumenting popular agent
    // shapes" for the same pattern applied to a real provider SDK.
    const code = err instanceof Error && 'code' in err ? (err as Error & { code?: string }).code : undefined
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown agent error'
    console.error('Agent loop failed:', message, code ? `(code=${code})` : '')

    const result = code !== undefined
      ? await recorder.failRun({ message, code }) // plain object: code IS preserved
      : await recorder.failRun(err instanceof Error ? err : new Error(message)) // Error: stack IS preserved

    console.log('Run failed. FlushResult:', result)
  }
}

async function main(): Promise<void> {
  const transport = new MockTransport()
  const recorder = new Recorder(
    {
      endpoint: 'http://localhost:3000',
      apiKey: process.env['AFR_API_KEY'] ?? 'demo_key_abc123',
      agentId: process.env['AFR_AGENT_ID'] ?? 'agent_support_bot',
    },
    transport
  )

  console.log('=== Running instrumented agent loop ===')
  await runAgentLoop(recorder, 'Where is my order #98765?')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exitCode = 1
})
