import { Recorder, decideSampling, hashString } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { CreateEventRequest, CreateRunRequest, CreateRunResponse, Run } from '@agent-flight-recorder/contracts'
import type { Transport, TransportAuth } from '@agent-flight-recorder/sdk'

function createMockTransport(): Transport {
  let counter = 0
  return {
    createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
      run: {
        id: `run_${++counter}`,
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
      } as Run,
    })),
    sendEvents: vi.fn(async (events: CreateEventRequest[], _auth: TransportAuth) => ({
      success: true as const,
      eventIds: events.map((_, i) => `evt_${i}`),
    })),
    updateRunStatus: vi.fn(async () => ({ success: true as const, eventIds: [] })),
  }
}

describe('decideSampling — statistical bounds', () => {
  it('rate 0 never samples in (1000 runs)', () => {
    let sampledIn = 0
    for (let i = 0; i < 1000; i++) {
      if (decideSampling({ rate: 0 }, { agentId: 'a', tags: [] }, undefined)) sampledIn++
    }
    expect(sampledIn).toBe(0)
  })

  it('rate 1 always samples in (1000 runs)', () => {
    let sampledIn = 0
    for (let i = 0; i < 1000; i++) {
      if (decideSampling({ rate: 1 }, { agentId: 'a', tags: [] }, undefined)) sampledIn++
    }
    expect(sampledIn).toBe(1000)
  })

  it('rate 0.5 samples roughly half over 1000 runs (seeded via seedFromRunName)', () => {
    let sampledIn = 0
    for (let i = 0; i < 1000; i++) {
      if (decideSampling({ rate: 0.5, seedFromRunName: true }, { agentId: 'a', tags: [] }, `run-${i}`)) sampledIn++
    }
    // Loose statistical bound — deterministic hash distribution, not a coin flip,
    // but should still land close to 50% over 1000 distinct names.
    expect(sampledIn).toBeGreaterThan(350)
    expect(sampledIn).toBeLessThan(650)
  })

  it('seedFromRunName is deterministic for the same run name', () => {
    const a = decideSampling({ rate: 0.5, seedFromRunName: true }, { agentId: 'a', tags: [] }, 'stable-name')
    const b = decideSampling({ rate: 0.5, seedFromRunName: true }, { agentId: 'a', tags: [] }, 'stable-name')
    expect(a).toBe(b)
  })

  it('hashString is stable for a fixed input', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
  })
})

describe('decideSampling — decider override', () => {
  it('decider takes precedence over rate', () => {
    const decider = vi.fn(() => false)
    const result = decideSampling({ rate: 1, decider }, { agentId: 'a', tags: ['x'] }, undefined)
    expect(result).toBe(false)
    expect(decider).toHaveBeenCalledWith({ agentId: 'a', tags: ['x'] })
  })

  it('fails open (samples in) when decider throws', () => {
    const decider = () => {
      throw new Error('boom')
    }
    expect(decideSampling({ rate: 0, decider }, { agentId: 'a', tags: [] }, undefined)).toBe(true)
  })

  it('no config samples every run in', () => {
    expect(decideSampling(undefined, { agentId: 'a', tags: [] }, undefined)).toBe(true)
  })
})

describe('Recorder + sampling — no-op run handle', () => {
  it('an unsampled run never calls transport.createRun', async () => {
    const transport = createMockTransport()
    const recorder = new Recorder(
      { endpoint: 'http://localhost:3000', apiKey: 'k', agentId: 'a', options: { sampling: { rate: 0 } } },
      transport
    )
    const run = await recorder.startRun('input')
    expect(transport.createRun).not.toHaveBeenCalled()
    expect(run.runId).toBeTruthy()
    expect(run.status).toBe('running')
  })

  it('every public method remains callable on an unsampled run', async () => {
    const transport = createMockTransport()
    const recorder = new Recorder(
      { endpoint: 'http://localhost:3000', apiKey: 'k', agentId: 'a', options: { sampling: { rate: 0 } } },
      transport
    )
    const run = await recorder.startRun('input')
    expect(run).toMatchObject({ agentId: 'a', status: 'running' })
    expect(recorder.activeRun).not.toBeNull()

    expect(() => recorder.recordEvent('custom', { type: 'custom', data: 'x' })).not.toThrow()
    await expect(recorder.flush()).resolves.toMatchObject({ success: true })

    const result = await recorder.endRun('output')
    expect(result.success).toBe(true)
    expect(recorder.activeRun).toBeNull()
    // Nothing was ever sent over the wire for the unsampled run.
    expect(transport.sendEvents).not.toHaveBeenCalled()
    expect(transport.updateRunStatus).not.toHaveBeenCalled()
  })

  it('fires onDrop with reason sampled_out, counting discarded events', async () => {
    const transport = createMockTransport()
    const onDrop = vi.fn()
    const recorder = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { sampling: { rate: 0 }, onDrop },
      },
      transport
    )
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'x' })
    recorder.recordEvent('custom', { type: 'custom', data: 'y' })
    await recorder.endRun('output')

    const sampledOutCalls = onDrop.mock.calls.filter(([, reason]) => reason === 'sampled_out')
    expect(sampledOutCalls.length).toBeGreaterThan(0)
    const totalDropped = sampledOutCalls.reduce((sum, [count]) => sum + (count as number), 0)
    // run.started + 2 custom + run.completed = 4 discarded events.
    expect(totalDropped).toBe(4)
  })
})

describe('Recorder + sampling — alwaysKeepFailures round-trip', () => {
  it('discards shadow-buffered events on a successful (endRun) unsampled run', async () => {
    const transport = createMockTransport()
    const recorder = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { sampling: { rate: 0, alwaysKeepFailures: true } },
      },
      transport
    )
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'x' })
    await recorder.endRun('output')

    expect(transport.createRun).not.toHaveBeenCalled()
    expect(transport.sendEvents).not.toHaveBeenCalled()
  })

  it('materializes the run and ships shadow-buffered events when an unsampled run fails', async () => {
    const transport = createMockTransport()
    const recorder = new Recorder(
      {
        endpoint: 'http://localhost:3000',
        apiKey: 'k',
        agentId: 'a',
        options: { sampling: { rate: 0, alwaysKeepFailures: true } },
      },
      transport
    )
    await recorder.startRun('input')
    recorder.recordEvent('custom', { type: 'custom', data: 'x' })
    const result = await recorder.failRun(new Error('boom'))

    expect(transport.createRun).toHaveBeenCalledTimes(1)
    expect(transport.sendEvents).toHaveBeenCalled()
    expect(transport.updateRunStatus).toHaveBeenCalledWith('run_1', 'failed', expect.any(Number), expect.any(Object))
    expect(result.success).toBe(true)

    // The events actually sent include run.started, the custom event, and run.failed.
    const sentEvents: CreateEventRequest[] = (transport.sendEvents as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (call: unknown[]) => call[0] as CreateEventRequest[]
    )
    expect(sentEvents.map((e) => e.type)).toEqual(['run.started', 'custom', 'run.failed'])
    expect(sentEvents.every((e) => e.runId === 'run_1')).toBe(true)
    // Sequence numbers stay contiguous even though they were assigned while sampled out.
    expect(sentEvents.map((e) => e.sequenceNumber)).toEqual([1, 2, 3])
  })
})
