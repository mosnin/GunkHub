/**
 * Param-forwarding test for `apiGetRunEvents`
 * (apps/web/src/lib/services/api_v1.ts), added in the SAME commit as the
 * `fromSequence` window param it covers.
 *
 * Same hazard, same convention as tests/unit/api_v1_failure_patterns_params.test.ts:
 * this forwarder's args cross a hand-maintained `makeFunctionReference`
 * string ref (apps/web/src/lib/convexFunctions.ts), so there is NO structural
 * type checked against the real Convex handler's `args` shape. A param
 * declared on `ApiV1ListEventsParams` but omitted from the forwarding spread
 * is not a type error — it is a silent wrong answer in production, and this
 * codebase has already shipped that exact bug more than once
 * (`apiListFailurePatterns` dropping `spiking`/`muted`).
 *
 * `fromSequence` is the worst possible param to drop that way: dropping it
 * returns the HEAD of the event log, which is indistinguishable from a window
 * that legitimately starts at sequence 1. The consumer (the SDK's
 * `getRunEventWindow`, feeding the MCP server's tier-4 tool) treats that
 * ambiguity as a hard error rather than hand back a wrong answer that looks
 * right — so a dropped param surfaces as a loud client-side failure, and this
 * table is what stops it from ever being introduced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/convexServer', () => ({
  getPublicClient: vi.fn(() => ({})),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

// Explicit argument signature (rather than `vi.fn(async () => ...)`) so
// `mutationMock.mock.calls[0]` types as the real 2-tuple this test
// destructures, instead of the empty tuple a zero-arg inference produces.
const mutationMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => ({
  events: [],
  nextCursor: undefined,
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    read_api: {
      apiGetRunEvents: 'read_api:apiGetRunEvents',
    },
  },
}))

import { getPublicClient } from '@/lib/convexServer'
import { apiGetRunEvents, type ApiV1ListEventsParams } from '@/lib/services/api_v1'

beforeEach(() => {
  mutationMock.mockClear()
  vi.mocked(getPublicClient).mockReturnValue({
    mutation: mutationMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

/**
 * Every param `ApiV1ListEventsParams` declares, with a representative
 * non-default value. `runId`/`limit`/`cursor` already worked; `fromSequence`
 * is the window floor added with this test.
 */
const PARAM_TABLE: { name: keyof ApiV1ListEventsParams; value: unknown }[] = [
  { name: 'runId', value: 'run_1' },
  { name: 'limit', value: 25 },
  { name: 'cursor', value: 'cursor_abc' },
  { name: 'fromSequence', value: 5000 },
  // Server-side field projection (`?fields=` on GET /api/v1/runs/[runId]/events).
  // Added to this table in the SAME commit as the param. Dropping it returns
  // the FULL event document — the same silent, plausible-looking wrong answer
  // a dropped `fromSequence` produces, one field-set wide instead of one
  // window wide. Route-level parsing lives in
  // tests/unit/field_projection_route.test.ts.
  { name: 'fields', value: ['sequenceNumber', 'type'] },
]

describe('apiGetRunEvents — every declared param reaches the Convex mutation call', () => {
  it.each(PARAM_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const params = { runId: 'run_1', [name]: value } as ApiV1ListEventsParams
    await apiGetRunEvents('hashed_key', params)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    // `name` widens to `string | number | symbol`; toHaveProperty wants a string.
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards apiKeyHash plus every param at once, with none dropped', async () => {
    const params: ApiV1ListEventsParams = {
      runId: 'run_1',
      limit: 10,
      cursor: 'cursor_xyz',
      fromSequence: 4999,
      fields: ['sequenceNumber', 'type'],
    }
    await apiGetRunEvents('hashed_key', params)

    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({
      apiKeyHash: 'hashed_key',
      runId: 'run_1',
      limit: 10,
      cursor: 'cursor_xyz',
      fromSequence: 4999,
      fields: ['sequenceNumber', 'type'],
    })
  })

  it('omits fromSequence entirely when absent (never a stray `undefined` key)', async () => {
    await apiGetRunEvents('hashed_key', { runId: 'run_1' })
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key', runId: 'run_1' })
    expect('fromSequence' in args).toBe(false)
  })

  /**
   * The floor is forwarded VERBATIM. Rounding, clamping, or defaulting it in
   * the forwarder would produce a window the caller never asked for — and,
   * unlike a dropped param, one the caller cannot detect. Validation belongs
   * at the route (reject) and in Convex (reject), never here (transform).
   */
  it('forwards fromSequence verbatim — no clamping, rounding, or defaulting', async () => {
    await apiGetRunEvents('hashed_key', { runId: 'run_1', fromSequence: 1 })
    expect(mutationMock.mock.calls[0]![1].fromSequence).toBe(1)

    mutationMock.mockClear()
    await apiGetRunEvents('hashed_key', { runId: 'run_1', fromSequence: 987_654 })
    expect(mutationMock.mock.calls[0]![1].fromSequence).toBe(987_654)
  })

  /**
   * Guard against the failure this whole file exists for: if a param is added
   * to `ApiV1ListEventsParams` without being added to PARAM_TABLE above, this
   * fails — so the table cannot silently fall behind the interface. The keys
   * are listed literally because a TypeScript interface has no runtime
   * reflection; `satisfies` ties the literal list back to the type.
   */
  it('PARAM_TABLE covers every field of ApiV1ListEventsParams', () => {
    const ALL_DECLARED_PARAMS = ['runId', 'limit', 'cursor', 'fromSequence', 'fields'] satisfies Array<
      keyof ApiV1ListEventsParams
    >
    // Exhaustiveness in the other direction: this assignment fails to compile
    // if `ApiV1ListEventsParams` grows a field not present in the list above.
    const _exhaustive: Record<keyof ApiV1ListEventsParams, true> = {
      runId: true,
      limit: true,
      cursor: true,
      fromSequence: true,
      fields: true,
    }
    void _exhaustive
    expect(PARAM_TABLE.map((p) => String(p.name)).sort()).toEqual([...ALL_DECLARED_PARAMS].sort())
  })
})
