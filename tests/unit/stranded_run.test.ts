/**
 * Regression tests for the stranded-run poison pill and the hardening sweep:
 *
 * 1. A run whose terminal event cannot be delivered must NOT have its status
 *    patched (the server reconciles status from the terminal event on arrival;
 *    patching first makes the pending events permanently rejectable).
 * 2. Events are flushed in PER-RUN batches, so one stranded run cannot block
 *    other runs' delivery — in flush() and in recover().
 * 3. Permanent server rejections (RUN_NOT_ACTIVE / SEQUENCE_CONFLICT) drop the
 *    affected run's events observably instead of retrying them forever.
 * 4. Constructor validation, terminal-event recording guard, throwing-transport
 *    containment, and spool size capping.
 */
import { Recorder, HttpTransport, FlightRecorder } from '@agent-flight-recorder/sdk'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
  Run,
} from '@agent-flight-recorder/contracts'
import type { Transport, TransportAuth, EventSpool, StoredEvent, TransportResponse } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockTransport = (): Transport => {
  let runCounter = 0
  return {
    createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
      run: {
        id: `run_${String(++runCounter).padStart(3, '0')}`,
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
  }
}

class MemorySpool implements EventSpool {
  entries: StoredEvent[] = []
  async append(entries: StoredEvent[]): Promise<void> {
    this.entries.push(...entries)
  }
  async peek(): Promise<StoredEvent[]> {
    return [...this.entries]
  }
  async clear(): Promise<void> {
    this.entries = []
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const baseConfig = { endpoint: 'http://localhost:3000', apiKey: 'k', agentId: 'a' }

const spooledEvent = (runId: string, seq: number): StoredEvent => ({
  kind: 'event',
  event: {
    runId,
    type: 'custom',
    sequenceNumber: seq,
    timestamp: seq,
    payload: { type: 'custom', data: `d${seq}` },
  },
})

// ---------------------------------------------------------------------------
// 1. Stranded-run poison pill
// ---------------------------------------------------------------------------

describe('Recorder — stranded-run status deferral', () => {
  let transport: Transport

  beforeEach(() => {
    transport = createMockTransport()
  })

  it('does NOT patch run status while the terminal event is undelivered (the poison pill)', async () => {
    // Mirrors the original bug: externalization/send fails non-retryably, the
    // terminal event stays buffered, and the old code then patched the run to
    // "completed" — making every retried event permanently rejectable
    // (RUN_NOT_ACTIVE). Verify the patch is now skipped and the deferral is
    // surfaced.
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Failed to externalize payload for event seq=2: upload failed',
      retryable: false,
    })
    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000 } }, transport)
    await rec.startRun('input')
    const result = await rec.endRun('output')

    expect(result.success).toBe(false)
    expect(result.statusTransitionDeferred).toBe(true)
    expect(result.errors.some((e) => e.error.includes('UNDELIVERED'))).toBe(true)
    expect(transport.updateRunStatus).not.toHaveBeenCalled()

    // When the transport heals, the terminal event IS delivered (the server
    // reconciles the run's status from it) — nothing was dropped.
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => ({
        success: true as const,
        eventIds: events.map((_, i) => `e${i}`),
      }),
    )
    const retry = await rec.flush()
    expect(retry.success).toBe(true)
    const lastBatch = (transport.sendEvents as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as CreateEventRequest[]
    expect(lastBatch.some((e) => e.type === 'run.completed')).toBe(true)
    // Status still not patched by the SDK — delivery of the terminal event is
    // the reconciliation mechanism.
    expect(transport.updateRunStatus).not.toHaveBeenCalled()
  })

  it('still patches run status when all events were delivered', async () => {
    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000 } }, transport)
    await rec.startRun('input')
    const result = await rec.endRun('output')
    expect(result.success).toBe(true)
    expect(result.statusTransitionDeferred).toBeUndefined()
    expect(transport.updateRunStatus).toHaveBeenCalledWith('run_001', 'completed', expect.any(Number), expect.any(Object))
  })
})

