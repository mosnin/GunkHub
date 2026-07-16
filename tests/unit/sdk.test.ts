import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Recorder, Events, buildEvent } from '@agent-flight-recorder/sdk'
import type { Transport, TransportAuth } from '@agent-flight-recorder/sdk'
import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// Mock transport factory
// ---------------------------------------------------------------------------

const createMockTransport = (): Transport => ({
  createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
    run: {
      id: 'run_test_001',
      orgId: 'org_test',
      projectId: 'proj_test',
      agentId: req.agentId,
      agentVersionId: req.agentVersionId,
      status: 'running',
      startedAt: Date.now(),
      metadata: req.metadata ?? {},
      tags: req.tags ?? [],
      triggeredBy: req.triggeredBy,
      sdkVersion: req.sdkVersion,
    },
  })),
  sendEvents: vi.fn(async (_events: CreateEventRequest[], _auth: TransportAuth) => ({
    success: true as const,
    eventIds: _events.map((_, i) => `evt_mock_${i}`),
  })),
  updateRunStatus: vi.fn(async () => {}),
})

// ---------------------------------------------------------------------------
// Recorder tests
// ---------------------------------------------------------------------------

describe('Recorder', () => {
  let transport: Transport
  let recorder: Recorder

  beforeEach(() => {
    transport = createMockTransport()
    recorder = new Recorder(
      { endpoint: 'http://localhost:3000', apiKey: 'test_key', agentId: 'agent_test' },
      transport
    )
  })

  it('has no active run before startRun', () => {
    expect(recorder.activeRun).toBeNull()
  })

  it('throws when recordEvent called before startRun', () => {
    expect(() => recorder.recordEvent('custom', { type: 'custom', data: 'test' })).toThrow('No active run')
  })

  it('throws when endRun called before startRun', async () => {
    await expect(recorder.endRun('output')).rejects.toThrow('No active run')
  })

  it('throws when failRun called before startRun', async () => {
    await expect(recorder.failRun(new Error('oops'))).rejects.toThrow('No active run')
  })

  it('sets active run after startRun', async () => {
    await recorder.startRun('test input')
    expect(recorder.activeRun).not.toBeNull()
    expect(recorder.activeRun?.agentId).toBe('agent_test')
  })

  it('active run has correct runId from transport response', async () => {
    await recorder.startRun('test input')
    expect(recorder.activeRun?.runId).toBe('run_test_001')
  })

  it('active run status is running after startRun', async () => {
    await recorder.startRun('test input')
    expect(recorder.activeRun?.status).toBe('running')
  })

  it('calls transport.createRun with correct agentId', async () => {
    await recorder.startRun('input')
    expect(transport.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_test' }),
      expect.any(Object)
    )
  })

  it('calls transport.createRun with apiKey in auth', async () => {
    await recorder.startRun('input')
    expect(transport.createRun).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ apiKey: 'test_key' })
    )
  })

  it('passes run config as metadata to createRun', async () => {
    await recorder.startRun('input', { env: 'test', region: 'us-west-2' })
    expect(transport.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { env: 'test', region: 'us-west-2' } }),
      expect.any(Object)
    )
  })

  it('clears active run after endRun', async () => {
    await recorder.startRun('input')
    await recorder.endRun('output')
    expect(recorder.activeRun).toBeNull()
  })

  it('clears active run after failRun', async () => {
    await recorder.startRun('input')
    await recorder.failRun(new Error('boom'))
    expect(recorder.activeRun).toBeNull()
  })

  it('calls transport.updateRunStatus with completed on endRun', async () => {
    await recorder.startRun('input')
    await recorder.endRun('output')
    expect(transport.updateRunStatus).toHaveBeenCalledWith(
      'run_test_001',
      'completed',
      expect.any(Number),
      expect.any(Object)
    )
  })

  it('calls transport.updateRunStatus with failed on failRun', async () => {
    await recorder.startRun('input')
    await recorder.failRun(new Error('something broke'))
    expect(transport.updateRunStatus).toHaveBeenCalledWith(
      'run_test_001',
      'failed',
      expect.any(Number),
      expect.any(Object)
    )
  })

  it('calls transport.sendEvents during flush', async () => {
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'hello' })
    await recorder.flush()
    expect(transport.sendEvents).toHaveBeenCalled()
  })

  it('flush returns success with eventsSubmitted count', async () => {
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'a' })
    recorder.recordEvent('custom', { type: 'custom', data: 'b' })
    // startRun auto-records run.started, plus our 2 custom events
    const result = await recorder.flush()
    expect(result.success).toBe(true)
    expect(result.eventsSubmitted).toBeGreaterThanOrEqual(2)
    expect(result.errors).toHaveLength(0)
  })

  it('flush on empty buffer returns success with 0 events', async () => {
    await recorder.startRun('input')
    // Flush once to clear the run.started event
    await recorder.flush()
    // Second flush — buffer should be empty
    const result = await recorder.flush()
    expect(result.success).toBe(true)
    expect(result.eventsSubmitted).toBe(0)
  })

  it('endRun FlushResult reports events submitted', async () => {
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'x' })
    const result = await recorder.endRun('done')
    expect(result.success).toBe(true)
    // run.started + custom + run.completed
    expect(result.eventsSubmitted).toBeGreaterThanOrEqual(3)
  })

  it('cannot start a second run while one is active', async () => {
    await recorder.startRun('first input')
    await expect(recorder.startRun('second input')).rejects.toThrow('already active')
  })

  it('can start a new run after endRun completes', async () => {
    await recorder.startRun('first input')
    await recorder.endRun('first output')
    // Should not throw
    await expect(recorder.startRun('second input')).resolves.toBeDefined()
  })

  // --- Durability regression tests (audit Phase 0 / gate finding) ------------

  it('does not drop events when a flush fails — batch is retried on next flush', async () => {
    // First sendEvents fails, second succeeds. The failed batch must survive.
    const sent: number[] = []
    let call = 0
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => {
        call += 1
        if (call === 1) {
          return { success: false as const, error: 'network down', retryable: true }
        }
        sent.push(...events.map((e) => e.sequenceNumber))
        return { success: true as const, eventIds: events.map((_, i) => `e${i}`) }
      },
    )

    await recorder.startRun('input') // records run.started (seq 1)
    recorder.recordEvent('custom', { type: 'custom', data: 'a' }) // seq 2
    const first = await recorder.flush()
    expect(first.success).toBe(false) // failed — but not lost

    recorder.recordEvent('custom', { type: 'custom', data: 'b' }) // seq 3
    const second = await recorder.flush()
    expect(second.success).toBe(true)
    // All three events reach the server, in ascending sequence order.
    expect(sent).toEqual([1, 2, 3])
  })

  it('shutdown() flushes buffered events and stops the flush timer', async () => {
    const sent: number[] = []
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => {
        sent.push(...events.map((e) => e.sequenceNumber))
        return { success: true as const, eventIds: events.map((_, i) => `e${i}`) }
      },
    )
    await recorder.startRun('input') // seq 1 (run.started)
    recorder.recordEvent('custom', { type: 'custom', data: 'a' }) // seq 2
    const result = await recorder.shutdown()
    expect(result.success).toBe(true)
    expect(sent).toContain(1)
    expect(sent).toContain(2)
  })

  it('serializes concurrent failing flushes so the buffer stays in sequence order', async () => {
    // Both flushes fail; without serialization the LIFO unshift would reorder the
    // buffer to [later..., earlier...]. Serialized, order is preserved.
    let call = 0
    const captured: number[][] = []
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => {
        call += 1
        captured.push(events.map((e) => e.sequenceNumber))
        if (call <= 2) return { success: false as const, error: 'down', retryable: true }
        return { success: true as const, eventIds: events.map((_, i) => `e${i}`) }
      },
    )

    await recorder.startRun('input') // seq 1
    recorder.recordEvent('custom', { type: 'custom', data: 'a' }) // seq 2
    const p1 = recorder.flush()
    recorder.recordEvent('custom', { type: 'custom', data: 'b' }) // seq 3
    const p2 = recorder.flush()
    await Promise.all([p1, p2])

    // A final flush drains whatever remains; it must be globally ascending.
    await recorder.flush()
    const finalBatch = captured[captured.length - 1]!
    const ascending = [...finalBatch].sort((a, b) => a - b)
    expect(finalBatch).toEqual(ascending)
  })
})

