/**
 * blast_radius_v1_projection_route.test.ts — the three ADR-008 v1 routes driven
 * FOR REAL, to prove the completeness caveats survive `?fields=`.
 *
 * ===========================================================================
 * WHAT THIS LAYER OWNS, AND WHAT IT DOES NOT
 * ===========================================================================
 *
 * The "a projection that names a conclusion also gets its caveats" rule lives
 * in `convex/read_api.ts` (`validateDivergenceFieldSelection`), which
 * force-includes `coverage`/`nextEventCursor` (run), `window`/`nextCursor`
 * (fleet) and the config tier's provability fields. That is the DURABLE half of
 * the fix and it is tested at that layer.
 *
 * THIS FILE DOES NOT RE-TEST IT, AND CANNOT. Every test here mocks the service
 * forwarder, so the Convex handler never executes and the augmentation happens
 * below the mock. An assertion here that `coverage` came back would be checking
 * a fixture this file wrote — vacuous by construction. A route-level test that
 * *appeared* to verify the upstream rule would be worse than no test: it would
 * report green whatever upstream did.
 *
 * What the route layer genuinely owns is narrower and still worth pinning: the
 * upstream rule only protects a request that REACHES it intact, and a response
 * that is returned intact. So:
 *
 *   1. the caller's `?fields=` is forwarded VERBATIM — not reordered, not
 *      filtered, not augmented, not silently widened;
 *   2. an omitted `?fields=` stays omitted, so the full report is returned;
 *   3. the response body is passed through without post-filtering, so a route
 *      cannot re-open the hole by stripping caveats on the way out;
 *   4. malformed parameters are rejected BEFORE the key is resolved, so a bad
 *      request is never an existence oracle.
 *
 * A previous revision of this file asserted the route itself augmented the
 * projection, because the route carried a mirror of the upstream rule. That
 * mirror has been deleted — two layers each assuming the other handles it is
 * how the guarantee rots — and those assertions went with it.
 */

import { GET as GET_RUN_DIVERGENCE } from '@app/api/v1/runs/[runId]/divergence/route'
import { GET as GET_BLAST_RADIUS } from '@app/api/v1/versions/[baselineVersionId]/blast-radius/[targetVersionId]/route'
import { GET as GET_COMPARE } from '@app/api/v1/versions/[baselineVersionId]/compare/[targetVersionId]/route'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runMock, fleetMock, configMock } = vi.hoisted(() => ({
  runMock: vi.fn(async (_h: string, _p: Record<string, unknown>) => ({ verdict: 'compatible' })),
  fleetMock: vi.fn(async (_h: string, _p: Record<string, unknown>) => ({ verdict: 'compatible' })),
  configMock: vi.fn(async (_h: string, _p: Record<string, unknown>) => ({ verdict: 'compatible' })),
}))

vi.mock('@/lib/services/api_v1', () => ({
  apiGetRunDivergence: (h: string, p: Record<string, unknown>) => runMock(h, p),
  apiGetFleetDivergence: (h: string, p: Record<string, unknown>) => fleetMock(h, p),
  apiCompareVersionConfigs: (h: string, p: Record<string, unknown>) => configMock(h, p),
}))

vi.mock('@/lib/convexServer', () => ({ hashApiKey: (k: string) => `hashed:${k}` }))

vi.mock('@/lib/apiHandler', () => ({
  withApiHandler: (
    _name: string,
    handler: (req: unknown, ctx: unknown, extra: unknown) => Promise<Response>,
  ) => handler,
  mapAfrErrorResponse: () => null,
}))

const REQUEST_ID = 'req-div-1'

function makeReq(query: string, withKey = true) {
  return {
    headers: { get: (h: string) => (h === 'x-api-key' && withKey ? 'afr_test_key' : null) },
    nextUrl: { searchParams: new URLSearchParams(query) },
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const callRun = (q: string) =>
  (GET_RUN_DIVERGENCE as any)(makeReq(q), { requestId: REQUEST_ID }, {
    params: { runId: 'run_1' },
  }) as Promise<Response>

const callFleet = (q: string) =>
  (GET_BLAST_RADIUS as any)(makeReq(q), { requestId: REQUEST_ID }, {
    params: { baselineVersionId: 'ver_0', targetVersionId: 'ver_1' },
  }) as Promise<Response>

const callCompare = (q: string) =>
  (GET_COMPARE as any)(makeReq(q), { requestId: REQUEST_ID }, {
    params: { baselineVersionId: 'ver_0', targetVersionId: 'ver_1' },
  }) as Promise<Response>
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  runMock.mockClear()
  fleetMock.mockClear()
  configMock.mockClear()
})

// ===========================================================================
// §1. The caller's projection reaches the service VERBATIM
// ===========================================================================
//
// The upstream caveat rule operates on the field list it receives. A route that
// reorders, dedupes, drops or "helpfully" widens that list changes the question
// before upstream ever sees it. Verbatim forwarding is the precondition that
// makes the upstream guarantee meaningful, and it is this layer's job.

