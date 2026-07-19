import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Recorder, FileSpool } from '@agent-flight-recorder/sdk'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import type {
  CreateRunRequest,
  CreateRunResponse,
  CreateEventRequest,
  Run,
} from '@agent-flight-recorder/contracts'
import type { Transport, TransportAuth, EventSpool, StoredEvent } from '@agent-flight-recorder/sdk'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockTransport = (): Transport => ({
  createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
    run: {
      id: 'run_spool_001',
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

/** In-memory EventSpool for deterministic unit tests. */
class MemorySpool implements EventSpool {
  entries: StoredEvent[] = []
  failAppends = false

  async append(entries: StoredEvent[]): Promise<void> {
    if (this.failAppends) throw new Error('disk full')
    this.entries.push(...entries)
  }
  async peek(): Promise<StoredEvent[]> {
    return [...this.entries]
  }
  async clear(): Promise<void> {
    this.entries = []
  }
}

/** Let fire-and-forget spool-chain microtasks settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

const makeRecorder = (transport: Transport, spool?: EventSpool, extraOptions = {}) =>
  new Recorder(
    {
      endpoint: 'http://localhost:3000',
      apiKey: 'k',
      agentId: 'agent_spool',
      options: { ...(spool && { spool }), ...extraOptions },
    },
    transport,
  )

// ---------------------------------------------------------------------------
// Write-ahead spooling
// ---------------------------------------------------------------------------

describe('Recorder + EventSpool (write-ahead durability)', () => {
  let transport: Transport
  let spool: MemorySpool

  beforeEach(() => {
    transport = createMockTransport()
    spool = new MemorySpool()
  })

  it('recordEvent appends events to the spool before delivery', async () => {
    const rec = makeRecorder(transport, spool, { flushIntervalMs: 60_000, maxBatchSize: 1000 })
    await rec.startRun('input') // run.started (seq 1)
    rec.recordEvent('custom', { type: 'custom', data: 'a' }) // seq 2
    await settle()

    expect(spool.entries).toHaveLength(2)
    expect(spool.entries.every((e) => e.kind === 'event')).toBe(true)
    const seqs = spool.entries.map((e) => (e.kind === 'event' ? e.event.sequenceNumber : -1))
    expect(seqs).toEqual([1, 2])
  })

  it('a successful flush removes the acknowledged events from the spool', async () => {
    const rec = makeRecorder(transport, spool, { flushIntervalMs: 60_000, maxBatchSize: 1000 })
    await rec.startRun('input')
    rec.recordEvent('custom', { type: 'custom', data: 'a' })
    await settle()
    expect(spool.entries).toHaveLength(2)

    const result = await rec.flush()
    await settle()
    expect(result.success).toBe(true)
    expect(spool.entries).toHaveLength(0)
  })

  it('a failed flush keeps the events in the spool', async () => {
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'server down',
      retryable: true,
    })
    const rec = makeRecorder(transport, spool, { flushIntervalMs: 60_000, maxBatchSize: 1000 })
    await rec.startRun('input')
    rec.recordEvent('custom', { type: 'custom', data: 'a' })
    await settle()

    const result = await rec.flush()
    await settle()
    expect(result.success).toBe(false)
    expect(spool.entries).toHaveLength(2)
  })

  it('spool append failures fire onSpoolError and never break recording', async () => {
    spool.failAppends = true
    const onSpoolError = vi.fn()
    const rec = makeRecorder(transport, spool, { flushIntervalMs: 60_000, onSpoolError })
    await rec.startRun('input')
    expect(() => rec.recordEvent('custom', { type: 'custom', data: 'a' })).not.toThrow()
    await settle()
    expect(onSpoolError).toHaveBeenCalled()
    expect(String(onSpoolError.mock.calls[0][0])).toContain('disk full')
  })
})

// ---------------------------------------------------------------------------
// Terminal delivery guarantee
// ---------------------------------------------------------------------------

describe('Recorder — terminal delivery guarantee', () => {
  let transport: Transport

  beforeEach(() => {
    transport = createMockTransport()
  })

  const failAll = () => {
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'network down',
      retryable: true,
    })
    ;(transport.updateRunStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'network down',
      retryable: true,
    })
  }

  it('does NOT wedge the recorder when finalize fails (no spool): a new run can start', async () => {
    failAll()
    const rec = makeRecorder(transport)
    await rec.startRun('input')
    const result = await rec.endRun('output')

    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.error.includes('UNDELIVERED'))).toBe(true)
    expect(result.errors.some((e) => e.error.includes('LOST if the process exits'))).toBe(true)
    // The recorder is released — no wedge.
    expect(rec.activeRun).toBeNull()
    ;(transport.createRun as ReturnType<typeof vi.fn>).mockClear()
    await expect(rec.startRun('second')).resolves.toBeDefined()
  })

  it('persists the terminal event to the spool and DEFERS the status transition when finalize fails', async () => {
    failAll()
    const spool = new MemorySpool()
    const rec = makeRecorder(transport, spool)
    await rec.startRun('input')
    const result = await rec.endRun('output')

    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.error.includes('UNDELIVERED'))).toBe(true)
    expect(result.errors.some((e) => e.error.includes('spool'))).toBe(true)
    expect(rec.activeRun).toBeNull()

    // The terminal run.completed event is in the spool (write-ahead).
    const eventEntries = spool.entries.filter((e) => e.kind === 'event')
    expect(eventEntries.some((e) => e.kind === 'event' && e.event.type === 'run.completed')).toBe(true)
    // Stranded-run poison-pill fix: while the terminal event is undelivered,
    // the run status must NOT be patched (that would make the pending events
    // permanently rejectable as RUN_NOT_ACTIVE). The server reconciles status
    // from the terminal event on arrival, so NO status intent is spooled and
    // the deferral is surfaced in the FlushResult.
    expect(transport.updateRunStatus).not.toHaveBeenCalled()
    expect(result.statusTransitionDeferred).toBe(true)
    expect(spool.entries.filter((e) => e.kind === 'status')).toHaveLength(0)
  })

  it('recover() re-sends spooled events and status intents, then empties the spool', async () => {
    const spool = new MemorySpool()
    spool.entries = [
      {
        kind: 'event',
        event: { runId: 'run_old', type: 'run.completed', sequenceNumber: 2, timestamp: 1, payload: { type: 'run.completed', output: null, duration_ms: 5 } },
      },
      { kind: 'status', runId: 'run_old', status: 'completed', endedAt: 123 },
    ]
    const rec = makeRecorder(transport, spool)
    const result = await rec.recover()

    expect(result.success).toBe(true)
    expect(result.eventsSubmitted).toBe(1)
    expect(transport.sendEvents).toHaveBeenCalledWith(
      [expect.objectContaining({ runId: 'run_old', sequenceNumber: 2 })],
      expect.objectContaining({ apiKey: 'k' }),
    )
    expect(transport.updateRunStatus).toHaveBeenCalledWith('run_old', 'completed', 123, expect.any(Object))
    expect(spool.entries).toHaveLength(0)
  })

  it('recover() re-appends entries it could not deliver', async () => {
    (transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'still down',
      retryable: true,
    })
    const spool = new MemorySpool()
    spool.entries = [
      {
        kind: 'event',
        event: { runId: 'run_old', type: 'custom', sequenceNumber: 1, timestamp: 1, payload: { type: 'custom', data: null } },
      },
    ]
    const rec = makeRecorder(transport, spool)
    const result = await rec.recover()

    expect(result.success).toBe(false)
    expect(result.errors[0].error).toContain('Recovery send failed')
    expect(spool.entries).toHaveLength(1) // back in the spool for next time
  })

  it('recover() is a zero-cost no-op without a spool', async () => {
    const rec = makeRecorder(transport)
    const result = await rec.recover()
    expect(result).toMatchObject({ success: true, eventsSubmitted: 0 })
    expect(transport.sendEvents).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// FileSpool (Node JSONL implementation)
// ---------------------------------------------------------------------------

describe('FileSpool', () => {
  const makeTmpPath = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afr-spool-'))
    return { dir, path: join(dir, 'nested', 'spool.jsonl') }
  }

  const sampleEvent = (seq: number): StoredEvent => ({
    kind: 'event',
    event: { runId: 'run_f', type: 'custom', sequenceNumber: seq, timestamp: seq, payload: { type: 'custom', data: `d${seq}` } },
  })

  it('round-trips append → drain in order, and drain empties the file', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path)
      await spool.append([sampleEvent(1), sampleEvent(2)])
      await spool.append([{ kind: 'status', runId: 'run_f', status: 'failed', endedAt: 9 }])

      const drained = await spool.drain()
      expect(drained).toHaveLength(3)
      expect(drained[0]).toMatchObject({ kind: 'event', event: { sequenceNumber: 1 } })
      expect(drained[1]).toMatchObject({ kind: 'event', event: { sequenceNumber: 2 } })
      expect(drained[2]).toMatchObject({ kind: 'status', status: 'failed', endedAt: 9 })

      // Drain removed the entries.
      expect(await spool.drain()).toEqual([])
      expect((await readFile(path, 'utf8')).trim()).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drain on a missing file is an empty spool, not an error', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path)
      await expect(spool.drain()).resolves.toEqual([])
      await expect(spool.clear()).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips torn/corrupt JSONL lines on drain', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path)
      await spool.append([sampleEvent(1)])
      // Simulate a crash mid-append: a torn partial line at the tail.
      const { appendFile } = await import('node:fs/promises')
      await appendFile(path, '{"kind":"event","event":{"runId":"run_f","ty', 'utf8')

      const drained = await spool.drain()
      expect(drained).toHaveLength(1)
      expect(drained[0]).toMatchObject({ kind: 'event', event: { sequenceNumber: 1 } })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('peek returns entries WITHOUT removing them (peek → send → ack safety)', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path)
      await spool.append([sampleEvent(1), sampleEvent(2)])

      const peeked = await spool.peek()
      expect(peeked).toHaveLength(2)
      // A second peek still sees everything — nothing was truncated, so a
      // crash between peek and delivery loses nothing.
      expect(await spool.peek()).toHaveLength(2)
      // Only an explicit clear (the "ack") removes entries.
      await spool.clear()
      expect(await spool.peek()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fsync: true appends durably without changing observable behavior', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path, { fsync: true })
      await spool.append([sampleEvent(1)])
      expect(await spool.peek()).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clear empties the spool', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const spool = new FileSpool(path)
      await spool.append([sampleEvent(1), sampleEvent(2)])
      await spool.clear()
      expect(await spool.drain()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('works end-to-end as a Recorder spool (crash → recover with a new process)', async () => {
    const { dir, path } = await makeTmpPath()
    try {
      const transport = createMockTransport()
      ;(transport.sendEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'down',
        retryable: true,
      })
      ;(transport.updateRunStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: 'down',
        retryable: true,
      })
      const rec = makeRecorder(transport, new FileSpool(path))
      await rec.startRun('input')
      rec.recordEvent('custom', { type: 'custom', data: 'x' })
      await rec.endRun('out') // fails — everything lands in the spool

      // "Restart": a fresh recorder + healthy transport recovers the spool.
      const transport2 = createMockTransport()
      const rec2 = makeRecorder(transport2, new FileSpool(path))
      const result = await rec2.recover()
      expect(result.success).toBe(true)
      expect(result.eventsSubmitted).toBe(3) // run.started, custom, run.completed
      // No status intent was spooled (the transition was deferred to event
      // delivery — the server reconciles status from the terminal event), so
      // recovery only re-sends events.
      expect(transport2.updateRunStatus).not.toHaveBeenCalled()
      // Spool is empty after successful recovery.
      expect(await new FileSpool(path).peek()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('warns once when a second FileSpool targets an already-open path in this process', async () => {
    const { dir, path } = await makeTmpPath()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      new FileSpool(path) // eslint-disable-line no-new -- claims the path
      expect(warnSpy).not.toHaveBeenCalled()

      new FileSpool(path) // eslint-disable-line no-new -- same path, second instance: should warn
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]![0]).toContain(path)

      new FileSpool(path) // eslint-disable-line no-new -- a third instance must NOT spam a second warning
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not warn for two FileSpools at distinct paths', async () => {
    const { dir: dir1, path: path1 } = await makeTmpPath()
    const { dir: dir2, path: path2 } = await makeTmpPath()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      new FileSpool(path1) // eslint-disable-line no-new
      new FileSpool(path2) // eslint-disable-line no-new
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      await rm(dir1, { recursive: true, force: true })
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
