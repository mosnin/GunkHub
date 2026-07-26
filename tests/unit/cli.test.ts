import { CLI_VERSION, main, printConfigCheck, runConfigCheck, runRecordDemo } from '@agent-flight-recorder/cli'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FetchLike } from '@agent-flight-recorder/cli'
import type { CreateEventRequest, CreateRunRequest, CreateRunResponse, Run } from '@agent-flight-recorder/contracts'
import type { Transport, TransportAuth } from '@agent-flight-recorder/sdk'

function createMockTransport(): Transport {
  return {
    createRun: vi.fn(async (req: CreateRunRequest): Promise<CreateRunResponse> => ({
      run: {
        id: 'run_cli_demo',
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

describe('afr CLI — version', () => {
  it('CLI_VERSION is a semver string', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('main(["version"]) prints version lines and exits 0', async () => {
    const log = vi.fn()
    const code = await main(['version'], log)
    expect(code).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('afr'))
  })
})

describe('afr CLI — arg parsing / dispatch', () => {
  it('no command prints help and exits 1', async () => {
    const log = vi.fn()
    const code = await main([], log)
    expect(code).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage'))
  })

  it('--help prints help and exits 0', async () => {
    const log = vi.fn()
    const code = await main(['--help'], log)
    expect(code).toBe(0)
  })

  it('unknown command exits 1 with a message', async () => {
    const log = vi.fn()
    const code = await main(['bogus'], log)
    expect(code).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Unknown command'))
  })

  it('unknown config subcommand exits 1', async () => {
    const log = vi.fn()
    const code = await main(['config', 'bogus'], log)
    expect(code).toBe(1)
  })

  describe('v1-read-API commands without AFR_API_KEY / AFR_BASE_URL configured', () => {
    const originalEnv = { ...process.env }

    beforeEach(() => {
      delete process.env['AFR_API_KEY']
      delete process.env['AFR_BASE_URL']
    })

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    for (const cmd of [['runs', 'list'], ['runs', 'get', 'run_1'], ['replay', 'run_1'], ['tail', 'run_1'], ['export', 'run_1'], ['patterns']]) {
      it(`'afr ${cmd.join(' ')}' exits 1 and points at 'afr config check'`, async () => {
        const log = vi.fn()
        const code = await main(cmd, log)
        expect(code).toBe(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('afr config check'))
      })
    }
  })

  for (const cmd of [['runs', 'list'], ['runs', 'get'], ['replay'], ['tail'], ['export'], ['patterns']]) {
    it(`'afr ${cmd.join(' ')} --help' prints usage and exits 0`, async () => {
      const log = vi.fn()
      const code = await main([...cmd, '--help'], log)
      expect(code).toBe(0)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
    })
  }

  for (const cmd of [['runs', 'get'], ['replay'], ['tail'], ['export']]) {
    it(`'afr ${cmd.join(' ')}' without a runId exits 1 with a usage message`, async () => {
      const log = vi.fn()
      const code = await main(cmd, log)
      expect(code).toBe(1)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'))
    })
  }
})

describe('afr CLI — config check', () => {
  it('fails when AFR_API_KEY / AFR_BASE_URL are unset', async () => {
    const result = await runConfigCheck({})
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'AFR_API_KEY')?.status).toBe('fail')
    expect(result.checks.find((c) => c.name === 'AFR_BASE_URL')?.status).toBe('fail')
  })

  it('pings /api/health with a mocked fetch and reports ok on 200', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }))
    const result = await runConfigCheck({ apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/api/health')
  })

  it('reports fail when /api/health returns non-2xx', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 503 }))
    const result = await runConfigCheck({ apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'GET /api/health')?.status).toBe('fail')
  })

  it('reports fail when fetch throws (network error)', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await runConfigCheck({ apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'GET /api/health')?.message).toContain('ECONNREFUSED')
  })

  it('printConfigCheck logs one line per check', () => {
    const log = vi.fn()
    printConfigCheck({ ok: true, checks: [{ name: 'X', status: 'ok', message: 'set' }] }, log)
    expect(log).toHaveBeenCalledWith('[ok] X: set')
  })
})

describe('afr CLI — record demo', () => {
  it('fails fast with a clear message when env vars are missing', async () => {
    const result = await runRecordDemo({})
    expect(result.success).toBe(false)
    expect(result.errors[0]).toContain('AFR_API_KEY')
  })

  it('runs the demo agent end-to-end against a mock transport', async () => {
    const transport = createMockTransport()
    const result = await runRecordDemo({ apiKey: 'k', baseUrl: 'http://localhost:3000' }, transport)

    expect(result.success).toBe(true)
    expect(result.runId).toBe('run_cli_demo')
    expect(result.eventsRecorded).toBe(4)
    expect(transport.createRun).toHaveBeenCalledTimes(1)
    expect(transport.sendEvents).toHaveBeenCalled()
    expect(transport.updateRunStatus).toHaveBeenCalledWith('run_cli_demo', 'completed', expect.any(Number), expect.any(Object))
  })

  it('never touches real HTTP — no global fetch call is made', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const transport = createMockTransport()
    await runRecordDemo({ apiKey: 'k', baseUrl: 'http://localhost:3000' }, transport)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