describe('§1 the projection is forwarded verbatim', () => {
  it('run route forwards exactly what the caller asked for', async () => {
    await callRun('target=ver_1&fields=verdict')
    // Exact equality, not `arrayContaining`: this pins the ABSENCE of
    // route-level augmentation just as much as the presence of the caller's
    // own fields. `coverage` is added by convex/read_api.ts, below this mock.
    expect(runMock.mock.calls[0]![1].fields).toEqual(['verdict'])
  })

  it('fleet route forwards exactly what the caller asked for', async () => {
    await callFleet('fields=verdict')
    expect(fleetMock.mock.calls[0]![1].fields).toEqual(['verdict'])
  })

  it('compare route forwards exactly what the caller asked for', async () => {
    await callCompare('fields=verdict')
    expect(configMock.mock.calls[0]![1].fields).toEqual(['verdict'])
  })

  it('preserves multi-field order and duplicates-rejection semantics', async () => {
    // `fieldsParam.ts` already rejects duplicates and refuses to trim; the route
    // must not undo either by normalising on the way through.
    await callRun('target=ver_1&fields=verdict,proven,coverage')
    expect(runMock.mock.calls[0]![1].fields).toEqual(['verdict', 'proven', 'coverage'])
  })
})

// ===========================================================================
// §3. The response is not post-filtered on the way out
// ===========================================================================
//
// The other way this layer could re-open the hole: let upstream force-include
// the caveats, then drop them while shaping the response. The routes return the
// service result inside the v1 envelope untouched, and this pins that.

describe('§3 the response body passes through whole', () => {
  it('run route returns every field upstream sent, including the caveats', async () => {
    const upstream = {
      runId: 'run_1',
      targetVersionId: 'ver_1',
      verdict: 'indeterminate',
      // Force-included by convex/read_api.ts even though the caller asked only
      // for `verdict`. If the route filtered the response, these would vanish.
      coverage: { assessed: ['model'], unassessed: [], eventsExamined: 12, eventHistoryComplete: false },
      nextEventCursor: 'more_events',
    }
    runMock.mockResolvedValueOnce(upstream)

    const res = await callRun('target=ver_1&fields=verdict')
    const body = (await res.json()) as { data?: unknown; [k: string]: unknown }
    // The envelope wraps rather than reshapes; find the payload wherever it sits.
    const payload = (body.data ?? body) as Record<string, unknown>

    expect(payload).toMatchObject(upstream)
    expect(payload.nextEventCursor).toBe('more_events')
  })

  it('fleet route returns the window and cursor untouched', async () => {
    const upstream = {
      agentId: 'agent_1',
      targetVersionId: 'ver_1',
      verdict: 'indeterminate',
      window: {
        runsScanned: 25, runsAnalyzed: 25, runsUnassessable: 0,
        runsSkippedForBudget: 0, scanTruncated: false, nextCursor: 'page_2',
      },
      nextCursor: 'page_2',
    }
    fleetMock.mockResolvedValueOnce(upstream)

    const res = await callFleet('fields=verdict')
    const body = (await res.json()) as { data?: unknown; [k: string]: unknown }
    const payload = (body.data ?? body) as Record<string, unknown>

    // The field Team B's exit-11 guarantee rests on, surviving the route.
    expect(payload.nextCursor).toBe('page_2')
    expect(payload.window).toMatchObject(upstream.window)
  })
})

// ===========================================================================
// §4. Backward compatibility and non-widening
// ===========================================================================

describe('§4 the fix does not change requests it has no business changing', () => {
  it('an omitted `fields` is still omitted — full report, byte-identical request', async () => {
    await callRun('target=ver_1')
    expect(runMock.mock.calls[0]![1]).not.toHaveProperty('fields')
  })

  it('a metadata-only projection is forwarded verbatim', async () => {
    // `analyzedAt` asserts nothing. Widening every projection would defeat the
    // token saving `?fields=` exists to provide.
    await callRun('target=ver_1&fields=analyzedAt')
    expect(runMock.mock.calls[0]![1].fields).toEqual(['analyzedAt'])
  })

  it('does not duplicate a caveat the caller already named', async () => {
    await callRun('target=ver_1&fields=verdict,coverage')
    const fields = runMock.mock.calls[0]![1].fields as string[]
    expect(new Set(fields).size).toBe(fields.length)
  })

  it('still rejects a malformed `fields` before augmenting anything', async () => {
    // Shape validation runs first and short-circuits; augmentation must never
    // rescue an invalid request into a valid one.
    const res = await callRun('target=ver_1&fields=')
    expect(res.status).toBe(400)
    expect(runMock).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// §5. Parameter validation precedes key resolution
// ===========================================================================

describe('§5 malformed requests are not existence oracles', () => {
  it('rejects a missing `target` on the run route without calling the service', async () => {
    const res = await callRun('')
    expect(res.status).toBe(400)
    expect(runMock).not.toHaveBeenCalled()

    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_ARGUMENT')
    // The response is identical whether the run exists, does not exist, or
    // belongs to another org — it is produced before any lookup.
    expect(body.error.message).toMatch(/target/)
  })

  it('rejects an empty `cursor` rather than silently restarting the scan', async () => {
    // Coercing `cursor=` to "start from the beginning" would silently re-read
    // page one, and a caller paging a large fleet would never terminate.
    const res = await callFleet('cursor=')
    expect(res.status).toBe(400)
    expect(fleetMock).not.toHaveBeenCalled()
  })

  it('rejects a non-integer `limit` rather than coercing it', async () => {
    const res = await callFleet('limit=abc')
    expect(res.status).toBe(400)
    expect(fleetMock).not.toHaveBeenCalled()
  })

  it('requires an API key before any parameter is even read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (GET_RUN_DIVERGENCE as any)(makeReq('target=ver_1', false), {
      requestId: REQUEST_ID,
    }, { params: { runId: 'run_1' } })) as Response
    expect(res.status).toBe(401)
    expect(runMock).not.toHaveBeenCalled()
  })
})
