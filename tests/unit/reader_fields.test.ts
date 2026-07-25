/**
 * Tests for `fields` projection on `FlightReader` (packages/sdk/src/reader.ts),
 * added in SDK 0.15.0.
 *
 * Three properties carry this feature, and each is pinned here:
 *
 *   1. `fields` is forwarded as `?fields=a,b,c`, and OMITTING it changes
 *      nothing — no query param, full document, exactly as before. Backward
 *      compatibility is the whole reason this is opt-in.
 *   2. The identity field comes back regardless of what was asked for, so a
 *      projected document is never anonymous. It is NOT `id` on every
 *      resource — see `PROJECTION_IDENTITY_FIELDS`.
 *   3. If the server IGNORED `?fields=` (older deployment — an unknown query
 *      param is silently dropped and the FULL document comes back), the read
 *      fails loudly instead of handing back a full document that is
 *      indistinguishable from a projection which happened to include
 *      everything. This is the same class of silent wrong answer that
 *      `getRunEventWindow` already refuses for `fromSequence`.
 *
 * The false-positive guards on (3) matter as much as (3) itself: a check that
 * fires when the server behaved correctly is worse than no check, because it
 * breaks working code. Missing fields, empty pages, and un-projected requests
 * are all explicitly NOT evidence, and each has a test.
 *
 * Every test uses a mocked fetch — no real HTTP, no live backend.
 */
