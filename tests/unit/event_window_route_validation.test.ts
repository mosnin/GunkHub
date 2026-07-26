/**
 * `fromSequence` query-param validation for
 * GET /api/v1/runs/[runId]/events (apps/web/app/api/v1/runs/[runId]/events/route.ts).
 *
 * The route is imported for real (via the `@app` alias) with its three
 * infrastructure dependencies stubbed — `withApiHandler` to a pass-through,
 * `hashApiKey`, and the service forwarder — so what is under test is exactly
 * the parsing/validation the route itself performs, not a copy of it
 * reimplemented in the test.
 *
 * The rule being pinned: a malformed floor is REJECTED with the route's
 * existing 400/INVALID_ARGUMENT idiom, never coerced. Coercion is the
 * dangerous failure mode here — `Number('abc')` is NaN (which would page from
 * the head of the log), `Number('3.7')` floors to a different window, and
 * `-1`/`0` are below the first legal sequence number (Event Log Rule 4:
 * sequence numbers start at 1). Each of those returns a WRONG window that
 * looks exactly like a correct one to the caller.
 *
 * A floor past the end of the run is deliberately NOT in the reject list: it
 * is a legitimate request that yields an empty page.
 */
import { GET } from '@app/api/v1/runs/[runId]/events/route'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` so the mock function exists before the (hoisted) `vi.mock`
// factories below reference it, which in turn lets every import stay at the
// top of the file where import/order wants them.
const { apiGetRunEventsMock } = vi.hoisted(() => ({
  apiGetRunEventsMock: vi.fn(
    async (_hash: string, _params: Record<string, unknown>) => ({ events: [], nextCursor: undefined }),
  ),
}))

vi.mock('@/lib/services/api_v1', () => ({
  apiGetRunEvents: (hash: string, params: Record<string, unknown>) => apiGetRunEventsMock(hash, params),
}))

vi.mock('@/lib/convexServer', () => ({
  hashApiKey: (key: string) => `hashed:${key}`,
}))

// Pass-through: withApiHandler's rate limiting / logging / request-id
// plumbing is covered elsewhere; here it would only obscure the handler.
vi.mock('@/lib/apiHandler', () => ({
  withApiHandler: (
    _name: string,
    handler: (req: unknown, ctx: unknown, extra: unknown) => Promise<Response>,
  ) => handler,
  mapAfrErrorResponse: () => null,
}))

const REQUEST_ID = 'req-window-1'

function call(query: string) {
  const req = {
    headers: { get: (h: string) => (h === 'x-api-key' ? 'afr_test_key' : null) },
    nextUrl: { searchParams: new URLSearchParams(query) },
  }
  // The handler's real signature after the withApiHandler pass-through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET as any)(req, { requestId: REQUEST_ID }, { params: { runId: 'run_1' } }) as Promise<Response>
}

beforeEach(() => {
  apiGetRunEventsMock.mockClear()
})

describe('GET /api/v1/runs/[runId]/events — fromSequence validation', () => {
  const REJECTED = [
    ['not a number', 'fromSequence=abc'],
    ['NaN literal', 'fromSequence=NaN'],
    ['empty value', 'fromSequence='],
    ['zero (sequence numbers start at 1)', 'fromSequence=0'],
    ['negative', 'fromSequence=-1'],
    ['negative zero', 'fromSequence=-0'],
    ['non-integer', 'fromSequence=3.7'],
    ['integer-valued float', 'fromSequence=3.0'],
    ['leading whitespace', 'fromSequence=%205'],
    ['exponent notation', 'fromSequence=1e3'],
    ['hex notation', 'fromSequence=0x10'],
    ['explicit plus sign', 'fromSequence=%2B5'],
    ['Infinity', 'fromSequence=Infinity'],
    ['beyond safe-integer range', 'fromSequence=9007199254740993'],
  ] as const

  it.each(REJECTED)('rejects %s with 400 INVALID_ARGUMENT and never calls Convex', async (_label, query) => {
    const res = await call(query)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string }; requestId: string }
    expect(body.error.code).toBe('INVALID_ARGUMENT')
    expect(body.requestId).toBe(REQUEST_ID)
    // The whole point of rejecting rather than coercing: no window is fetched.
    expect(apiGetRunEventsMock).not.toHaveBeenCalled()
  })

  const ACCEPTED: [string, string, number][] = [
    ['the first legal sequence number', 'fromSequence=1', 1],
    ['a deep sequence number', 'fromSequence=5000', 5000],
    ['a value past the end of the run (empty page, not an error)', 'fromSequence=999999999', 999999999],
    ['zero-padded digits', 'fromSequence=007', 7],
  ]

  it.each(ACCEPTED)('accepts %s and forwards it verbatim', async (_label, query, expected) => {
    const res = await call(query)
    expect(res.status).toBe(200)
    expect(apiGetRunEventsMock).toHaveBeenCalledTimes(1)
    const [hash, params] = apiGetRunEventsMock.mock.calls[0]!
    expect(hash).toBe('hashed:afr_test_key')
    expect(params.fromSequence).toBe(expected)
    expect(params.runId).toBe('run_1')
  })

  it('omits fromSequence entirely when the query param is absent', async () => {
    const res = await call('limit=10')
    expect(res.status).toBe(200)
    const [, params] = apiGetRunEventsMock.mock.calls[0]!
    expect('fromSequence' in params).toBe(false)
    expect(params.limit).toBe(10)
  })

  it('composes with limit and cursor', async () => {
    await call('fromSequence=42&limit=5&cursor=c_abc')
    const [, params] = apiGetRunEventsMock.mock.calls[0]!
    expect(params).toEqual({ runId: 'run_1', limit: 5, cursor: 'c_abc', fromSequence: 42 })
  })

  it('rejects a bad fromSequence even when the other params are valid', async () => {
    const res = await call('fromSequence=-3&limit=5&cursor=c_abc')
    expect(res.status).toBe(400)
    expect(apiGetRunEventsMock).not.toHaveBeenCalled()
  })
})
