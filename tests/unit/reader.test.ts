/**
 * Tests for the SDK's read client: `FlightReader` (packages/sdk/src/reader.ts)
 * and the shared v1 fetch/envelope/error-mapping core it's built on
 * (packages/sdk/src/v1-client.ts — the ONE source of truth also used by
 * `@agent-flight-recorder/cli`'s `apiClient.ts`, see tests/unit/cli_v1_api.test.ts
 * for the CLI-side coverage of the same mapping).
 *
 * Every test uses a mocked fetch — no real HTTP, no live backend.
 */
import { FlightReader, V1ApiError, fetchV1, messageFromV1Body, tryParseV1Json } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { Event, Run } from '@agent-flight-recorder/contracts'
import type { V1FetchLike } from '@agent-flight-recorder/sdk'

const config = { baseUrl: 'http://localhost:3000', apiKey: 'k' }

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

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    runId: 'run_1',
    orgId: 'org_1',
    type: 'run.started',
    sequenceNumber: 1,
    timestamp: 1,
    payload: { type: 'run.started', input: {}, config: {} },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// FlightReader — happy paths
// ---------------------------------------------------------------------------

describe('FlightReader', () => {
  it('listRuns() sends x-api-key and hits GET /api/v1/runs with filters as query params', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { runs: [makeRun()] } }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.listRuns({ status: 'failed', agentId: 'agent_1', limit: 10 })

    expect(result.runs).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/runs\?.*status=failed.*agentId=agent_1.*limit=10|\/api\/v1\/runs\?.*agentId=agent_1.*status=failed.*limit=10/),
      { headers: { 'x-api-key': 'k' } }
    )
  })

  it('getRun() hits GET /api/v1/runs/:id', async () => {
    const run = makeRun()
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { run, eventCount: 3, artifactCount: 0 } }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getRun(run.id)

    expect(result.run.id).toBe(run.id)
    expect(result.eventCount).toBe(3)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining(`/api/v1/runs/${run.id}`), expect.any(Object))
  })

  it('getRunEvents() paginates via cursor/limit params', async () => {
    const events = [makeEvent()]
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events, nextCursor: 'cur-2' } }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getRunEvents('run_1', { limit: 50, cursor: 'cur-1' })

    expect(result.events).toEqual(events)
    expect(result.nextCursor).toBe('cur-2')
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/runs\/run_1\/events\?.*limit=50.*cursor=cur-1|\/api\/v1\/runs\/run_1\/events\?.*cursor=cur-1.*limit=50/),
      expect.any(Object)
    )
  })

  it('iterateEvents() transparently pages through multiple event pages', async () => {
    const page1 = [makeEvent({ id: 'e1', sequenceNumber: 1 }), makeEvent({ id: 'e2', sequenceNumber: 2 })]
    const page2 = [makeEvent({ id: 'e3', sequenceNumber: 3 })]

    const fetchImpl: V1FetchLike = vi.fn(async (url: string) => {
      if (url.includes('cursor=cur-1')) {
        return jsonResponse(200, { apiVersion: 'v1', data: { events: page2 } }) // no nextCursor -> last page
      }
      return jsonResponse(200, { apiVersion: 'v1', data: { events: page1, nextCursor: 'cur-1' } })
    })

    const reader = new FlightReader(config, fetchImpl)
    const seen: Event[] = []
    for await (const event of reader.iterateEvents('run_1', { pageSize: 2 })) {
      seen.push(event)
    }

    expect(seen.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('iterateEvents() stops after the first page when the response carries no nextCursor', async () => {
    const events = [makeEvent()]
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events } }))
    const reader = new FlightReader(config, fetchImpl)
    const seen: Event[] = []
    for await (const event of reader.iterateEvents('run_1')) {
      seen.push(event)
    }
    expect(seen).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('iterateEvents() lets a consumer break out early without fetching further pages', async () => {
    const page1 = [makeEvent({ id: 'e1' }), makeEvent({ id: 'e2' })]
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { events: page1, nextCursor: 'cur-1' } }))
    const reader = new FlightReader(config, fetchImpl)
    const seen: Event[] = []
    for await (const event of reader.iterateEvents('run_1')) {
      seen.push(event)
      break
    }
    expect(seen).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1) // never fetched page 2
  })

  it('iterateEvents() throws instead of looping forever when the server returns a non-advancing cursor', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () =>
      jsonResponse(200, { apiVersion: 'v1', data: { events: [makeEvent()], nextCursor: 'stuck' } })
    )
    const reader = new FlightReader(config, fetchImpl)
    const seen: Event[] = []
    await expect(async () => {
      for await (const event of reader.iterateEvents('run_1')) {
        seen.push(event)
        if (seen.length > 3) break // safety valve in case the guard regresses
      }
    }).rejects.toMatchObject({ kind: 'invalid_response' })
    // Only the first request should have happened before the second page came
    // back with the SAME cursor it was given, tripping the guard.
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('iterateEvents() respects an explicit maxPages bound', async () => {
    let calls = 0
    const fetchImpl: V1FetchLike = vi.fn(async () => {
      calls++
      return jsonResponse(200, { apiVersion: 'v1', data: { events: [makeEvent()], nextCursor: `cur-${calls}` } })
    })
    const reader = new FlightReader(config, fetchImpl)
    const seen: Event[] = []
    await expect(async () => {
      for await (const event of reader.iterateEvents('run_1', { maxPages: 3 })) {
        seen.push(event)
      }
    }).rejects.toMatchObject({ kind: 'invalid_response' })
    expect(calls).toBe(3)
  })

  it('getReplay() hits GET /api/v1/runs/:id/replay', async () => {
    const replay = {
      projection: { runId: 'run_1', frames: [], totalEvents: 0, duration_ms: 0, isComplete: true, isFailed: false },
      failureSummary: { hasFailure: false, primaryFailure: null, allFailurePoints: [], isIncomplete: false, cannotInfer: false, runId: 'run_1', runStatus: 'completed' },
    }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: replay }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getReplay('run_1')
    expect(result).toEqual(replay)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs/run_1/replay'), expect.any(Object))
  })
})