import { FlightReader, PROJECTION_IDENTITY_FIELDS, V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { Event, FailurePattern, Run } from '@agent-flight-recorder/contracts'
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

/** A fetch that answers any v1 GET with `{ apiVersion, data }`. */
function dataFetch(data: unknown): V1FetchLike {
  return vi.fn(async () => jsonResponse(200, { apiVersion: 'v1', data }))
}

/** The query string of the single call the reader made. */
function queryOf(fetchImpl: V1FetchLike): URLSearchParams {
  const mock = fetchImpl as unknown as { mock: { calls: [string][] } }
  expect(mock.mock.calls).toHaveLength(1)
  return new URL(mock.mock.calls[0]![0]).searchParams
}

/** A full run document, as an un-projecting (or projection-ignoring) server returns it. */
function fullRun(id = 'run_1'): Run {
  return {
    id,
    orgId: 'org_1',
    projectId: 'proj_1',
    agentId: 'agent_1',
    status: 'failed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    metadata: {},
    tags: [],
  }
}

/** The same run as the server would return it for `?fields=status,startedAt`. */
function projectedRun(id = 'run_1'): unknown {
  return { id, status: 'failed', startedAt: 1_700_000_000_000 }
}

function fullEvent(sequenceNumber: number): Event {
  return {
    id: `e${sequenceNumber}`,
    runId: 'run_1',
    orgId: 'org_1',
    type: 'tool.call',
    sequenceNumber,
    timestamp: 1_700_000_000_000 + sequenceNumber,
    payload: { type: 'tool.call', name: 'search', input: {}, call_id: `call_${sequenceNumber}` },
  } as Event
}

function projectedEvent(sequenceNumber: number): unknown {
  return { id: `e${sequenceNumber}`, type: 'tool.call', sequenceNumber }
}

function fullPattern(): FailurePattern {
  return {
    id: 'fp_1',
    orgId: 'org_1',
    fingerprintHash: 'a'.repeat(64),
    class: 'tool_error',
    label: 'search timed out',
    salientKey: 'search',
    count: 12,
    firstSeenAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_900_000,
    representativeRunIds: ['run_1'],
    affectedAgentVersionIds: ['ver_1'],
  } as FailurePattern
}

// ---------------------------------------------------------------------------
// The request it makes
// ---------------------------------------------------------------------------

describe('fields — request shape', () => {
  it('forwards a comma-joined fields param on listRuns', async () => {
    const fetchImpl = dataFetch({ runs: [projectedRun()] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.listRuns({ status: 'failed', fields: ['status', 'startedAt'] })

    const params = queryOf(fetchImpl)
    expect(params.get('fields')).toBe('status,startedAt')
    // Existing filters still travel alongside it.
    expect(params.get('status')).toBe('failed')
  })

  it('forwards fields on getRun', async () => {
    const fetchImpl = dataFetch({ run: projectedRun(), eventCount: 3, artifactCount: 0 })
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRun('run_1', { fields: ['status', 'startedAt'] })

    expect(queryOf(fetchImpl).get('fields')).toBe('status,startedAt')
  })

  it('forwards fields on getRunEvents', async () => {
    const fetchImpl = dataFetch({ events: [projectedEvent(1)] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRunEvents('run_1', { limit: 50, fields: ['type', 'sequenceNumber'] })

    const params = queryOf(fetchImpl)
    expect(params.get('fields')).toBe('type,sequenceNumber')
    expect(params.get('limit')).toBe('50')
  })

  it('forwards fields on getFailurePatterns', async () => {
    const fetchImpl = dataFetch({ patterns: [{ id: 'fp_1', label: 'search timed out', count: 12 }] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.getFailurePatterns({ spiking: true, fields: ['label', 'count'] })

    const params = queryOf(fetchImpl)
    expect(params.get('fields')).toBe('label,count')
    expect(params.get('spiking')).toBe('true')
  })

  it('passes an unrecognized-looking field straight through — the vocabulary is the server\'s', async () => {
    // No client-side allow-list: a field this SDK build has never heard of is
    // forwarded, and it is the SERVER's job to accept or 400 it. A hardcoded
    // client copy would reject fields a newer deployment supports.
    const fetchImpl = dataFetch({ runs: [{ id: 'run_1', someBrandNewServerField: 1 }] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.listRuns({ fields: ['someBrandNewServerField'] })

    expect(queryOf(fetchImpl).get('fields')).toBe('someBrandNewServerField')
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility: omitting `fields` must change nothing at all
// ---------------------------------------------------------------------------

describe('fields — omitted means full document, unchanged', () => {
  it('sends no fields param and returns the full run list', async () => {
    const fetchImpl = dataFetch({ runs: [fullRun()] })
    const reader = new FlightReader(config, fetchImpl)

    const { runs } = await reader.listRuns({ status: 'failed' })

    expect(queryOf(fetchImpl).has('fields')).toBe(false)
    expect(runs[0]).toEqual(fullRun())
  })

  it('sends no fields param on getRun / getRunEvents / getFailurePatterns / getRunEventWindow', async () => {
    for (const call of [
      async (r: FlightReader) => r.getRun('run_1'),
      async (r: FlightReader) => r.getRunEvents('run_1'),
      async (r: FlightReader) => r.getFailurePatterns(),
      async (r: FlightReader) => r.getRunEventWindow('run_1', { fromSequence: 1 }),
    ]) {
      const fetchImpl = dataFetch({
        run: fullRun(),
        eventCount: 1,
        artifactCount: 0,
        events: [fullEvent(1)],
        patterns: [fullPattern()],
      })
      await call(new FlightReader(config, fetchImpl))
      expect(queryOf(fetchImpl).has('fields')).toBe(false)
    }
  })

  it('never throws the ignored-projection error when no projection was asked for', async () => {
    // A full document is the CORRECT answer here. The capability check must
    // have nothing to say about it.
    const fetchImpl = dataFetch({ runs: [fullRun()] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns()).resolves.toMatchObject({ runs: [fullRun()] })
  })
})

// ---------------------------------------------------------------------------
// The identity field always comes back
// ---------------------------------------------------------------------------

describe('fields — identity', () => {
  it('the identity field is per-resource, not `id` everywhere', () => {
    // convex/read_api.ts §FIELD PROJECTION rule 3 / docs/api_reference.md:
    // an event is addressed by its sequenceNumber within its run and a
    // failure pattern by its fingerprintHash.
    expect(PROJECTION_IDENTITY_FIELDS.events).toContain('sequenceNumber')
    expect(PROJECTION_IDENTITY_FIELDS.patterns).toContain('fingerprintHash')
  })

  it('an unrequested run identity is tolerated under BOTH spellings', async () => {
    // The v1 envelope has historically shown a run's key as `id` while the
    // backend projects the raw Convex document, whose key is `_id`; the docs
    // record that naming as unresolved. Accusing the server of ignoring the
    // projection because it used the other spelling would break a working
    // call, so both are allowed.
    for (const doc of [
      { id: 'run_1', status: 'failed' },
      { _id: 'run_1', status: 'failed' },
    ]) {
      const reader = new FlightReader(config, dataFetch({ runs: [doc] }))
      await expect(reader.listRuns({ fields: ['status'] })).resolves.toBeDefined()
    }
  })

  it('an unrequested sequenceNumber / fingerprintHash is tolerated on its own resource', async () => {
    const events = new FlightReader(config, dataFetch({ events: [{ type: 'tool.call', sequenceNumber: 7 }] }))
    await expect(events.getRunEvents('run_1', { fields: ['type'] })).resolves.toBeDefined()

    const patterns = new FlightReader(config, dataFetch({ patterns: [{ label: 'x', fingerprintHash: 'h' }] }))
    await expect(patterns.getFailurePatterns({ fields: ['label'] })).resolves.toBeDefined()
  })

  it('naming the identity field explicitly is harmless (redundant, not an error)', async () => {
    const fetchImpl = dataFetch({ runs: [{ id: 'run_1', status: 'failed' }] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['id', 'status'] })).resolves.toBeDefined()
    expect(queryOf(fetchImpl).get('fields')).toBe('id,status')
  })
})

// ---------------------------------------------------------------------------
// The capability check — the reason a projected read can be trusted
// ---------------------------------------------------------------------------

describe('fields — refuses a silently ignored projection', () => {
  it('throws invalid_response when listRuns gets a full run back', async () => {
    // Exactly what a deployment that predates ?fields= does: unknown query
    // param dropped, full document returned.
    const fetchImpl = dataFetch({ runs: [fullRun()] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['status'] })).rejects.toThrow(V1ApiError)
  })

  it('the thrown error names the missing server support, not a generic parse failure', async () => {
    const fetchImpl = dataFetch({ runs: [fullRun()] })
    const reader = new FlightReader(config, fetchImpl)

    const err = await reader.listRuns({ fields: ['status'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(V1ApiError)
    expect((err as V1ApiError).kind).toBe('invalid_response')
    expect((err as Error).message).toContain('does not support field projection')
    expect((err as Error).message).toContain('GET /api/v1/runs')
    // It names both what was asked for and what came back unasked.
    expect((err as Error).message).toContain('status')
    expect((err as Error).message).toContain('metadata')
    // No HTTP status: this is not a server rejection, it is a server that
    // answered 200 with the wrong thing.
    expect((err as V1ApiError).status).toBeUndefined()
  })

  it('throws on getRun, getRunEvents and getFailurePatterns alike', async () => {
    const cases: [string, (r: FlightReader) => Promise<unknown>, unknown][] = [
      ['getRun', (r) => r.getRun('run_1', { fields: ['status'] }), { run: fullRun(), eventCount: 1, artifactCount: 0 }],
      ['getRunEvents', (r) => r.getRunEvents('run_1', { fields: ['type'] }), { events: [fullEvent(1)] }],
      ['getFailurePatterns', (r) => r.getFailurePatterns({ fields: ['label'] }), { patterns: [fullPattern()] }],
    ]

    for (const [name, call, data] of cases) {
      const reader = new FlightReader(config, dataFetch(data))
      const err = await call(reader).catch((e: unknown) => e)
      expect(err, name).toBeInstanceOf(V1ApiError)
      expect((err as V1ApiError).kind, name).toBe('invalid_response')
      expect((err as Error).message, name).toContain('does not support field projection')
    }
  })

  it('catches a projection ignored on a LATER document, not just the first', async () => {
    const fetchImpl = dataFetch({ runs: [projectedRun('run_1'), fullRun('run_2')] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['status', 'startedAt'] })).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })

  it('accepts a correctly projected response', async () => {
    const fetchImpl = dataFetch({ runs: [projectedRun('run_1'), projectedRun('run_2')] })
    const reader = new FlightReader(config, fetchImpl)

    const { runs } = await reader.listRuns({ fields: ['status', 'startedAt'] })
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ id: 'run_1', status: 'failed', startedAt: 1_700_000_000_000 })
  })
})

// ---------------------------------------------------------------------------
// False-positive guards. A check that fires on correct behavior is worse than
// no check at all — each of these is a case with NO evidence of an ignored
// parameter, and each must resolve.
// ---------------------------------------------------------------------------

describe('fields — does not cry wolf', () => {
  it('does NOT throw when a requested field is MISSING — optional fields are routinely absent', async () => {
    // `endedAt` is optional on Run: an in-flight run has none. Asking for it
    // and not getting it is not evidence of anything.
    const fetchImpl = dataFetch({ runs: [{ id: 'run_1', status: 'running' }] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['status', 'endedAt', 'sessionId'] })).resolves.toBeDefined()
  })

  it('does NOT throw on an empty page — zero documents is zero evidence', async () => {
    const fetchImpl = dataFetch({ runs: [] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['status'] })).resolves.toMatchObject({ runs: [] })
  })

  it('does NOT throw when the projection legitimately covers every field', async () => {
    // Asking for everything and getting everything is indistinguishable from
    // an ignored param — and it is also the RIGHT answer, so it must pass.
    const run = fullRun()
    const fetchImpl = dataFetch({ runs: [run] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: Object.keys(run) })).resolves.toMatchObject({ runs: [run] })
  })

  it('does NOT throw when getRun returns no run at all', async () => {
    const fetchImpl = dataFetch({ eventCount: 0, artifactCount: 0 })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRun('run_1', { fields: ['status'] })).resolves.toBeDefined()
  })

  it('does NOT inspect envelope siblings — eventCount/nextCursor are not run fields', async () => {
    const fetchImpl = dataFetch({ run: projectedRun(), eventCount: 7, artifactCount: 2 })
    const reader = new FlightReader(config, fetchImpl)

    const data = await reader.getRun('run_1', { fields: ['status', 'startedAt'] })
    expect(data.eventCount).toBe(7)
    expect(data.artifactCount).toBe(2)
  })

  it('does NOT inspect a list response\'s nextCursor/total', async () => {
    const fetchImpl = dataFetch({ runs: [projectedRun()], nextCursor: 'cur-2', total: 91 })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields: ['status', 'startedAt'] })).resolves.toMatchObject({
      nextCursor: 'cur-2',
      total: 91,
    })
  })
})

// ---------------------------------------------------------------------------
// Composition with the window read
// ---------------------------------------------------------------------------

describe('fields — getRunEventWindow', () => {
  it('always adds sequenceNumber, because the ignored-floor check reads it', async () => {
    const fetchImpl = dataFetch({ events: [{ id: 'e900', type: 'tool.call', sequenceNumber: 900 }] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRunEventWindow('run_1', { fromSequence: 900, fields: ['type'] })

    const params = queryOf(fetchImpl)
    expect(params.get('fields')).toBe('type,sequenceNumber')
    expect(params.get('fromSequence')).toBe('900')
  })

  it('does not duplicate sequenceNumber when the caller already named it', async () => {
    const fetchImpl = dataFetch({ events: [{ id: 'e900', type: 'tool.call', sequenceNumber: 900 }] })
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRunEventWindow('run_1', { fromSequence: 900, fields: ['sequenceNumber', 'type'] })

    expect(queryOf(fetchImpl).get('fields')).toBe('sequenceNumber,type')
  })

  it('still detects an ignored floor while projecting — the floor check stays armed', async () => {
    // Server honored ?fields= but not ?fromSequence=: head of the log, projected.
    const fetchImpl = dataFetch({ events: [projectedEvent(1), projectedEvent(2)] })
    const reader = new FlightReader(config, fetchImpl)

    const err = await reader
      .getRunEventWindow('run_1', { fromSequence: 5000, fields: ['type'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(V1ApiError)
    expect((err as Error).message).toContain('does not support windowed reads')
  })

  it('detects an ignored projection while honoring the floor', async () => {
    const fetchImpl = dataFetch({ events: [fullEvent(5000)] })
    const reader = new FlightReader(config, fetchImpl)

    const err = await reader
      .getRunEventWindow('run_1', { fromSequence: 5000, fields: ['type'] })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(V1ApiError)
    expect((err as Error).message).toContain('does not support field projection')
  })

  it('returns a projected window when both parameters are honored', async () => {
    const fetchImpl = dataFetch({ events: [projectedEvent(5000), projectedEvent(5001)] })
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 5000, fields: ['type'] })
    expect(result.fromSequence).toBe(5000)
    expect(result.events).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Caller-bug arguments are rejected before any request goes out
// ---------------------------------------------------------------------------

describe('fields — argument validation', () => {
  it.each([
    ['listRuns', (r: FlightReader) => r.listRuns({ fields: [] })],
    ['getRun', (r: FlightReader) => r.getRun('run_1', { fields: [] })],
    ['getRunEvents', (r: FlightReader) => r.getRunEvents('run_1', { fields: [] })],
    ['getRunEventWindow', (r: FlightReader) => r.getRunEventWindow('run_1', { fields: [] })],
    ['getFailurePatterns', (r: FlightReader) => r.getFailurePatterns({ fields: [] })],
  ])('rejects an empty fields list on %s without calling fetch', async (_name, call) => {
    // Empty is ambiguous — "everything" or "nothing"? Neither is guessed at.
    const fetchImpl = dataFetch({ runs: [], events: [], patterns: [] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(call(reader)).rejects.toThrow(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // REJECT, NEVER REPAIR. The route rejects each of these too
  // (apps/web/app/api/v1/_lib/fieldsParam.ts); quietly trimming, dropping or
  // deduping would accept a field list the caller's code built wrong and hide
  // the bug behind a plausible-looking response.
  it.each([
    ['a blank entry', ['status', '  ']],
    ['an empty entry', ['status', '']],
    ['a whitespace-padded entry', [' status ']],
    ['an entry containing a comma', ['status,startedAt']],
    ['a duplicated entry', ['status', 'startedAt', 'status']],
  ])('rejects %s without calling fetch', async (_name, fields) => {
    const fetchImpl = dataFetch({ runs: [] })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.listRuns({ fields })).rejects.toThrow(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// An unknown field is the SERVER's 400, mapped to the bad-request kind
// ---------------------------------------------------------------------------

describe('fields — unknown field is answered by the server', () => {
  it('maps 400 INVALID_ARGUMENT to invalid_response with the status and code intact', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () =>
      jsonResponse(400, {
        apiVersion: 'v1',
        error: { code: 'INVALID_ARGUMENT', message: "Unknown field 'stauts' in fields" },
      }),
    )
    const reader = new FlightReader(config, fetchImpl)

    const err = await reader.listRuns({ fields: ['stauts'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(V1ApiError)
    expect((err as V1ApiError).kind).toBe('invalid_response')
    expect((err as V1ApiError).status).toBe(400)
    expect((err as V1ApiError).code).toBe('INVALID_ARGUMENT')
    // The server's own message reaches the caller — it names the bad field.
    expect((err as Error).message).toContain('stauts')
  })

  it('still maps auth/not-found/network the same way on a projected read', async () => {
    const notFound: V1FetchLike = vi.fn(async () =>
      jsonResponse(404, { apiVersion: 'v1', error: { code: 'NOT_FOUND', message: 'Run not found' } }),
    )
    await expect(
      new FlightReader(config, notFound).getRun('nope', { fields: ['status'] }),
    ).rejects.toMatchObject({ kind: 'not_found' })

    const forbidden: V1FetchLike = vi.fn(async () =>
      jsonResponse(403, { apiVersion: 'v1', error: { code: 'FORBIDDEN', message: 'missing scope' } }),
    )
    await expect(
      new FlightReader(config, forbidden).listRuns({ fields: ['status'] }),
    ).rejects.toMatchObject({ kind: 'auth' })

    const boom: V1FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      new FlightReader(config, boom).listRuns({ fields: ['status'] }),
    ).rejects.toMatchObject({ kind: 'network' })
  })
})