// ---------------------------------------------------------------------------
// Events builders
// ---------------------------------------------------------------------------

describe('Events builders', () => {
  it('llmRequest returns correct type', () => {
    const e = Events.llmRequest('gpt-4o', [{ role: 'user', content: 'hi' }])
    expect(e.type).toBe('llm.request')
    expect(e.payload.model).toBe('gpt-4o')
  })

  it('llmRequest payload includes messages', () => {
    const messages = [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }]
    const e = Events.llmRequest('gpt-4o', messages)
    expect(e.payload.messages).toHaveLength(2)
  })

  it('llmRequest includes optional temperature and max_tokens', () => {
    const e = Events.llmRequest('gpt-4o', [{ role: 'user', content: 'hi' }], { temperature: 0.5, max_tokens: 512 })
    expect(e.payload.temperature).toBe(0.5)
    expect(e.payload.max_tokens).toBe(512)
  })

  it('llmResponse returns correct type', () => {
    const e = Events.llmResponse('gpt-4o', 'Hello!', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, 'stop')
    expect(e.type).toBe('llm.response')
    expect(e.payload.content).toBe('Hello!')
    expect(e.payload.finish_reason).toBe('stop')
  })

  it('llmResponse usage tokens are preserved', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    const e = Events.llmResponse('gpt-4o', 'x', usage, 'stop')
    expect(e.payload.usage.total_tokens).toBe(150)
  })

  it('toolCall returns correct type', () => {
    const e = Events.toolCall('search', { q: 'test' }, 'call_1')
    expect(e.type).toBe('tool.call')
    expect(e.payload.call_id).toBe('call_1')
  })

  it('toolCall payload preserves tool name and input', () => {
    const e = Events.toolCall('lookup_order', { order_id: '42' }, 'call_x')
    expect(e.payload.name).toBe('lookup_order')
    expect(e.payload.input).toEqual({ order_id: '42' })
  })

  it('toolResult returns correct type and duration', () => {
    const e = Events.toolResult('call_1', { result: 'ok' }, 88)
    expect(e.type).toBe('tool.result')
    expect(e.payload.duration_ms).toBe(88)
    expect(e.payload.call_id).toBe('call_1')
  })

  it('runFailed includes error message', () => {
    const e = Events.runFailed('run_1', { message: 'Timeout' }, 5000)
    expect(e.type).toBe('run.failed')
    expect(e.payload.error.message).toBe('Timeout')
  })

  it('runFailed includes duration_ms', () => {
    const e = Events.runFailed('run_1', { message: 'oops', code: 'ERR_503' }, 2500)
    expect(e.payload.duration_ms).toBe(2500)
  })

  it('runCompleted includes output and duration_ms', () => {
    const e = Events.runCompleted('run_1', { answer: 'done' }, 1234)
    expect(e.type).toBe('run.completed')
    expect(e.payload.duration_ms).toBe(1234)
    expect(e.payload.output).toEqual({ answer: 'done' })
  })

  it('custom event preserves data', () => {
    const e = Events.custom({ step: 'routing', decision: 'support' })
    expect(e.type).toBe('custom')
    expect(e.payload.data).toEqual({ step: 'routing', decision: 'support' })
  })

  it('httpRequest returns correct type', () => {
    const e = Events.httpRequest('GET', 'https://api.example.com/orders', ['Authorization'])
    expect(e.type).toBe('http.request')
    expect(e.payload.method).toBe('GET')
    expect(e.payload.url).toBe('https://api.example.com/orders')
  })

  it('httpResponse returns correct type and status', () => {
    const e = Events.httpResponse(200, ['Content-Type'], 1024, 55)
    expect(e.type).toBe('http.response')
    expect(e.payload.status).toBe(200)
    expect(e.payload.duration_ms).toBe(55)
  })
})

