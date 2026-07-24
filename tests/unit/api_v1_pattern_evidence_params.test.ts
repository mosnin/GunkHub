/**
 * Sibling of api_v1_failure_patterns_params.test.ts, for the SECOND v1
 * failure-pattern forwarder: `apiGetFailurePatternEvidence`
 * (apps/web/src/lib/services/api_v1.ts) -> convex/read_api.ts's
 * `apiGetFailurePatternEvidence` mutation.
 *
 * Same rationale, same failure mode: the args cross a hand-maintained
 * `makeFunctionReference` string ref (apps/web/src/lib/convexFunctions.ts), so
 * there is NO structural type checked against the real Convex handler's
 * `args` shape. A param declared on the params interface but omitted from the
 * forwarding spread is not a type error — it silently reaches Convex as
 * `undefined` and the filter/lookup quietly does nothing. That exact bug
 * shipped for weeks on the list forwarder before it was caught.
 *
 * This forwarder starts with a single param (`fingerprintHash`), which is
 * precisely when the guard is cheapest to install: the table is driven by
 * `keyof ApiV1GetFailurePatternEvidenceParams`, so the FIRST param added
 * later (an `at`/`asOf` for point-in-time evidence, an `includeTransitions`
 * toggle) fails here loudly instead of shipping silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/convexServer', () => ({
  getPublicClient: vi.fn(() => ({})),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

// Explicit arg signature (rather than a zero-arg `vi.fn`) so
// `mutationMock.mock.calls[0]` types as the real 2-tuple this test
// destructures instead of an empty tuple.
const mutationMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => ({
  pattern: {},
  resolution: null,
  exposure: null,
  transitions: [],
  confidence: null,
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    read_api: {
      apiGetFailurePatternEvidence: 'read_api:apiGetFailurePatternEvidence',
    },
  },
}))

import { getPublicClient } from '@/lib/convexServer'
import { apiGetFailurePatternEvidence, type ApiV1GetFailurePatternEvidenceParams } from '@/lib/services/api_v1'

beforeEach(() => {
  mutationMock.mockClear()
  vi.mocked(getPublicClient).mockReturnValue({
    mutation: mutationMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

/** Every param the interface declares, with a representative value to assert on. */
const PARAM_TABLE: { name: keyof ApiV1GetFailurePatternEvidenceParams; value: unknown }[] = [
  { name: 'fingerprintHash', value: 'abc123def456' },
]

describe('apiGetFailurePatternEvidence — every declared param reaches the Convex mutation call', () => {
  it.each(PARAM_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const params = { [name]: value } as unknown as ApiV1GetFailurePatternEvidenceParams
    await apiGetFailurePatternEvidence('hashed_key', params)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards apiKeyHash plus every param at once, with none dropped', async () => {
    const params: ApiV1GetFailurePatternEvidenceParams = { fingerprintHash: 'abc123def456' }
    await apiGetFailurePatternEvidence('hashed_key', params)

    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key', fingerprintHash: 'abc123def456' })
  })

  /**
   * The table above must cover the interface exhaustively — otherwise a param
   * could be added to the interface AND to the forwarder while this file's
   * table silently lagged, which would defeat the point. There is no runtime
   * `keyof`, so this is asserted structurally: every key of a fully-populated
   * value of the interface must appear in the table.
   */
  it('covers every key the params interface declares', () => {
    const fullyPopulated: Required<ApiV1GetFailurePatternEvidenceParams> = {
      fingerprintHash: 'abc123def456',
    }
    expect(Object.keys(fullyPopulated).sort()).toEqual(PARAM_TABLE.map((p) => String(p.name)).sort())
  })
})
