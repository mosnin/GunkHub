/**
 * Regression test for a real, shipped bug (found by Team D, this cycle):
 * `apiListFailurePatterns` (apps/web/src/lib/services/api_v1.ts) forwards a
 * hand-picked subset of `ApiV1ListFailurePatternsParams` to
 * `convex/read_api.ts`'s `apiListFailurePatterns` mutation via an object
 * spread. `convex/read_api.ts` has accepted `spiking`/`muted` since last
 * cycle, and now also `status`/`regressed` (ADR-006,
 * docs/adr/006-failure-resolution.md) — but this forwarder only ever
 * declared/forwarded `agentId`/`limit`/`cursor`, so `afr patterns --spiking`
 * and `afr patterns --muted` silently returned UNFILTERED results since they
 * shipped: the v1 route parsed the query param correctly, the CLI sent it
 * correctly, the Convex mutation implemented the filter correctly, and this
 * forwarder dropped it on the floor in between.
 *
 * TypeScript did not catch this because the args cross a hand-maintained
 * `makeFunctionReference` string ref (apps/web/src/lib/convexFunctions.ts) —
 * there is no structural type checked against the real Convex handler's
 * `args` shape, so an object spread silently omitting a declared param is
 * not a type error. This is the THIRD bug this project has had from these
 * unchecked string refs (see git history / handoff notes for the other two).
 *
 * This test is table-driven over every declared `ApiV1ListFailurePatternsParams`
 * field so the next filter added to either side of this forwarder fails
 * loudly here — a new field added to the interface but not the forwarding
 * spread (or vice versa) breaks this test, not just silently returns wrong
 * data in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/convexServer', () => ({
  getPublicClient: vi.fn(() => ({})),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

// The argument signature is declared explicitly (rather than `vi.fn(async () =>
// ...)`) so `mutationMock.mock.calls[0]` is typed as the real 2-tuple this test
// destructures, instead of the empty tuple a zero-arg inference would produce.
const mutationMock = vi.fn(
  async (_ref: unknown, _args: Record<string, unknown>) => ({ patterns: [], nextCursor: undefined })
)

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    read_api: {
      apiListFailurePatterns: 'read_api:apiListFailurePatterns',
    },
  },
}))

import { getPublicClient } from '@/lib/convexServer'
import { apiListFailurePatterns, type ApiV1ListFailurePatternsParams } from '@/lib/services/api_v1'

beforeEach(() => {
  mutationMock.mockClear()
  vi.mocked(getPublicClient).mockReturnValue({
    mutation: mutationMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

/**
 * Every param `ApiV1ListFailurePatternsParams` declares, with a representative
 * non-default value to forward and assert on. `agentId`/`limit`/`cursor` are
 * the three that already worked before this fix; `spiking`/`muted`/`status`/
 * `regressed` are the ones the bug silently dropped.
 */
const PARAM_TABLE: { name: keyof ApiV1ListFailurePatternsParams; value: unknown }[] = [
  { name: 'agentId', value: 'agent_1' },
  { name: 'spiking', value: true },
  { name: 'muted', value: true },
  { name: 'status', value: 'resolved' },
  { name: 'regressed', value: true },
  // ADR-006 cycle 2: the fix-confidence state filter (Team B's vocabulary,
  // convex/insights.ts §12). Added to this table in the SAME commit as the
  // param itself — that ordering is the whole point of this file.
  { name: 'state', value: 'regressed' },
  { name: 'limit', value: 25 },
  { name: 'cursor', value: 'cursor_abc' },
  // Server-side field projection (`?fields=` on GET /api/v1/patterns). Added
  // to this table in the SAME commit as the param itself. A dropped `fields`
  // returns the FULL pattern document — a well-formed response the caller
  // cannot distinguish from a projection that happened to include everything.
  // Route-level parsing and its tenancy properties are covered separately in
  // tests/unit/field_projection_route.test.ts.
  { name: 'fields', value: ['fingerprintHash', 'count'] },
]

describe('apiListFailurePatterns — every declared param reaches the Convex mutation call', () => {
  it.each(PARAM_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const params = { [name]: value } as ApiV1ListFailurePatternsParams
    await apiListFailurePatterns('hashed_key', params)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    // `name` is `keyof ApiV1ListFailurePatternsParams`, which widens to
    // `string | number | symbol`; toHaveProperty's path param wants a string.
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards apiKeyHash plus every param at once, with none dropped', async () => {
    const params: ApiV1ListFailurePatternsParams = {
      agentId: 'agent_1',
      spiking: true,
      muted: false,
      status: 'acknowledged',
      regressed: true,
      state: 'regressed',
      limit: 10,
      cursor: 'cursor_xyz',
      fields: ['fingerprintHash', 'count'],
    }
    await apiListFailurePatterns('hashed_key', params)

    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({
      apiKeyHash: 'hashed_key',
      agentId: 'agent_1',
      spiking: true,
      muted: false,
      status: 'acknowledged',
      regressed: true,
      state: 'regressed',
      limit: 10,
      cursor: 'cursor_xyz',
      fields: ['fingerprintHash', 'count'],
    })
  })

  /**
   * `status` (the human lifecycle label) and `state` (the EVIDENCE grade) are
   * different axes that happen to share the word "resolved"/"regressed" in
   * their vocabularies, and they are forwarded as two independent params.
   * Pinned explicitly because collapsing them — or forwarding one under the
   * other's key — would be invisible to TypeScript across the string ref.
   */
  /**
   * The `fixConfidence` envelope (ADR-006 cycle 3) travels on the RESPONSE,
   * not as a param, so the param table above cannot cover it — but it crosses
   * the same untyped seam in the other direction. The forwarder's declared
   * return type (`{ patterns, nextCursor }`) deliberately understates the
   * payload and passes the object through by cast, so the envelope survives at
   * runtime. If that cast were ever "tidied" into a structural pick, the
   * envelope would be silently dropped and the CLI would lose its staleness
   * marker — reverting to printing stale verdicts as current, with nothing in
   * the type system objecting.
   */
  it('passes the fixConfidence response envelope through untouched', async () => {
    const envelope = {
      stalenessBoundMs: 86_400_000,
      entries: [
        {
          fingerprintHash: 'hash_1',
          state: 'confirmed',
          score: 0.82,
          computedAt: 1_700_000_000_000,
          ageMs: 7_200_000,
          stale: true,
          basis: 'snapshot',
        },
      ],
      staleCount: 1,
      unevaluated: ['deadbeef1234'],
    }
    mutationMock.mockResolvedValueOnce({
      patterns: [{ fingerprintHash: 'hash_1' }],
      nextCursor: undefined,
      fixConfidence: envelope,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const result = (await apiListFailurePatterns('hashed_key', {})) as unknown as {
      fixConfidence?: typeof envelope
    }
    expect(result.fixConfidence).toEqual(envelope)
  })

  it('forwards status and state as independent params', async () => {
    await apiListFailurePatterns('hashed_key', { status: 'open', state: 'regressed' })
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key', status: 'open', state: 'regressed' })
  })

  it('omits undeclared/undefined params entirely (never a stray `undefined` key)', async () => {
    await apiListFailurePatterns('hashed_key', {})
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key' })
  })
})
