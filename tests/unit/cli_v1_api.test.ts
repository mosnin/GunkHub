/**
 * Tests for the CLI's v1 read-API client (`packages/cli/src/apiClient.ts`)
 * and the commands built on top of it (`runs list|get`, `replay`, `tail`,
 * `export`). Every test uses a mocked `fetch` implementation — no real HTTP,
 * no live backend — per the SDK/CLI quality bar (tests must work offline).
 */
import {
  getRun,
  getRunEvents,
  getRunExplanation,
  getRunReplay,
  listRuns,
  parseExportArgs,
  parseReplayArgs,
  parseRunsGetArgs,
  parseRunsListArgs,
  parseTailArgs,
  printExport,
  printReplay,
  printRunsGet,
  printRunsList,
  printTailSummary,
  runExport,
  runReplay,
  runRunsGet,
  runRunsList,
  runTail,
} from '@agent-flight-recorder/cli'
import { describe, expect, it, vi } from 'vitest'

import type { ApiClientConfig, ApiClientError, ApiFetchLike, V1GetRunData, V1ListRunsData, V1ReplayData } from '@agent-flight-recorder/cli'
import type { Event, Run } from '@agent-flight-recorder/contracts'

const config: ApiClientConfig = { apiKey: 'k', baseUrl: 'http://localhost:3000' }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_abc123456789',
    orgId: 'org_1',
    projectId: 'proj_1',
    agentId: 'agent_1',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_500,
    metadata: {},
    tags: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// apiClient — error mapping
// ---------------------------------------------------------------------------

describe('apiClient — error mapping', () => {
  it('maps 401 to kind=auth, exitCode=2', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } }))
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({
      kind: 'auth',
      exitCode: 2,
      message: 'bad key',
    })
  })

  it('maps 403 to kind=auth, exitCode=2, with a scope-specific default message', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(403, {}))
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({ kind: 'auth', exitCode: 2 })
    try {
      await listRuns(config, {}, fetchImpl)
    } catch (err) {
      expect((err as ApiClientError).message).toContain('read')
    }
  })

  it('maps 404 to kind=not_found, exitCode=3', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    await expect(getRun(config, 'run_x', fetchImpl)).rejects.toMatchObject({
      kind: 'not_found',
      exitCode: 3,
      message: 'Run not found',
    })
  })

  it('maps 429 to kind=rate_limited, exitCode=4, and surfaces retry-after', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () =>
      jsonResponse(429, { error: { message: 'Too many requests' } }, { 'retry-after': '30' })
    )
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({
      kind: 'rate_limited',
      exitCode: 4,
      retryAfterSeconds: 30,
    })
  })

  it('maps 500 to kind=server, exitCode=4', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(500, {}))
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({ kind: 'server', exitCode: 4 })
  })

  it('maps a thrown network error to kind=network, exitCode=4', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({ kind: 'network', exitCode: 4 })
  })

  it('maps a malformed success body (no data field) to kind=invalid_response', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1' }))
    await expect(listRuns(config, {}, fetchImpl)).rejects.toMatchObject({ kind: 'invalid_response', exitCode: 4 })
  })

  it('parses a well-formed envelope and returns only the data field', async () => {
    const data: V1ListRunsData = { runs: [makeRun()], total: 1 }
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    await expect(listRuns(config, {}, fetchImpl)).resolves.toEqual(data)
  })

  it('sends the x-api-key header on every request', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs: [] } }))
    await listRuns(config, {}, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs'), {
      headers: { 'x-api-key': 'k' },
    })
  })

  it('getRunEvents targets /api/v1/runs/:id/events and getRunReplay targets /api/v1/runs/:id/replay', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events: [] } }))
    await getRunEvents(config, 'run_1', {}, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs/run_1/events'), expect.any(Object))

    const replayFetch: ApiFetchLike = vi.fn(async () =>
      jsonResponse(200, {
        apiVersion: 'v1',
        data: { projection: { runId: 'run_1', frames: [], totalEvents: 0, duration_ms: 0, isComplete: true, isFailed: false }, failureSummary: { hasFailure: false, primaryFailure: null, allFailurePoints: [], isIncomplete: false, cannotInfer: false, runId: 'run_1', runStatus: 'completed' } },
      })
    )
    await getRunReplay(config, 'run_1', replayFetch)
    expect(replayFetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs/run_1/replay'), expect.any(Object))
  })

  it('getRunExplanation targets /api/v1/runs/:id/explanation and surfaces the { explanation } data as-is', async () => {
    const data = { explanation: null }
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    await expect(getRunExplanation(config, 'run_1', fetchImpl)).resolves.toEqual(data)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs/run_1/explanation'), expect.any(Object))
  })

  it('getRunExplanation maps a 404 (run not found) to kind=not_found, exitCode=3', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    await expect(getRunExplanation(config, 'missing', fetchImpl)).rejects.toMatchObject({
      kind: 'not_found',
      exitCode: 3,
    })
  })
})

