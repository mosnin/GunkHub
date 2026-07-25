/**
 * Tests for `FlightReader.getRunEventWindow` (packages/sdk/src/reader.ts) —
 * the bounded, sequence-addressed event read added in SDK 0.14.0, plus the
 * `status` discriminant now carried on the explanation read.
 *
 * The point of the window read is that an agent must NEVER be forced to pull
 * a whole run to inspect a hundred events of it. Two properties therefore
 * carry the whole feature, and both are pinned here:
 *
 *   1. It issues exactly ONE request, with a server-side sequence floor. It
 *      never fetches the log and slices client-side.
 *   2. If the server IGNORES the floor (older deployment — an unknown query
 *      param is silently dropped and the first page comes back), it fails
 *      loudly instead of presenting the head of the log as the window.
 *
 * Every test uses a mocked fetch — no real HTTP, no live backend.
 */
import { DEFAULT_EVENT_WINDOW_SIZE, FlightReader, V1ApiError } from '@agent-flight-recorder/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { Event } from '@agent-flight-recorder/contracts'
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

/** Events numbered `from`..`from + count - 1`, matching the contiguous-sequence invariant. */
function makeEvents(from: number, count: number): Event[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${from + i}`,
    runId: 'run_1',
    orgId: 'org_1',
    type: 'tool.call',
    sequenceNumber: from + i,
    timestamp: 1_700_000_000_000 + from + i,
    payload: { type: 'tool.call', name: 'search', input: {}, call_id: `call_${from + i}` },
  }))
}

function windowFetch(events: Event[], nextCursor?: string): V1FetchLike {
  return vi.fn(async () =>
    jsonResponse(200, { apiVersion: 'v1', data: { events, ...(nextCursor !== undefined && { nextCursor }) } }),
  )
}

/** The query string of the single call the reader made. */
function queryOf(fetchImpl: V1FetchLike): URLSearchParams {
  const mock = fetchImpl as unknown as { mock: { calls: [string][] } }
  expect(mock.mock.calls).toHaveLength(1)
  return new URL(mock.mock.calls[0]![0]).searchParams
}

// ---------------------------------------------------------------------------
// The request it makes
// ---------------------------------------------------------------------------

describe('getRunEventWindow — request shape', () => {
  it('sends fromSequence + limit to the events endpoint in ONE request', async () => {
    const fetchImpl = windowFetch(makeEvents(5000, 3))
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 5000, limit: 3 })

    const params = queryOf(fetchImpl)
    expect(params.get('fromSequence')).toBe('5000')
    expect(params.get('limit')).toBe('3')
    expect(result.events).toHaveLength(3)
    expect(result.fromSequence).toBe(5000)
  })

  it('hits the same /events path as getRunEvents, with the api key header', async () => {
    const fetchImpl = windowFetch(makeEvents(10, 1))
    const reader = new FlightReader(config, fetchImpl)
    await reader.getRunEventWindow('run_1', { fromSequence: 10 })

    const mock = fetchImpl as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }
    expect(mock.mock.calls[0]![0]).toContain('/api/v1/runs/run_1/events')
    expect(mock.mock.calls[0]![1].headers).toEqual({ 'x-api-key': 'k' })
  })

  it('omits limit when the caller did not choose one (server page default applies)', async () => {
    const fetchImpl = windowFetch(makeEvents(7, 2))
    const reader = new FlightReader(config, fetchImpl)
    await reader.getRunEventWindow('run_1', { fromSequence: 7 })

    expect(queryOf(fetchImpl).get('limit')).toBeNull()
  })

  it('defaults to fromSequence=1 when neither bound is given', async () => {
    const fetchImpl = windowFetch(makeEvents(1, 2))
    const reader = new FlightReader(config, fetchImpl)
    const result = await reader.getRunEventWindow('run_1')

    expect(queryOf(fetchImpl).get('fromSequence')).toBe('1')
    expect(result.fromSequence).toBe(1)
  })

  it('never sends a cursor — the window is addressed by sequence, not by paging state', async () => {
    const fetchImpl = windowFetch(makeEvents(900, 1))
    const reader = new FlightReader(config, fetchImpl)
    await reader.getRunEventWindow('run_1', { fromSequence: 900 })

    expect(queryOf(fetchImpl).get('cursor')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// aroundSequence centering — resolved client-side into ONE server primitive
// ---------------------------------------------------------------------------

describe('getRunEventWindow — aroundSequence centering', () => {
  it('centers the window: fromSequence = around - floor(limit / 2)', async () => {
    const fetchImpl = windowFetch(makeEvents(4980, 40))
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { aroundSequence: 5000, limit: 40 })

    expect(queryOf(fetchImpl).get('fromSequence')).toBe('4980')
    expect(result.fromSequence).toBe(4980)
  })

  it('uses DEFAULT_EVENT_WINDOW_SIZE as the width when no limit is given', async () => {
    const fetchImpl = windowFetch(makeEvents(950, DEFAULT_EVENT_WINDOW_SIZE))
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRunEventWindow('run_1', { aroundSequence: 1000 })

    const params = queryOf(fetchImpl)
    expect(DEFAULT_EVENT_WINDOW_SIZE).toBe(100)
    expect(params.get('limit')).toBe(String(DEFAULT_EVENT_WINDOW_SIZE))
    expect(params.get('fromSequence')).toBe('950')
  })

  it('clamps the floor at 1 near the head of the log — never asks for sequence 0 or negative', async () => {
    const fetchImpl = windowFetch(makeEvents(1, 10))
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { aroundSequence: 3, limit: 40 })

    expect(queryOf(fetchImpl).get('fromSequence')).toBe('1')
    expect(result.fromSequence).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The capability check — the reason this method can be trusted
// ---------------------------------------------------------------------------

describe('getRunEventWindow — refuses a silently ignored floor', () => {
  it('throws invalid_response when the server returns the head of the log instead of the window', async () => {
    // Exactly what a deployment that predates windowed reads does: unknown
    // query param dropped, first page returned.
    const fetchImpl = windowFetch(makeEvents(1, 100))
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', { fromSequence: 5000, limit: 100 })).rejects.toThrow(V1ApiError)
    await expect(reader.getRunEventWindow('run_1', { fromSequence: 5000, limit: 100 })).rejects.toMatchObject({
      kind: 'invalid_response',
    })
  })

  it("the thrown message names the missing server support, not a generic parse error", async () => {
    const fetchImpl = windowFetch(makeEvents(1, 100))
    const reader = new FlightReader(config, fetchImpl)

    const err = await reader.getRunEventWindow('run_1', { fromSequence: 5000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(V1ApiError)
    expect((err as Error).message).toContain('does not support windowed reads')
    expect((err as Error).message).toContain('fromSequence=5000')
  })

  it('does NOT throw when the floor is 1 — honoring and ignoring it are the same answer', async () => {
    const fetchImpl = windowFetch(makeEvents(1, 10))
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', { fromSequence: 1 })).resolves.toMatchObject({ fromSequence: 1 })
  })

  it('does NOT throw on an empty page — past the end of the log is a valid, honest answer', async () => {
    const fetchImpl = windowFetch([])
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 9999 })
    expect(result.events).toEqual([])
    expect(result.fromSequence).toBe(9999)
  })

  it('accepts a page that starts ABOVE the floor — a sparse/advanced start is honored, not ignored', async () => {
    const fetchImpl = windowFetch(makeEvents(5010, 5))
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 5000 })
    expect(result.events[0]!.sequenceNumber).toBe(5010)
  })
})

// ---------------------------------------------------------------------------
// It must never pull the whole run
// ---------------------------------------------------------------------------

describe('getRunEventWindow — never slices client-side', () => {
  it('makes exactly one request regardless of how deep the window sits', async () => {
    const fetchImpl = windowFetch(makeEvents(19_900, 100))
    const reader = new FlightReader(config, fetchImpl)

    await reader.getRunEventWindow('run_1', { aroundSequence: 19_950, limit: 100 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not follow nextCursor — it returns the one window and stops', async () => {
    const fetchImpl = windowFetch(makeEvents(200, 50), 'cur-next')
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 200, limit: 50 })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.nextCursor).toBe('cur-next')
    expect(result.events).toHaveLength(50)
  })

  it('sequence-based continuation reaches the next window with no cursor', async () => {
    const first = windowFetch(makeEvents(1, 50))
    const reader = new FlightReader(config, first)
    const page = await reader.getRunEventWindow('run_1', { fromSequence: 1, limit: 50 })

    const nextFrom = page.events[page.events.length - 1]!.sequenceNumber + 1
    expect(nextFrom).toBe(51)

    const second = windowFetch(makeEvents(51, 50))
    const reader2 = new FlightReader(config, second)
    await reader2.getRunEventWindow('run_1', { fromSequence: nextFrom, limit: 50 })
    expect(queryOf(second).get('fromSequence')).toBe('51')
  })
})

// ---------------------------------------------------------------------------
// Caller-bug arguments are rejected before any request goes out
// ---------------------------------------------------------------------------

describe('getRunEventWindow — argument validation', () => {
  it('rejects fromSequence AND aroundSequence together, without calling fetch', async () => {
    const fetchImpl = windowFetch(makeEvents(1, 1))
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', { fromSequence: 10, aroundSequence: 20 })).rejects.toThrow(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['fromSequence', { fromSequence: 0 }],
    ['fromSequence', { fromSequence: -5 }],
    ['fromSequence', { fromSequence: 2.5 }],
    ['aroundSequence', { aroundSequence: 0 }],
    ['limit', { fromSequence: 1, limit: 0 }],
    ['limit', { fromSequence: 1, limit: 1.5 }],
  ])('rejects a non-positive-integer %s without calling fetch', async (_name, options) => {
    const fetchImpl = windowFetch(makeEvents(1, 1))
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', options)).rejects.toThrow(RangeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tenancy + error mapping: unchanged from every other reader method
// ---------------------------------------------------------------------------

describe('getRunEventWindow — tenancy and error mapping', () => {
  it('maps 404 to not_found — an unknown run and another org\'s run are indistinguishable', async () => {
    const body = { apiVersion: 'v1', error: { code: 'NOT_FOUND', message: 'Run not found in this organization' } }
    const fetchImpl: V1FetchLike = vi.fn(async () => jsonResponse(404, body))
    const reader = new FlightReader(config, fetchImpl)

    const unknown = await reader.getRunEventWindow('run_does_not_exist', { fromSequence: 5 }).catch((e: unknown) => e)
    const crossOrg = await reader.getRunEventWindow('run_other_org', { fromSequence: 5 }).catch((e: unknown) => e)

    for (const err of [unknown, crossOrg]) {
      expect(err).toBeInstanceOf(V1ApiError)
      expect((err as V1ApiError).kind).toBe('not_found')
      expect((err as V1ApiError).status).toBe(404)
    }
    // Same kind, same status, same message: nothing here is an existence oracle.
    expect((unknown as Error).message).toBe((crossOrg as Error).message)
  })

  it('maps 403 (key without the read scope) to auth', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () =>
      jsonResponse(403, { apiVersion: 'v1', error: { code: 'FORBIDDEN', message: 'missing scope' } }),
    )
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', { fromSequence: 2 })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('maps a network failure to network, never leaking a raw fetch error', async () => {
    const fetchImpl: V1FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const reader = new FlightReader(config, fetchImpl)

    await expect(reader.getRunEventWindow('run_1', { fromSequence: 2 })).rejects.toMatchObject({ kind: 'network' })
  })
})

// ---------------------------------------------------------------------------
// Artifact payloads are pointers, never inlined bytes
// ---------------------------------------------------------------------------

describe('getRunEventWindow — externalized payloads stay pointers', () => {
  it('passes an externalized payload through as pointer + checksum, fetching no blob', async () => {
    const externalized = {
      id: 'e42',
      runId: 'run_1',
      orgId: 'org_1',
      type: 'llm.response',
      sequenceNumber: 42,
      timestamp: 1_700_000_000_042,
      payload: {
        type: 'llm.response',
        _externalized: {
          artifactId: 'art_1',
          checksum: 'a'.repeat(64),
          size: 2_500_000,
        },
      },
    } as unknown as Event
    const fetchImpl = windowFetch([externalized])
    const reader = new FlightReader(config, fetchImpl)

    const result = await reader.getRunEventWindow('run_1', { fromSequence: 42 })

    // One request only: the reader never dereferences the pointer for you.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const payload = result.events[0]!.payload as unknown as { _externalized: { checksum: string } }
    expect(payload._externalized.checksum).toHaveLength(64)
  })
})
