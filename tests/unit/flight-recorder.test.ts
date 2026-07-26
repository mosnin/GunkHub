import { FlightRecorder, RunRecorder } from '@agent-flight-recorder/sdk'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchMockImpl = (url: string, init?: RequestInit) => Promise<Response>
type FetchArgs = Parameters<FetchMockImpl>

function makeMockFetch(impl: FetchMockImpl) {
  return vi.fn(impl)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// FlightRecorder tests
// ---------------------------------------------------------------------------

describe('FlightRecorder', () => {
  let mockFetch: ReturnType<typeof makeMockFetch>

  beforeEach(() => {
    mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'run_test_fr_001' } })
      }
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('strips trailing slash from baseUrl', () => {
    const fr = new FlightRecorder({
      apiKey: 'key',
      baseUrl: 'http://localhost:3000/',
      agentId: 'agent',
    })
    expect(fr.baseUrl).toBe('http://localhost:3000')
  })

  it('keeps baseUrl without trailing slash unchanged', () => {
    const fr = new FlightRecorder({
      apiKey: 'key',
      baseUrl: 'https://example.com',
      agentId: 'agent',
    })
    expect(fr.baseUrl).toBe('https://example.com')
  })

  it('startRun calls POST /api/runs', async () => {
    const fr = new FlightRecorder({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000',
      agentId: 'agent_1',
    })
    await fr.startRun()
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/runs',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('startRun sends correct x-api-key header', async () => {
    const fr = new FlightRecorder({
      apiKey: 'secret-api-key',
      baseUrl: 'http://localhost:3000',
      agentId: 'agent_1',
    })
    await fr.startRun()
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('secret-api-key')
  })

  it('startRun sends Content-Type: application/json', async () => {
    const fr = new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://localhost:3000',
      agentId: 'a',
    })
    await fr.startRun()
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('startRun sends agentId in request body', async () => {
    const fr = new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://localhost:3000',
      agentId: 'my-agent',
    })
    await fr.startRun()
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['agentId']).toBe('my-agent')
  })

  it('startRun sends metadata when provided', async () => {
    const fr = new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://localhost:3000',
      agentId: 'a',
    })
    await fr.startRun({ metadata: { model: 'gpt-4o', temperature: 0.7 } })
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['metadata']).toEqual({ model: 'gpt-4o', temperature: 0.7 })
  })

  it('startRun sends tags when provided', async () => {
    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    await fr.startRun({ tags: ['demo', 'test'] })
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['tags']).toEqual(['demo', 'test'])
  })

  it('startRun sends triggeredBy when provided', async () => {
    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    await fr.startRun({ triggeredBy: 'manual' })
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['triggeredBy']).toBe('manual')
  })

  it('startRun returns a RunRecorder with the runId from response', async () => {
    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    const run = await fr.startRun()
    expect(run).toBeInstanceOf(RunRecorder)
    expect(run.runId).toBe('run_test_fr_001')
  })

  it('startRun throws on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      errorResponse(401, 'Unauthorized')
    ))
    const fr = new FlightRecorder({ apiKey: 'bad', baseUrl: 'http://localhost:3000', agentId: 'a' })
    await expect(fr.startRun()).rejects.toThrow('Unauthorized')
  })

  it('startRun throws on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      errorResponse(500, 'Internal Server Error')
    ))
    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    await expect(fr.startRun()).rejects.toThrow('Internal Server Error')
  })

  it('startRun includes agentVersionId when configured', async () => {
    const fr = new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://localhost:3000',
      agentId: 'a',
      agentVersionId: 'v1.2.3',
    })
    await fr.startRun()
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['agentVersionId']).toBe('v1.2.3')
  })

  it('startRun omits agentVersionId when not configured', async () => {
    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    await fr.startRun()
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body['agentVersionId']).toBeUndefined()
  })

  it('assigns sequence numbers per-run starting at 1, independent across runs', async () => {
    // Event Log Rule 4: each run's sequence numbers must start at 1 and be
    // contiguous. Two runs from the same FlightRecorder must NOT share a counter.
    const seqs: number[] = []
    const mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: `run_${seqs.length}` } })
      }
      if (url.endsWith('/api/events') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { sequenceNumber: number }
        seqs.push(body.sequenceNumber)
        return jsonResponse({ eventId: 'e' })
      }
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', mockFetch)

    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    const runA = await fr.startRun() // emits run.started (seq 1)
    await runA.recordEvent('custom', {}) // seq 2
    await runA.recordEvent('custom', {}) // seq 3
    const runB = await fr.startRun() // emits run.started (seq 1 again — per-run counter)
    await runB.recordEvent('custom', {}) // seq 2

    // Run A: run.started(1), custom(2), custom(3) ; Run B restarts at 1, not 4.
    expect(seqs).toEqual([1, 2, 3, 1, 2])
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// RunRecorder tests
// ---------------------------------------------------------------------------

