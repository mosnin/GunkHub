/**
 * ARGS-SEAM REGRESSION TEST — services/failurePatterns.ts's `resolvePattern`
 * and `getPatternResolutionEvidence` forwarders (Team C, ADR-006 cycle 2).
 *
 * Written in the style of, and for the same reason as,
 * api_v1_failure_patterns_params.test.ts: the args these services build cross
 * a hand-maintained `makeFunctionReference` string ref
 * (apps/web/src/lib/convexFunctions.ts). There is NO structural type checked
 * against the real Convex handler's `args` shape, so an object spread that
 * silently omits a declared field is NOT a type error. That seam has now
 * produced FOUR runtime-shape bugs in this project, the most recent of which
 * shipped silently for weeks.
 *
 * Cycle 2 widened `failure_patterns:resolvePattern` with a FOURTH FLAT
 * OPTIONAL ARG, `versionId` — exactly the kind of addition that gets dropped
 * in a forwarding spread and fails silently (the route would 200, the
 * operator's "fixed in version X" claim would vanish, and `resolvedInVersionId`
 * would simply never be written). So this test is table-driven over
 * `keyof ValidatedResolveFields`: a field added to that interface but missing
 * from the forwarding spread fails HERE, loudly, instead of in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(() => ({ userId: 'user_1', orgId: 'clerk_org_1' })),
}))

const queryMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => null as unknown)
const mutationMock = vi.fn(
  async (_ref: unknown, _args: Record<string, unknown>) =>
    ({ _id: 'fp_1', orgId: 'org_1', fingerprintHash: 'abcd1234' }) as unknown
)

vi.mock('@/lib/convexServer', () => ({
  getAuthedClient: vi.fn(async () => ({ query: queryMock, mutation: mutationMock })),
  resolveConvexOrgId: vi.fn(async () => 'convex_org_1'),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    failure_patterns: {
      resolvePattern: 'failure_patterns:resolvePattern',
      getPatternResolutionEvidence: 'failure_patterns:getPatternResolutionEvidence',
    },
  },
}))

import type { ValidatedResolveFields } from '@/lib/services/resolutionFieldValidation'

import {
  getPatternResolutionEvidence,
  resolvePattern,
} from '@/lib/services/failurePatterns'

beforeEach(() => {
  queryMock.mockClear()
  mutationMock.mockClear()
})

/**
 * Every field `ValidatedResolveFields` declares, with a representative value.
 * `note`/`ref` shipped in cycle 1; `versionId` is the cycle-2 addition this
 * test exists to pin down.
 */
const RESOLVE_FIELD_TABLE: { name: keyof ValidatedResolveFields; value: unknown }[] = [
  { name: 'note', value: 'Fixed the retry backoff' },
  { name: 'ref', value: 'https://github.com/example/repo/pull/42' },
  { name: 'versionId', value: 'agentversion_abc123' },
]

describe('resolvePattern — every declared field reaches the Convex mutation call', () => {
  it.each(RESOLVE_FIELD_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const fields = { [name]: value } as ValidatedResolveFields
    await resolvePattern('abcd1234', fields)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards orgId + fingerprintHash plus every field at once, with none dropped', async () => {
    const fields: ValidatedResolveFields = {
      note: 'Fixed the retry backoff',
      ref: 'PR-42',
      versionId: 'agentversion_abc123',
    }
    await resolvePattern('abcd1234', fields)

    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({
      orgId: 'convex_org_1',
      fingerprintHash: 'abcd1234',
      note: 'Fixed the retry backoff',
      ref: 'PR-42',
      versionId: 'agentversion_abc123',
    })
  })

  /**
   * `versionId` is a FLAT fourth arg, NOT nested under an options object.
   * Pinned explicitly because nesting it would still typecheck, still return
   * 200, and still silently never write `resolvedInVersionId`.
   */
  it('sends versionId as a flat top-level arg, never nested', async () => {
    await resolvePattern('abcd1234', { versionId: 'agentversion_abc123' })
    const [, args] = mutationMock.mock.calls[0]!
    expect(args['versionId']).toBe('agentversion_abc123')
    expect(args['options']).toBeUndefined()
    expect(args['fields']).toBeUndefined()
  })

  it('omits absent fields entirely (never a stray `undefined` key)', async () => {
    await resolvePattern('abcd1234', {})
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ orgId: 'convex_org_1', fingerprintHash: 'abcd1234' })
    // An explicit-undefined key is NOT the same as an absent one over the
    // wire — Convex validators reject `undefined` for an optional id arg.
    expect(Object.keys(args)).not.toContain('versionId')
    expect(Object.keys(args)).not.toContain('note')
    expect(Object.keys(args)).not.toContain('ref')
  })
})

describe('getPatternResolutionEvidence — args reaching the Convex query', () => {
  it('forwards exactly orgId + fingerprintHash', async () => {
    await getPatternResolutionEvidence('abcd1234')

    expect(queryMock).toHaveBeenCalledTimes(1)
    const [, args] = queryMock.mock.calls[0]!
    expect(args).toEqual({ orgId: 'convex_org_1', fingerprintHash: 'abcd1234' })
  })

  it("uses the caller's own resolved orgId, never a client-supplied one", async () => {
    await getPatternResolutionEvidence('abcd1234')
    const [, args] = queryMock.mock.calls[0]!
    // The org is resolved server-side from the Clerk session; a fingerprint
    // from another org can therefore only ever come back as null -> 404.
    expect(args['orgId']).toBe('convex_org_1')
  })

  it('is bound to a QUERY, not a mutation (it only reads)', async () => {
    await getPatternResolutionEvidence('abcd1234')
    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(mutationMock).not.toHaveBeenCalled()
  })
})