// ---------------------------------------------------------------------------
// runs list
// ---------------------------------------------------------------------------

describe('afr runs list', () => {
  it('parses --status/--agent/--env/--session/--limit/--json', () => {
    const args = parseRunsListArgs(['--status', 'failed', '--agent', 'a1', '--env', 'prod', '--session', 's1', '--limit', '5', '--json'])
    expect(args).toEqual({ status: 'failed', agent: 'a1', env: 'prod', session: 's1', limit: 5, json: true })
  })

  it('fails with a clear message when AFR_API_KEY/AFR_BASE_URL are unset', async () => {
    const result = await runRunsList({}, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(1)
      expect(result.message).toContain('afr config check')
    }
  })

  it('prints "No runs found." for an empty result set', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs: [] } }))
    const result = await runRunsList({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printRunsList({}, result, log)
    expect(log).toHaveBeenCalledWith('No runs found.')
  })

  it('renders an aligned table with truncated ids', async () => {
    const runs = [makeRun({ id: 'run_1234567890123' }), makeRun({ id: 'run_2', status: 'failed' })]
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs } }))
    const result = await runRunsList({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printRunsList({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('ID')
    expect(output).toContain('STATUS')
    expect(output).toContain('completed')
    expect(output).toContain('failed')
    expect(output).toContain('…') // long id truncated
  })

  it('--json prints the raw envelope data', async () => {
    const runs = [makeRun()]
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs } }))
    const result = await runRunsList({ json: true }, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printRunsList({ json: true }, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"runs"'))
  })

  it('maps a 404 from the API into a not-found command failure (exit 3)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'no such project' } }))
    const result = await runRunsList({}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
  })

  it('parses --triage and --label', () => {
    const args = parseRunsListArgs(['--triage', 'investigating', '--label', 'prod'])
    expect(args).toEqual({ triage: 'investigating', label: 'prod' })
  })

  it('--triage filters client-side (the v1 API has no server-side triage filter)', async () => {
    const runs = [
      makeRun({ id: 'run_1', triageState: 'investigating' }),
      makeRun({ id: 'run_2', triageState: 'resolved' }),
      makeRun({ id: 'run_3' }), // no triageState -> defaults to "open"
    ]
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs } }))
    const result = await runRunsList({ triage: 'investigating' }, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.runs.map((r) => r.id)).toEqual(['run_1'])
    }
    // Client-side filter — still only one network call for the page.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('--label filters to runs whose tags include the given value', async () => {
    const runs = [makeRun({ id: 'run_1', tags: ['prod', 'critical'] }), makeRun({ id: 'run_2', tags: ['staging'] })]
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs } }))
    const result = await runRunsList({ label: 'prod' }, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.runs.map((r) => r.id)).toEqual(['run_1'])
    }
  })
})

// ---------------------------------------------------------------------------
// runs get
// ---------------------------------------------------------------------------