describe('RunRecorder', () => {
  let mockFetch: ReturnType<typeof makeMockFetch>
  let fr: FlightRecorder

  beforeEach(() => {
    fr = new FlightRecorder({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:3000',
      agentId: 'agent_1',
    })

    mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'run_rr_001' } })
      }
      if (url.endsWith('/api/events') && init?.method === 'POST') {
        return jsonResponse({ eventId: 'evt_001' })
      }
      if (url.includes('/api/runs/') && url.endsWith('/status') && init?.method === 'PATCH') {
        return jsonResponse({ ok: true })
      }
      return jsonResponse({})
    })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recordEvent calls POST /api/events', async () => {
    const run = await fr.startRun()
    await run.recordEvent('custom', { hello: 'world' })

    const evtCall = mockFetch.mock.calls.find(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    expect(evtCall).toBeDefined()
  })

  it('recordEvent sends correct runId in body', async () => {
    const run = await fr.startRun()
    await run.recordEvent('custom', { x: 1 })

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['runId']).toBe('run_rr_001')
  })

  it('recordEvent sends correct type in body', async () => {
    const run = await fr.startRun()
    await run.recordEvent('LLM_REQUEST', { model: 'gpt-4o' })

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['type']).toBe('LLM_REQUEST')
  })

  it('recordEvent sends the payload in body', async () => {
    const run = await fr.startRun()
    await run.recordEvent('custom', { key: 'value', count: 42 })

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['payload']).toEqual({ key: 'value', count: 42 })
  })

  it('recordEvent sends x-api-key header', async () => {
    const run = await fr.startRun()
    await run.recordEvent('custom', {})

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const headers = (evtCall[1] as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
  })

  it('recordEvent returns the eventId from the response', async () => {
    const run = await fr.startRun()
    const eventId = await run.recordEvent('custom', {})
    expect(eventId).toBe('evt_001')
  })

  it('recordEvent includes parentEventId when provided', async () => {
    const run = await fr.startRun()
    await run.recordEvent('tool.result', { output: 'ok' }, 'evt_parent_123')

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['parentEventId']).toBe('evt_parent_123')
  })

  it('recordEvent omits parentEventId when not provided', async () => {
    const run = await fr.startRun()
    await run.recordEvent('custom', {})

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the user's recordEvent; the first is the
    // run.started lifecycle event now emitted automatically by startRun().
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['parentEventId']).toBeUndefined()
  })

  it('sequence numbers increment correctly across multiple events', async () => {
    const run = await fr.startRun()
    await run.recordEvent('ev1', {})
    await run.recordEvent('ev2', {})
    await run.recordEvent('ev3', {})

    const evtCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    const seqNumbers = evtCalls.map(([, init]: FetchArgs) => {
      const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
      return body['sequenceNumber'] as number
    })
    // Sequence numbers must be strictly increasing
    for (let i = 1; i < seqNumbers.length; i++) {
      expect(seqNumbers[i]).toBeGreaterThan(seqNumbers[i - 1]!)
    }
  })

  it('recordEvent throws on non-2xx response with API error message', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run: { id: 'run_err' } })) // startRun POST /api/runs
      .mockResolvedValueOnce(jsonResponse({ eventId: 'e' }))           // auto run.started event
      .mockResolvedValueOnce(errorResponse(400, 'Invalid event type')) // user recordEvent
    )
    const run = await fr.startRun()
    await expect(run.recordEvent('bad-type', {})).rejects.toThrow('Invalid event type')
  })

  it('recordEvent throws on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ run: { id: 'run_500' } }))
      .mockResolvedValueOnce(jsonResponse({ eventId: 'e' })) // auto run.started event
      .mockResolvedValueOnce(errorResponse(500, 'Server error'))
    )
    const run = await fr.startRun()
    await expect(run.recordEvent('custom', {})).rejects.toThrow('Server error')
  })

  it('complete calls PATCH /api/runs/:id/status with status=completed', async () => {
    const run = await fr.startRun()
    await run.complete()

    const patchCall = mockFetch.mock.calls.find(
      ([url, init]: FetchArgs) =>
        (url as string).includes('/api/runs/run_rr_001/status') && init?.method === 'PATCH'
    )
    expect(patchCall).toBeDefined()

    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['status']).toBe('completed')
  })

  it('complete sends x-api-key header', async () => {
    const run = await fr.startRun()
    await run.complete()

    const patchCall = mockFetch.mock.calls.find(
      ([url, init]: FetchArgs) =>
        (url as string).includes('/api/runs/run_rr_001/status') && init?.method === 'PATCH'
    )!
    const headers = (patchCall[1] as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
  })

  it('fail calls PATCH /api/runs/:id/status with status=failed', async () => {
    const run = await fr.startRun()
    // fail() always throws — catch it
    await expect(run.fail(new Error('something went wrong'))).rejects.toThrow('something went wrong')

    const patchCall = mockFetch.mock.calls.find(
      ([url, init]: FetchArgs) =>
        (url as string).includes('/api/runs/run_rr_001/status') && init?.method === 'PATCH'
    )
    expect(patchCall).toBeDefined()

    const body = JSON.parse((patchCall![1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['status']).toBe('failed')
  })

  it('fail re-throws the original Error', async () => {
    const run = await fr.startRun()
    const original = new Error('original error message')
    await expect(run.fail(original)).rejects.toThrow('original error message')
  })

  it('fail wraps string errors in Error', async () => {
    const run = await fr.startRun()
    await expect(run.fail('plain string error')).rejects.toThrow('plain string error')
  })

  it('fail preserves error.code on the recorded run.failed payload (parity with Recorder.failRun)', async () => {
    const run = await fr.startRun()
    const err = new Error('connection reset') as Error & { code?: string }
    err.code = 'ECONNRESET'
    await expect(run.fail(err)).rejects.toThrow('connection reset')

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    // The last /api/events POST is the run.failed terminal event.
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as {
      payload: { error: { code?: string } }
    }
    expect(body.payload.error.code).toBe('ECONNRESET')
  })

  it('fail attaches a bounded errorSummary as a sibling field on the run.failed payload', async () => {
    const run = await fr.startRun()
    const err = new Error('connection reset')
    err.stack = 'Error: connection reset\n    at doThing (/app/src/index.ts:12:5)'
    await expect(run.fail(err)).rejects.toThrow('connection reset')

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST'
    )
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as {
      payload: { errorSummary?: string }
    }
    expect(body.payload.errorSummary).toBe('connection reset | at doThing (/app/src/index.ts:12:5)')
  })

  it('fail swallows status-update failure and still re-throws original error', async () => {
    // Route by URL so auto-emitted lifecycle events (run.started/run.failed) don't
    // shift a positional mock chain: runs+events succeed, the PATCH status fails.
    vi.stubGlobal('fetch', makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes('/status') && init?.method === 'PATCH') return errorResponse(503, 'Service Unavailable')
      if (url.endsWith('/api/runs')) return jsonResponse({ run: { id: 'run_sw' } })
      return jsonResponse({ eventId: 'e' })
    }))
    const run = await fr.startRun()
    // Should throw the original error, not a status-update error
    await expect(run.fail(new Error('agent failure'))).rejects.toThrow('agent failure')
  })

  it('complete throws when status update returns non-2xx', async () => {
    vi.stubGlobal('fetch', makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.includes('/status') && init?.method === 'PATCH') return errorResponse(503, 'Service Unavailable')
      if (url.endsWith('/api/runs')) return jsonResponse({ run: { id: 'run_ct' } })
      return jsonResponse({ eventId: 'e' })
    }))
    const run = await fr.startRun()
    await expect(run.complete()).rejects.toThrow('Service Unavailable')
  })
})

