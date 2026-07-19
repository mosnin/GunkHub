import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from '@agent-flight-recorder/contracts'
import { Recorder, HttpTransport, FlightRecorder, FlightReader, SDK_VERSION } from '@agent-flight-recorder/sdk'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
  Run,
} from '@agent-flight-recorder/contracts'
import type { Transport, TransportAuth } from '@agent-flight-recorder/sdk'

const createMockTransport = (): Transport => ({
  createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
    run: {
      id: 'run_obs_001',
      orgId: 'org_test',
      projectId: 'proj_test',
      agentId: req.agentId,
      status: 'running',
      startedAt: Date.now(),
      metadata: req.metadata ?? {},
      tags: req.tags ?? [],
      sdkVersion: req.sdkVersion,
    } as Run,
  })),
  sendEvents: vi.fn(async (events: CreateEventRequest[], _auth: TransportAuth) => ({
    success: true as const,
    eventIds: events.map((_, i) => `evt_${i}`),
  })),
  updateRunStatus: vi.fn(async () => ({ success: true as const, eventIds: [] })),
})

// ---------------------------------------------------------------------------
// Drop / flush-error observability callbacks
// ---------------------------------------------------------------------------

describe('Recorder — observability callbacks', () => {
  let transport: Transport

  beforeEach(() => {
    transport = createMockTransport()
  })

  it('onDrop fires with the correct count and reason on buffer overflow', async () => {
    const onDrop = vi.fn()
    const rec = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { maxBatchSize: 1000, maxBufferSize: 3, flushIntervalMs: 60_000, onDrop },
      },
      transport,
    )
    await rec.startRun('input') // run.started (protected, never dropped)
    for (let i = 0; i < 5; i++) {
      rec.recordEvent('custom', { type: 'custom', data: `c${i}` })
    }

    // Buffer cap 3 with 6 events recorded and 1 protected → 3 drops total,
    // enforced one at a time as each overflowing event is recorded.
    expect(onDrop).toHaveBeenCalledTimes(3)
    for (const call of onDrop.mock.calls) {
      expect(call).toEqual([1, 'buffer_overflow'])
    }
    const total = onDrop.mock.calls.reduce((sum, [count]) => sum + (count as number), 0)
    const result = await rec.flush()
    expect(result.droppedEvents).toBe(total)
  })

  it('onFlushError fires when the transport fails on a timer-driven flush', async () => {
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'server exploded',
      retryable: true,
    })
    const onFlushError = vi.fn()
    const rec = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { flushIntervalMs: 5, maxBatchSize: 1000, onFlushError },
      },
      transport,
    )
    await rec.startRun('input')
    rec.recordEvent('custom', { type: 'custom', data: 'x' })

    await vi.waitFor(() => expect(onFlushError).toHaveBeenCalled())
    expect(String(onFlushError.mock.calls[0][0])).toContain('server exploded')
    await rec.shutdown()
  })

  it('onFlushError fires when the maxBatchSize-triggered flush fails', async () => {
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'batch rejected',
      retryable: false,
    })
    const onFlushError = vi.fn()
    const rec = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { flushIntervalMs: 60_000, maxBatchSize: 2, onFlushError },
      },
      transport,
    )
    await rec.startRun('input') // seq 1
    rec.recordEvent('custom', { type: 'custom', data: 'x' }) // seq 2 → hits maxBatch

    await vi.waitFor(() => expect(onFlushError).toHaveBeenCalled())
    expect(String(onFlushError.mock.calls[0][0])).toContain('batch rejected')
  })

  it('a throwing consumer callback never crashes the recorder', async () => {
    const rec = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: {
          maxBatchSize: 1000,
          maxBufferSize: 2,
          flushIntervalMs: 60_000,
          onDrop: () => {
            throw new Error('consumer bug')
          },
        },
      },
      transport,
    )
    await rec.startRun('input')
    expect(() => {
      for (let i = 0; i < 5; i++) rec.recordEvent('custom', { type: 'custom', data: `c${i}` })
    }).not.toThrow()
  })

  it('debug option logs flush diagnostics with the [afr-sdk] prefix', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const rec = new Recorder(
        {
          endpoint: 'http://localhost:3000',
          apiKey: 'k',
          agentId: 'a',
          options: { flushIntervalMs: 60_000, debug: true },
        },
        transport,
      )
      await rec.startRun('input')
      await rec.flush()
      expect(logSpy.mock.calls.some(([msg]) => String(msg).startsWith('[afr-sdk]') && String(msg).includes('flush ok'))).toBe(true)
    } finally {
      logSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Version single-sourcing
// ---------------------------------------------------------------------------

describe('SDK_VERSION', () => {
  it('matches the version in packages/sdk/package.json', async () => {
    const pkgRaw = await readFile(join(__dirname, '../../packages/sdk/package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw) as { version: string }
    expect(SDK_VERSION).toBe(pkg.version)
  })

  it('is reported as sdkVersion on run creation by Recorder', async () => {
    const transport = createMockTransport()
    const rec = new Recorder({ endpoint: 'http://localhost:3000', apiKey: 'k', agentId: 'a' }, transport)
    await rec.startRun('input')
    expect(transport.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ sdkVersion: SDK_VERSION }),
      expect.any(Object),
    )
  })
})

// ---------------------------------------------------------------------------
// Wire protocol header
// ---------------------------------------------------------------------------

describe('x-afr-protocol header', () => {
  const okResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('PROTOCOL_VERSION is 1 and the header name is stable', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(PROTOCOL_VERSION_HEADER).toBe('x-afr-protocol')
  })

  it('HttpTransport sends the protocol header on createRun, sendEvents, and updateRunStatus', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/runs')) return okResponse({ run: { id: 'run_1' } })
      return okResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    const t = new HttpTransport('http://localhost:3000')
    await t.createRun({ agentId: 'a' }, { apiKey: 'k' })
    await t.sendEvents(
      [{ runId: 'run_1', type: 'custom', sequenceNumber: 1, timestamp: 1, payload: { type: 'custom', data: null } }],
      { apiKey: 'k' },
    )
    await t.updateRunStatus('run_1', 'completed', 1, { apiKey: 'k' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers[PROTOCOL_VERSION_HEADER]).toBe(String(PROTOCOL_VERSION))
      expect(headers['x-api-key']).toBe('k')
    }
  })

  it('FlightRecorder sends the protocol header on startRun, recordEvent, and status updates', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/runs')) return okResponse({ run: { id: 'run_fr' } })
      if (url.endsWith('/api/events')) return okResponse({ eventId: 'evt_1' })
      return okResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)

    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    const run = await fr.startRun()
    await run.recordEvent('custom', { hello: 'world' })
    await run.complete()

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const [, init] of fetchMock.mock.calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers[PROTOCOL_VERSION_HEADER]).toBe(String(PROTOCOL_VERSION))
    }
  })
})