// ---------------------------------------------------------------------------
// FlightReader.getExplanation — the "explainability layer" root-cause read
// ---------------------------------------------------------------------------

describe('FlightReader.getExplanation', () => {
  it('hits GET /api/v1/runs/:id/explanation with x-api-key auth', async () => {
    const data = { explanation: null }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getExplanation('run_1')
    expect(result).toEqual(data)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/runs/run_1/explanation'), {
      headers: { 'x-api-key': 'k' },
    })
  })

  it('resolves a full RunExplanation when one is cached', async () => {
    const data = {
      explanation: {
        id: 'exp_1',
        orgId: 'org_1',
        runId: 'run_1',
        kind: 'heuristic',
        summary: 'The agent called a tool that timed out and never recovered.',
        rootCause: 'The `lookup_order` tool call at seq=4 exceeded its timeout.',
        suggestedFix: 'Add a retry with backoff around `lookup_order`.',
        citedSequenceNumbers: [3, 4, 5],
        failureClass: 'tool_error',
        generatedAt: 1_700_000_000_000,
        version: 1,
      },
    }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getExplanation('run_1')
    expect(result).toEqual(data)
  })

  it("resolves { explanation: null } without throwing — a successful, honest 'nothing to show yet' result, not an error", async () => {
    const data = { explanation: null }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getExplanation('run_1')).resolves.toEqual(data)
  })

  it('still throws V1ApiError for a genuine failure (run not found)', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getExplanation('missing')).rejects.toMatchObject({ kind: 'not_found', message: 'Run not found' })
  })
})

// ---------------------------------------------------------------------------
// FlightReader.getFailurePatterns — Failure Patterns (PREVENTION cycle 1)
// ---------------------------------------------------------------------------