// ---------------------------------------------------------------------------
// RunRecorder — oversized payload externalization (regression for C1)
// ---------------------------------------------------------------------------

describe('RunRecorder — payload externalization', () => {
  let mockFetch: ReturnType<typeof makeMockFetch>
  let fr: FlightRecorder

  beforeEach(() => {
    fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A payload that serializes to well over 10 KB. */
  function largePayload(): Record<string, unknown> {
    return { blob: 'x'.repeat(12_000) }
  }

  it('a >10KB payload is uploaded as an artifact and shipped as a pointer, not inline', async () => {
    const urls: string[] = []
    mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      urls.push(url)
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'run_big' } })
      }
      if (url.includes('/api/artifacts/upload')) {
        return jsonResponse({
          artifactId: 'art-1',
          storageKey: 'key/big',
          storageBucket: 'default',
          checksum: 'deadbeef',
          size: 12010,
        })
      }
      return jsonResponse({ eventId: 'evt_big' })
    })
    vi.stubGlobal('fetch', mockFetch)

    const run = await fr.startRun()
    await run.recordEvent('custom', largePayload())

    // The upload endpoint was hit.
    expect(urls.some((u) => u.includes('/api/artifacts/upload'))).toBe(true)

    // The events POST for the large custom event carries a pointer, not the blob.
    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST',
    )
    const bigCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((bigCall[1] as RequestInit).body as string) as {
      payload: { type: string; _artifact?: { storageKey: string } }
    }
    expect(body.payload.type).toBe('_externalized')
    expect(body.payload._artifact?.storageKey).toBe('key/big')
    // The oversized blob must not be present inline in the events request.
    expect((bigCall[1] as RequestInit).body as string).not.toContain('x'.repeat(12_000))
  })

  it('a small payload is NOT externalized (no upload call)', async () => {
    mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'run_small' } })
      }
      return jsonResponse({ eventId: 'evt_small' })
    })
    vi.stubGlobal('fetch', mockFetch)

    const run = await fr.startRun()
    await run.recordEvent('custom', { hello: 'world' })

    const uploadCalls = mockFetch.mock.calls.filter(
      ([url]: FetchArgs) => (url as string).includes('/api/artifacts/upload'),
    )
    expect(uploadCalls).toHaveLength(0)
  })

  it('a >10KB run.failed payload externalizes but keeps errorSummary inline (M4)', async () => {
    mockFetch = makeMockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/runs') && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'run_fail_big' } })
      }
      if (url.includes('/api/artifacts/upload')) {
        return jsonResponse({
          artifactId: 'art-fail-1',
          storageKey: 'key/fail-big',
          storageBucket: 'default',
          checksum: 'deadbeef',
          size: 12010,
        })
      }
      return jsonResponse({ eventId: 'evt_fail_big' })
    })
    vi.stubGlobal('fetch', mockFetch)

    const run = await fr.startRun()
    const hugeStack = 'Error: boom\n' + 'x'.repeat(12_000)
    const err = new Error('boom')
    err.stack = hugeStack
    await expect(run.fail(err)).rejects.toThrow('boom')

    const eventCalls = mockFetch.mock.calls.filter(
      ([url, init]: FetchArgs) =>
        (url as string).endsWith('/api/events') && init?.method === 'POST',
    )
    const evtCall = eventCalls[eventCalls.length - 1] as [string, RequestInit]
    const body = JSON.parse((evtCall[1] as RequestInit).body as string) as {
      payload: { type: string; errorSummary?: string }
    }
    expect(body.payload.type).toBe('_externalized')
    expect(body.payload.errorSummary).toBe('boom')
  })
})