// ---------------------------------------------------------------------------
// buildEvent
// ---------------------------------------------------------------------------

describe('buildEvent', () => {
  it('fills timestamp default', () => {
    const before = Date.now()
    const event = buildEvent('run_1', 'org_1', 'custom', { type: 'custom', data: null }, 1)
    expect(event.timestamp).toBeGreaterThanOrEqual(before)
    expect(event.timestamp).toBeLessThanOrEqual(Date.now())
  })

  it('uses provided sequenceNumber', () => {
    const event = buildEvent('run_1', 'org_1', 'custom', { type: 'custom', data: null }, 42)
    expect(event.sequenceNumber).toBe(42)
  })

  it('uses provided timestamp when given', () => {
    const ts = 1712500000000
    const event = buildEvent('run_1', 'org_1', 'custom', { type: 'custom', data: null }, 1, { timestamp: ts })
    expect(event.timestamp).toBe(ts)
  })

  it('sets runId correctly', () => {
    const event = buildEvent('run_abc', 'org_xyz', 'custom', { type: 'custom', data: null }, 7)
    expect(event.runId).toBe('run_abc')
  })

  it('sets type correctly', () => {
    const event = buildEvent('run_1', 'org_1', 'llm.request', {
      type: 'llm.request',
      model: 'gpt-4o',
      messages: [],
    }, 1)
    expect(event.type).toBe('llm.request')
  })

  it('sets parentEventId when provided', () => {
    const event = buildEvent('run_1', 'org_1', 'tool.result', {
      type: 'tool.result',
      call_id: 'c1',
      output: null,
      duration_ms: 0,
    }, 3, { parentEventId: 'evt_parent_001' })
    expect(event.parentEventId).toBe('evt_parent_001')
  })

  it('parentEventId is undefined when not provided', () => {
    const event = buildEvent('run_1', 'org_1', 'custom', { type: 'custom', data: null }, 1)
    expect(event.parentEventId).toBeUndefined()
  })
})