describe('FlightReader.getFailurePatterns', () => {
  function makePattern(overrides: Partial<import('@agent-flight-recorder/contracts').FailurePattern> = {}) {
    return {
      id: 'fp_1',
      orgId: 'org_1',
      fingerprintHash: 'hash_1',
      class: 'tool_error',
      label: 'lookup_order tool call times out',
      salientKey: 'lookup_order',
      count: 12,
      firstSeenAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_500_000,
      representativeRunIds: ['run_1', 'run_2'],
      affectedAgentVersionIds: ['av_1'],
      ...overrides,
    }
  }

  it('hits GET /api/v1/patterns with x-api-key auth, no filters', async () => {
    const data = { patterns: [makePattern()] }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getFailurePatterns()
    expect(result).toEqual(data)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/v1/patterns'), {
      headers: { 'x-api-key': 'k' },
    })
  })

  it('sends agentId/limit/cursor as query params', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: { patterns: [] } }))
    const reader = new FlightReader(config, fetchImpl)
    await reader.getFailurePatterns({ agentId: 'agent_1', limit: 10, cursor: 'cur-1' })
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).toContain('/api/v1/patterns')
    expect(url).toContain('agentId=agent_1')
    expect(url).toContain('limit=10')
    expect(url).toContain('cursor=cur-1')
  })

  it('resolves an empty list without throwing when the org has no patterns', async () => {
    const data = { patterns: [] }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getFailurePatterns()).resolves.toEqual(data)
  })

  it('still throws V1ApiError for a genuine failure', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(500, {}))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getFailurePatterns()).rejects.toMatchObject({ kind: 'server' })
  })
})

// ---------------------------------------------------------------------------
// FlightReader — error classes (mirrors the CLI's apiClient error mapping —
// both share fetchV1/V1ApiError under the hood)
// ---------------------------------------------------------------------------

describe('FlightReader — error mapping via the shared V1ApiError', () => {
  it('401 -> kind=auth', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.listRuns()).rejects.toMatchObject({ kind: 'auth', message: 'bad key', code: 'UNAUTHORIZED' })
    await expect(reader.listRuns()).rejects.toBeInstanceOf(V1ApiError)
  })

  it('403 -> kind=auth, with a scope-specific default message', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(403, {}))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getRun('run_1')).rejects.toMatchObject({ kind: 'auth' })
    try {
      await reader.getRun('run_1')
    } catch (err) {
      expect((err as V1ApiError).message).toContain('read')
    }
  })

  it('404 -> kind=not_found', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(404, { error: { message: 'Run not found' } }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.getRun('missing')).rejects.toMatchObject({ kind: 'not_found', message: 'Run not found' })
  })

  it('429 -> kind=rate_limited, surfaces retry-after', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '30' }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.listRuns()).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 })
  })

  it('500 -> kind=server', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(500, {}))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.listRuns()).rejects.toMatchObject({ kind: 'server' })
  })

  it('a thrown network error -> kind=network', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.listRuns()).rejects.toMatchObject({ kind: 'network' })
  })

  it('a malformed success body (no data field) -> kind=invalid_response', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1' }))
    const reader = new FlightReader(config, fetchImpl)
    await expect(reader.listRuns()).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})

// ---------------------------------------------------------------------------
// Shared envelope-parse helpers (v1-client.ts)
// ---------------------------------------------------------------------------

describe('shared v1-client helpers', () => {
  it('fetchV1 resolves the data field of a well-formed envelope', async () => {
    const data = { runs: [] }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
    await expect(fetchV1(config, '/api/v1/runs', {}, fetchImpl)).resolves.toEqual(data)
  })

  it('fetchV1 omits undefined params from the query string', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data: {} }))
    await fetchV1(config, '/api/v1/runs', { status: undefined, limit: 5 }, fetchImpl)
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    expect(url).not.toContain('status=')
    expect(url).toContain('limit=5')
  })

  it('tryParseV1Json never throws on a body whose .json() rejects', async () => {
    const res = { json: () => Promise.reject(new Error('bad body')) }
    await expect(tryParseV1Json(res)).resolves.toBeUndefined()
  })

  it('messageFromV1Body extracts error.message, else falls back', () => {
    expect(messageFromV1Body({ error: { message: 'oops' } }, 'fallback')).toBe('oops')
    expect(messageFromV1Body({}, 'fallback')).toBe('fallback')
    expect(messageFromV1Body(undefined, 'fallback')).toBe('fallback')
  })

  it('V1ApiError carries kind/status/retryAfterSeconds/code', () => {
    const err = new V1ApiError('rate_limited', 'slow down', { status: 429, retryAfterSeconds: 30, code: 'RATE_LIMITED' })
    expect(err.kind).toBe('rate_limited')
    expect(err.status).toBe(429)
    expect(err.retryAfterSeconds).toBe(30)
    expect(err.code).toBe('RATE_LIMITED')
    expect(err).toBeInstanceOf(Error)
  })
})