// ---------------------------------------------------------------------------
// Insecure endpoint warning
// ---------------------------------------------------------------------------

const spyConsoleWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

describe('insecure endpoint warning', () => {
  let warnSpy: ReturnType<typeof spyConsoleWarn>

  beforeEach(() => {
    warnSpy = spyConsoleWarn()
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('warns once for a plain-HTTP non-localhost endpoint (HttpTransport)', () => {
    new HttpTransport('http://insecure-a.example.com')
    new HttpTransport('http://insecure-a.example.com') // same endpoint: no second warning
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('plain HTTP')
  })

  it('warns for a plain-HTTP non-localhost baseUrl (FlightRecorder)', () => {
    new FlightRecorder({ apiKey: 'k', baseUrl: 'http://insecure-b.example.com', agentId: 'a' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('does not warn for https or localhost endpoints', () => {
    new HttpTransport('https://afr.example.com')
    new HttpTransport('http://localhost:3000')
    new HttpTransport('http://127.0.0.1:3000')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('is suppressed by allowInsecureEndpoint: true', () => {
    new HttpTransport('http://insecure-c.example.com', { allowInsecureEndpoint: true })
    new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://insecure-d.example.com',
      agentId: 'a',
      allowInsecureEndpoint: true,
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns for a plain-HTTP non-localhost baseUrl (FlightReader) — parity with the write paths', () => {
    new FlightReader({ apiKey: 'k', baseUrl: 'http://insecure-e.example.com' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('plain HTTP')
  })

  it('FlightReader insecure warning is suppressed by allowInsecureEndpoint: true', () => {
    new FlightReader({ apiKey: 'k', baseUrl: 'http://insecure-f.example.com', allowInsecureEndpoint: true })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not warn for a FlightReader over https or localhost', () => {
    new FlightReader({ apiKey: 'k', baseUrl: 'https://afr.example.com' })
    new FlightReader({ apiKey: 'k', baseUrl: 'http://localhost:3000' })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Un-buffered path concurrency bound
// ---------------------------------------------------------------------------

describe('RunRecorder — maxConcurrentRequests', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const slowFetch = (tracker: { inFlight: number; max: number }, delayMs = 15) =>
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/runs')) {
        return { ok: true, status: 200, json: async () => ({ run: { id: 'run_cc' } }) } as Response
      }
      tracker.inFlight++
      tracker.max = Math.max(tracker.max, tracker.inFlight)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      tracker.inFlight--
      return { ok: true, status: 200, json: async () => ({ eventId: 'evt' }) } as Response
    })

  it('20 concurrent recordEvent calls never exceed the default cap of 8 in flight', async () => {
    const tracker = { inFlight: 0, max: 0 }
    vi.stubGlobal('fetch', slowFetch(tracker))

    const fr = new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a' })
    const run = await fr.startRun()
    tracker.max = 0 // ignore the run.started event sent during startRun

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => run.recordEvent('custom', { i })),
    )
    expect(tracker.max).toBeLessThanOrEqual(8)
    expect(tracker.max).toBeGreaterThan(1) // sanity: it actually ran concurrently
  })

  it('honours a custom maxConcurrentRequests', async () => {
    const tracker = { inFlight: 0, max: 0 }
    vi.stubGlobal('fetch', slowFetch(tracker, 5))

    const fr = new FlightRecorder({
      apiKey: 'k',
      baseUrl: 'http://localhost:3000',
      agentId: 'a',
      maxConcurrentRequests: 2,
    })
    const run = await fr.startRun()
    tracker.max = 0

    await Promise.all(Array.from({ length: 10 }, (_, i) => run.recordEvent('custom', { i })))
    expect(tracker.max).toBeLessThanOrEqual(2)
  })
})