// ---------------------------------------------------------------------------
// 2. Per-run batch isolation
// ---------------------------------------------------------------------------

describe('Recorder — per-run batch isolation', () => {
  it("a stranded run's events do not block another run's delivery in flush()", async () => {
    const transport = createMockTransport()
    const delivered: CreateEventRequest[] = []
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]): Promise<TransportResponse> => {
        if (events[0]!.runId === 'run_001') {
          return { success: false, error: 'run_001 is poisoned', retryable: true }
        }
        delivered.push(...events)
        return { success: true, eventIds: events.map((_, i) => `e${i}`) }
      },
    )
    ;(transport.updateRunStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      eventIds: [],
    })

    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000, maxBatchSize: 1000 } }, transport)
    // Run A strands: its events (run.started + run.completed) stay buffered.
    await rec.startRun('input A')
    const resultA = await rec.endRun('output A')
    expect(resultA.success).toBe(false)
    expect(resultA.statusTransitionDeferred).toBe(true)

    // Run B starts while A's events are still stuck in the buffer.
    await rec.startRun('input B') // run_002
    rec.recordEvent('custom', { type: 'custom', data: 'b1' })
    const resultB = await rec.endRun('output B')

    // B's events were all delivered despite A's poison...
    expect(delivered.map((e) => e.runId)).toEqual(['run_002', 'run_002', 'run_002'])
    expect(delivered.at(-1)!.type).toBe('run.completed')
    // ...and B's status was patched (B has nothing undelivered).
    expect(transport.updateRunStatus).toHaveBeenCalledWith('run_002', 'completed', expect.any(Number), expect.any(Object))
    // A's failure is surfaced per-run in B's finalize result.
    expect(resultB.success).toBe(false)
    expect(resultB.errors.some((e) => e.error.includes('run_001'))).toBe(true)
    expect(resultB.errors.some((e) => e.error.includes('run_002'))).toBe(false)
  })

  it('recover() delivers healthy runs even when one spooled run is stranded', async () => {
    const transport = createMockTransport()
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]): Promise<TransportResponse> => {
        if (events[0]!.runId === 'run_stuck') {
          return { success: false, error: 'still down for run_stuck', retryable: true }
        }
        return { success: true, eventIds: events.map((_, i) => `e${i}`) }
      },
    )

    const spool = new MemorySpool()
    spool.entries = [
      spooledEvent('run_stuck', 1),
      spooledEvent('run_healthy', 1),
      spooledEvent('run_stuck', 2),
      spooledEvent('run_healthy', 2),
    ]
    const rec = new Recorder({ ...baseConfig, options: { spool } }, transport)
    const result = await rec.recover()

    expect(result.success).toBe(false) // run_stuck still failing
    expect(result.eventsSubmitted).toBe(2) // run_healthy's two events made it
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.error).toContain('run_stuck')
    // Only the stranded run's entries survive in the spool (healthy acked).
    expect(spool.entries.map((e) => (e.kind === 'event' ? e.event.runId : ''))).toEqual(['run_stuck', 'run_stuck'])
  })
})

// ---------------------------------------------------------------------------
// 3. Permanent server rejection (RUN_NOT_ACTIVE / SEQUENCE_CONFLICT)
// ---------------------------------------------------------------------------