describe('afr runs get', () => {
  it('parses the runId positional and --json', () => {
    const args = parseRunsGetArgs(['run_1', '--json'])
    expect(args).toEqual({ runId: 'run_1', json: true })
  })

  it('prints a run detail summary', async () => {
    const data: V1GetRunData = { run: makeRun({ environment: 'prod', tags: ['a', 'b'] }), eventCount: 4, artifactCount: 1 }
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const result = await runRunsGet('run_abc123456789', { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printRunsGet({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('Run:')
    expect(output).toContain('completed')
    expect(output).toContain('Environment:  prod')
    expect(output).toContain('Tags:         a, b')
    expect(output).toContain('Events:       4')
  })

  it('surfaces a 404 as "Run not found" with exit code 3', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const result = await runRunsGet('missing', { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(3)
      const log = vi.fn()
      printRunsGet({}, result, log)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Run not found'))
    }
  })
})

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

describe('afr replay', () => {
  it('parses the runId positional and --json', () => {
    expect(parseReplayArgs(['run_1', '--json'])).toEqual({ runId: 'run_1', json: true })
  })

  it('renders a transcript from RUN_STARTED to the terminal event', async () => {
    const replayData: V1ReplayData = {
      projection: {
        runId: 'run_1',
        totalEvents: 2,
        duration_ms: 500,
        isComplete: true,
        isFailed: false,
        frames: [
          {
            event: { id: 'e1', runId: 'run_1', orgId: 'org_1', type: 'run.started', sequenceNumber: 1, timestamp: 1, payload: { type: 'run.started', input: {}, config: {} } },
            index: 0,
            elapsed_ms: 0,
            actor: 'agent',
            status: 'ok',
            payloadPreview: 'run started',
            depth: 0,
          },
          {
            event: { id: 'e2', runId: 'run_1', orgId: 'org_1', type: 'run.completed', sequenceNumber: 2, timestamp: 500, payload: { type: 'run.completed', output: {}, duration_ms: 500 } },
            index: 1,
            elapsed_ms: 500,
            actor: 'agent',
            status: 'terminal',
            payloadPreview: 'run completed',
            depth: 0,
          },
        ],
      },
      failureSummary: { hasFailure: false, primaryFailure: null, allFailurePoints: [], isIncomplete: false, cannotInfer: false, runId: 'run_1', runStatus: 'completed' },
    }
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: replayData }))
    const result = await runReplay('run_1', { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printReplay({}, result, log)
    const output = log.mock.calls.map((c) => c[0] as string).join('\n')
    expect(output).toContain('run.started')
    expect(output).toContain('run.completed')
    expect(output).toContain('[DONE]')
  })

  it('surfaces a failure summary when the run failed', async () => {
    const replayData: V1ReplayData = {
      projection: {
        runId: 'run_1',
        totalEvents: 1,
        duration_ms: 10,
        isComplete: true,
        isFailed: true,
        frames: [
          {
            event: { id: 'e1', runId: 'run_1', orgId: 'org_1', type: 'run.failed', sequenceNumber: 1, timestamp: 1, payload: { type: 'run.failed', error: { message: 'boom' }, duration_ms: 10 } },
            index: 0,
            elapsed_ms: 10,
            actor: 'agent',
            status: 'error',
            payloadPreview: 'run failed: boom',
            depth: 0,
          },
        ],
      },
      failureSummary: {
        hasFailure: true,
        primaryFailure: { eventId: 'e1', sequenceNumber: 1, type: 'run.failed', errorMessage: 'boom', reason: 'run_failed' },
        allFailurePoints: [],
        isIncomplete: false,
        cannotInfer: false,
        runId: 'run_1',
        runStatus: 'failed',
      },
    }
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: replayData }))
    const result = await runReplay('run_1', { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    const log = vi.fn()
    printReplay({}, result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

describe('afr tail', () => {
  it('parses --interval and the runId positional', () => {
    expect(parseTailArgs(['run_1', '--interval', '500'])).toEqual({ runId: 'run_1', interval: 500 })
  })

  it('stops as soon as a terminal event is seen', async () => {
    const events: Event[] = [
      { id: 'e1', runId: 'run_1', orgId: 'org_1', type: 'run.started', sequenceNumber: 1, timestamp: 1, payload: { type: 'run.started', input: {}, config: {} } },
      { id: 'e2', runId: 'run_1', orgId: 'org_1', type: 'run.completed', sequenceNumber: 2, timestamp: 2, payload: { type: 'run.completed', output: {}, duration_ms: 1 } },
    ]
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events } }))
    const sleep = vi.fn(async () => undefined)
    const log = vi.fn()

    const result = await runTail(
      'run_1',
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      { sleep, maxIterations: 5 },
      log
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stopReason).toBe('terminal')
      expect(result.eventsSeen).toBe(2)
    }
    // Terminal event on the very first poll — no need to have slept before stopping.
    expect(sleep).not.toHaveBeenCalled()
    printTailSummary(result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('terminal state'))
  })

  it('stops after maxIterations when no terminal event ever arrives (simulated Ctrl-C-free timeout)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events: [] } }))
    const sleep = vi.fn(async () => undefined)

    const result = await runTail(
      'run_1',
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      { sleep, maxIterations: 3 },
      vi.fn()
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stopReason).toBe('timeout')
      expect(result.eventsSeen).toBe(0)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('stops immediately when shouldStop() returns true (Ctrl-C)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events: [] } }))
    const result = await runTail(
      'run_1',
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      { shouldStop: () => true },
      vi.fn()
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.stopReason).toBe('interrupted')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces an API error as a command failure instead of looping forever', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const result = await runTail('missing', { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl, { maxIterations: 5 }, vi.fn())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe('afr export', () => {
  it('parses --out/--format and the runId positional', () => {
    expect(parseExportArgs(['run_1', '--out', 'bundle.ndjson', '--format', 'json'])).toEqual({
      runId: 'run_1',
      out: 'bundle.ndjson',
      format: 'json',
    })
  })

  it('assembles a bundle from run + paginated events + replay via the v1 API (no /api/export call)', async () => {
    const run = makeRun()
    const events: Event[] = [
      { id: 'e1', runId: run.id, orgId: 'org_1', type: 'run.started', sequenceNumber: 1, timestamp: 1, payload: { type: 'run.started', input: {}, config: {} } },
    ]
    const replay: V1ReplayData = {
      projection: { runId: run.id, totalEvents: 1, duration_ms: 0, isComplete: true, isFailed: false, frames: [] },
      failureSummary: { hasFailure: false, primaryFailure: null, allFailurePoints: [], isIncomplete: false, cannotInfer: false, runId: run.id, runStatus: 'completed' },
    }

    const fetchImpl: ApiFetchLike = vi.fn(async (url: string) => {
      if (url.includes('/replay')) return jsonResponse(200, { apiVersion: 'v1', data: replay })
      if (url.includes('/events')) return jsonResponse(200, { apiVersion: 'v1', data: { events } })
      return jsonResponse(200, { apiVersion: 'v1', data: { run, eventCount: 1, artifactCount: 0 } })
    })

    const result = await runExport(run.id, {}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.eventCount).toBe(1)
      expect(result.content).toContain('"record":"run"')
      expect(result.content).toContain('"record":"event"')
      expect(result.content).toContain('"record":"replay"')
    }
    for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0] as string).not.toContain('/api/export/')
    }
  })

  it('writes to --out via the injectable file writer instead of touching a real filesystem', async () => {
    const run = makeRun()
    const fetchImpl: ApiFetchLike = vi.fn(async (url: string) => {
      if (url.includes('/replay')) {
        return jsonResponse(200, {
          apiVersion: 'v1',
          data: { projection: { runId: run.id, totalEvents: 0, duration_ms: 0, isComplete: true, isFailed: false, frames: [] }, failureSummary: { hasFailure: false, primaryFailure: null, allFailurePoints: [], isIncomplete: false, cannotInfer: false, runId: run.id, runStatus: 'completed' } },
        })
      }
      if (url.includes('/events')) return jsonResponse(200, { apiVersion: 'v1', data: { events: [] } })
      return jsonResponse(200, { apiVersion: 'v1', data: { run, eventCount: 0, artifactCount: 0 } })
    })
    const writeFileImpl = vi.fn(async () => undefined)

    const result = await runExport(
      run.id,
      { out: '/tmp/bundle.ndjson' },
      { apiKey: 'k', baseUrl: 'http://localhost:3000' },
      fetchImpl,
      writeFileImpl
    )

    expect(result.ok).toBe(true)
    expect(writeFileImpl).toHaveBeenCalledWith('/tmp/bundle.ndjson', expect.stringContaining('"record":"run"'))
    const log = vi.fn()
    printExport(result, log)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Wrote'))
  })

  it('surfaces a 404 while assembling as a command failure (exit 3)', async () => {
    const fetchImpl: ApiFetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const result = await runExport('missing', {}, { apiKey: 'k', baseUrl: 'http://localhost:3000' }, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(3)
  })
})