describe('Recorder — non-retryable terminal error codes', () => {
  it('drops a permanently rejected run batch, fires onDrop, clears its spool entries, and continues', async () => {
    const transport = createMockTransport()
    const delivered: CreateEventRequest[] = []
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]): Promise<TransportResponse> => {
        if (events[0]!.runId === 'run_dead') {
          return { success: false, error: 'run already terminal', retryable: false, code: 'RUN_NOT_ACTIVE' }
        }
        delivered.push(...events)
        return { success: true, eventIds: events.map((_, i) => `e${i}`) }
      },
    )

    const onDrop = vi.fn()
    const spool = new MemorySpool()
    spool.entries = [spooledEvent('run_dead', 5), spooledEvent('run_dead', 6)]
    const rec = new Recorder(
      { ...baseConfig, options: { flushIntervalMs: 60_000, maxBatchSize: 1000, spool, onDrop } },
      transport,
    )

    // Recovery path: run_dead is permanently rejected — dropped from the spool.
    const recovered = await rec.recover()
    expect(recovered.errors.some((e) => e.error.includes('RUN_NOT_ACTIVE'))).toBe(true)
    expect(onDrop).toHaveBeenCalledWith(2, 'rejected_by_server')
    expect(spool.entries).toHaveLength(0)

    // Flush path: a live run is unaffected and its events deliver fine.
    await rec.startRun('input') // run_001
    const result = await rec.endRun('done')
    expect(result.success).toBe(true)
    expect(delivered.every((e) => e.runId === 'run_001')).toBe(true)
    expect(result.droppedEvents).toBe(2)
  })

  it('SEQUENCE_CONFLICT on a buffered flush drops that run and does not poison later flushes', async () => {
    const transport = createMockTransport()
    let rejectRun1 = true
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]): Promise<TransportResponse> => {
        if (rejectRun1 && events[0]!.runId === 'run_001') {
          return { success: false, error: 'sequence already claimed', retryable: false, code: 'SEQUENCE_CONFLICT' }
        }
        return { success: true, eventIds: events.map((_, i) => `e${i}`) }
      },
    )
    const onDrop = vi.fn()
    const spool = new MemorySpool()
    const rec = new Recorder(
      { ...baseConfig, options: { flushIntervalMs: 60_000, maxBatchSize: 1000, onDrop, spool } },
      transport,
    )
    await rec.startRun('input') // run_001: run.started buffered
    rec.recordEvent('custom', { type: 'custom', data: 'x' })
    const flushResult = await rec.flush()
    await settle()

    expect(flushResult.success).toBe(false)
    expect(flushResult.errors[0]!.error).toContain('SEQUENCE_CONFLICT')
    expect(onDrop).toHaveBeenCalledWith(2, 'rejected_by_server')
    // The rejected events are gone from buffer AND spool — the next flush is clean.
    expect(spool.entries).toHaveLength(0)
    rejectRun1 = false
    const next = await rec.flush()
    expect(next.success).toBe(true)
    expect(next.eventsSubmitted).toBe(0) // nothing left to retry — batch was dropped, not wedged
  })
})

// ---------------------------------------------------------------------------
// 4. Constructor validation + guards
// ---------------------------------------------------------------------------

describe('constructor validation', () => {
  const transport = createMockTransport()

  it.each([
    ['maxBatchSize', { maxBatchSize: 0 }],
    ['maxBufferSize', { maxBufferSize: 0 }],
    ['maxBufferSize (negative)', { maxBufferSize: -1 }],
    ['flushIntervalMs', { flushIntervalMs: 0 }],
    ['maxSpoolEntries', { maxSpoolEntries: 0 }],
  ])('Recorder throws TypeError for invalid %s', (_name, options) => {
    expect(() => new Recorder({ ...baseConfig, options }, transport)).toThrow(TypeError)
  })

  it('Recorder accepts valid options', () => {
    expect(
      () =>
        new Recorder(
          { ...baseConfig, options: { maxBatchSize: 1, maxBufferSize: 1, flushIntervalMs: 1, maxSpoolEntries: 1 } },
          transport,
        ),
    ).not.toThrow()
  })

  it('HttpTransport throws TypeError for timeoutMs < 1', () => {
    expect(() => new HttpTransport('http://localhost:3000', { timeoutMs: 0 })).toThrow(TypeError)
    expect(() => new HttpTransport('http://localhost:3000', 0)).toThrow(TypeError)
    expect(() => new HttpTransport('http://localhost:3000', { timeoutMs: 1 })).not.toThrow()
  })

  it('FlightRecorder throws TypeError for maxConcurrentRequests < 1', () => {
    expect(
      () => new FlightRecorder({ apiKey: 'k', baseUrl: 'http://localhost:3000', agentId: 'a', maxConcurrentRequests: 0 }),
    ).toThrow(TypeError)
  })
})

describe('Recorder — terminal-event recording guard', () => {
  it('recordEvent throws after a terminal event is buffered for the current run', async () => {
    const transport = createMockTransport()
    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000 } }, transport)
    await rec.startRun('input')
    rec.recordEvent('run.completed', { type: 'run.completed', output: null, duration_ms: 1 })
    expect(() => rec.recordEvent('custom', { type: 'custom', data: 'late' })).toThrow(/terminal event/)
  })

  it('the guard resets for the next run', async () => {
    const transport = createMockTransport()
    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000 } }, transport)
    await rec.startRun('input')
    await rec.endRun('done')
    await rec.startRun('second')
    expect(() => rec.recordEvent('custom', { type: 'custom', data: 'ok' })).not.toThrow()
    await rec.endRun('done')
  })
})

describe('Recorder — throwing custom Transport containment', () => {
  it('a Transport whose sendEvents throws lands in FlushResult.errors, and flush() resolves', async () => {
    const transport = createMockTransport()
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('buggy transport exploded')
    })
    const rec = new Recorder({ ...baseConfig, options: { flushIntervalMs: 60_000 } }, transport)
    await rec.startRun('input')
    const result = await rec.flush()
    expect(result.success).toBe(false)
    expect(result.errors[0]!.error).toContain('buggy transport exploded')
    // Events were retained, not lost — a healed transport delivers them.
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => ({ success: true as const, eventIds: events.map(() => 'e') }),
    )
    const retry = await rec.flush()
    expect(retry.success).toBe(true)
    expect(retry.eventsSubmitted).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Spool size cap
// ---------------------------------------------------------------------------

describe('Recorder — maxSpoolEntries cap', () => {
  it('drops the oldest non-lifecycle entries from spool AND buffer on overflow, observably', async () => {
    const transport = createMockTransport()
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'down',
      retryable: true,
    })
    const onDrop = vi.fn()
    const spool = new MemorySpool()
    const rec = new Recorder(
      {
        ...baseConfig,
        options: { flushIntervalMs: 60_000, maxBatchSize: 1000, maxSpoolEntries: 3, spool, onDrop },
      },
      transport,
    )
    await rec.startRun('input') // run.started (protected, kept)
    for (let i = 0; i < 5; i++) {
      rec.recordEvent('custom', { type: 'custom', data: `c${i}` })
    }
    await settle()

    expect(spool.entries.length).toBeLessThanOrEqual(3)
    // run.started is lifecycle-protected and survives.
    expect(spool.entries.some((e) => e.kind === 'event' && e.event.type === 'run.started')).toBe(true)
    const overflowCalls = onDrop.mock.calls.filter(([, reason]) => reason === 'spool_overflow')
    expect(overflowCalls.length).toBeGreaterThan(0)

    // The buffer was mirrored: a flush sends only what is still in the spool.
    ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockImplementation(
      async (events: CreateEventRequest[]) => ({ success: true as const, eventIds: events.map(() => 'e') }),
    )
    const result = await rec.flush()
    expect(result.eventsSubmitted).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// 6. Transport surfaces real eventIds and error codes
// ---------------------------------------------------------------------------

describe('HttpTransport — response parsing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const events: CreateEventRequest[] = [
    { runId: 'run_1', type: 'custom', sequenceNumber: 1, timestamp: 1, payload: { type: 'custom', data: null } },
  ]

  it('surfaces server-assigned eventIds on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ eventIds: ['evt_real_1'] }),
        text: async () => '',
      }) as Response),
    )
    const t = new HttpTransport('http://localhost:3000')
    const res = await t.sendEvents(events, { apiKey: 'k' })
    expect(res).toEqual({ success: true, eventIds: ['evt_real_1'] })
  })

  it('parses the stable error code from a 4xx JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: 'SEQUENCE_CONFLICT', message: 'sequence 1 already exists' }),
        text: async () => '',
      }) as Response),
    )
    const t = new HttpTransport('http://localhost:3000')
    const res = await t.sendEvents(events, { apiKey: 'k' })
    expect(res).toMatchObject({ success: false, retryable: false, code: 'SEQUENCE_CONFLICT' })
  })
})
