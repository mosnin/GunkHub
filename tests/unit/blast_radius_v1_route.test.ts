/**
 * blast_radius_v1_route.test.ts — the `/api/v1/**` divergence read surface.
 *
 * ===========================================================================
 * WHY THIS SURFACE EXISTS, AND WHAT BREAKS IF THE FORWARDER IS WRONG
 * ===========================================================================
 *
 * `convex/divergence.ts` resolves the caller's org from a CLERK SESSION, so it
 * can only serve the browser. Everything else our ICP uses holds an API key
 * instead: `afr compat` in CI, and the MCP tools an agent uses to ask whether
 * its own next version is safe to ship. Those reach the engine through
 * `convex/read_api.ts` and these routes, or not at all.
 *
 * Two failure modes, both invisible to TypeScript:
 *
 *  1. A PARAMETER DROPPED BY THE FORWARDER. `convexFunctions.ts` is a
 *     hand-maintained table of string refs with no structural typecheck against
 *     the real handler args, and seven runtime bugs have shipped through it.
 *     The archetype: a filter parsed correctly by the route, sent correctly by
 *     the CLI, implemented correctly in Convex, and dropped silently in
 *     between. Dropping a CURSOR here is worse than a filter — it re-reads page
 *     one forever, so a caller paging a 10,000-run fleet never terminates and
 *     never learns why.
 *
 *  2. A COMPLETENESS FIELD LOST IN THE RESPONSE. `coverage`,
 *     `eventHistoryComplete`, `scanTruncated`, `runsUnassessable`,
 *     `runsSkippedForBudget` and `nextCursor` are what separate an honest
 *     `indeterminate` from a false `compatible`. A route that "tidies" the
 *     response shape and drops one turns a partial scan into a green build in
 *     someone's CI — the worst bug this feature can have, because it is silent
 *     and it is on the happy path.
 *
 * So this file is table-driven over both directions: every declared parameter
 * must reach Convex under its real name, and every completeness field must
 * survive the round trip byte-for-byte.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/convexServer', () => ({
  getPublicClient: vi.fn(() => ({})),
  hashApiKey: vi.fn((k: string) => `hash:${k}`),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

const mutationMock = vi.fn(
  async (_ref: unknown, _args: Record<string, unknown>) => ({}) as unknown,
)

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    read_api: {
      apiCompareVersionConfigs: 'read_api:apiCompareVersionConfigs',
      apiGetRunDivergence: 'read_api:apiGetRunDivergence',
      apiGetFleetDivergence: 'read_api:apiGetFleetDivergence',
    },
  },
}))

import { getPublicClient } from '@/lib/convexServer'
import {
  apiCompareVersionConfigs,
  apiGetFleetDivergence,
  apiGetRunDivergence,
  type ApiV1CompareVersionConfigsParams,
  type ApiV1GetFleetDivergenceParams,
  type ApiV1GetRunDivergenceParams,
} from '@/lib/services/api_v1'

beforeEach(() => {
  mutationMock.mockReset()
  mutationMock.mockResolvedValue({})
  vi.mocked(getPublicClient).mockReturnValue({
    mutation: mutationMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

const argsOf = () => mutationMock.mock.calls[0]![1]
const refOf = () => mutationMock.mock.calls[0]![0]

// ===========================================================================
// §1. Every declared parameter reaches Convex, under its real name
// ===========================================================================
//
// Table-driven over the full parameter set of each service function, so a
// parameter added to either side of a forwarder without the other fails HERE
// rather than silently returning wrong data in production.

describe('§1 apiGetRunDivergence forwards every declared parameter', () => {
  const FULL: Required<ApiV1GetRunDivergenceParams> = {
    runId: 'run_1',
    targetVersionId: 'ver_1',
    eventCursor: 'cursor_abc',
    limit: 250,
    fields: ['proven', 'coverage'],
  }

  it('calls the right ref', async () => {
    await apiGetRunDivergence('hash', FULL)
    expect(refOf()).toBe('read_api:apiGetRunDivergence')
  })

  it.each(Object.keys(FULL) as (keyof ApiV1GetRunDivergenceParams)[])(
    'forwards `%s`',
    async (key) => {
      await apiGetRunDivergence('hash', FULL)
      expect(argsOf()).toHaveProperty(key, FULL[key])
    },
  )

  it('forwards the hashed key, never the raw key', async () => {
    await apiGetRunDivergence('hash', FULL)
    expect(argsOf()).toHaveProperty('apiKeyHash', 'hash')
  })

  it('OMITS optional parameters rather than sending undefined', async () => {
    // Convex validators reject an explicitly-passed `undefined` for an optional
    // arg, so an omitted optional must be absent, not present-and-undefined.
    await apiGetRunDivergence('hash', { runId: 'r', targetVersionId: 'v' })
    expect(Object.keys(argsOf()).sort()).toEqual(['apiKeyHash', 'runId', 'targetVersionId'])
  })
})

describe('§2 apiGetFleetDivergence forwards every declared parameter', () => {
  const FULL: Required<ApiV1GetFleetDivergenceParams> = {
    baselineVersionId: 'ver_0',
    targetVersionId: 'ver_1',
    cursor: 'page_2',
    limit: 50,
    fields: ['provenReasons', 'window'],
  }

  it('calls the right ref', async () => {
    await apiGetFleetDivergence('hash', FULL)
    expect(refOf()).toBe('read_api:apiGetFleetDivergence')
  })

  it.each(Object.keys(FULL) as (keyof ApiV1GetFleetDivergenceParams)[])(
    'forwards `%s`',
    async (key) => {
      await apiGetFleetDivergence('hash', FULL)
      expect(argsOf()).toHaveProperty(key, FULL[key])
    },
  )

  it('uses `baselineVersionId`, NOT `sourceVersionId`', async () => {
    // Renamed mid-cycle by the engine. A forwarder still sending the old name
    // typechecks and fails at runtime with ArgumentValidationError.
    await apiGetFleetDivergence('hash', FULL)
    expect(argsOf()).not.toHaveProperty('sourceVersionId')
  })

  it('OMITS optional parameters rather than sending undefined', async () => {
    await apiGetFleetDivergence('hash', { baselineVersionId: 'a', targetVersionId: 'b' })
    expect(Object.keys(argsOf()).sort()).toEqual([
      'apiKeyHash',
      'baselineVersionId',
      'targetVersionId',
    ])
  })
})

describe('§3 apiCompareVersionConfigs forwards every declared parameter', () => {
  const FULL: Required<ApiV1CompareVersionConfigsParams> = {
    baselineVersionId: 'ver_0',
    targetVersionId: 'ver_1',
    fields: ['findings'],
  }

  it('calls the right ref', async () => {
    await apiCompareVersionConfigs('hash', FULL)
    expect(refOf()).toBe('read_api:apiCompareVersionConfigs')
  })

  it.each(Object.keys(FULL) as (keyof ApiV1CompareVersionConfigsParams)[])(
    'forwards `%s`',
    async (key) => {
      await apiCompareVersionConfigs('hash', FULL)
      expect(argsOf()).toHaveProperty(key, FULL[key])
    },
  )
})

// ===========================================================================
// §4. Completeness fields survive the response direction
// ===========================================================================

describe('§4 the response is passed through verbatim', () => {
  it('preserves every run-level completeness field', async () => {
    const backend = {
      runId: 'run_1',
      baselineVersionId: 'ver_0',
      targetVersionId: 'ver_1',
      verdict: 'indeterminate',
      proven: [],
      speculative: [],
      coverage: {
        assessed: ['model'],
        unassessed: [{ dimension: 'tools', reason: 'target_dimension_absent' }],
        eventsExamined: 500,
        eventHistoryComplete: false,
      },
      nextEventCursor: 'more_events',
    }
    mutationMock.mockResolvedValue(backend)

    const result = await apiGetRunDivergence('hash', { runId: 'r', targetVersionId: 'v' })

    // Verbatim: not reshaped, not filtered, not re-derived. A caller running
    // the contract's `computeDivergenceVerdict` over this sees what the engine
    // saw.
    expect(result).toEqual(backend)
  })

  it.each([
    'scanTruncated',
    'runsUnassessable',
    'runsSkippedForBudget',
    'runsScanned',
    'runsAnalyzed',
    'nextCursor',
  ])('preserves fleet window field `%s`', async (field) => {
    const window = {
      runsScanned: 25,
      runsAnalyzed: 20,
      runsUnassessable: 2,
      runsSkippedForBudget: 3,
      scanTruncated: true,
      nextCursor: 'page_2',
    }
    mutationMock.mockResolvedValue({ window, provenReasons: [], speculativeReasons: [] })

    const result = (await apiGetFleetDivergence('hash', {
      baselineVersionId: 'a',
      targetVersionId: 'b',
    })) as { window: Record<string, unknown> }

    expect(result.window).toHaveProperty(field, window[field as keyof typeof window])
  })

  it('preserves `requiresRunEvidence` on the config-only tier', async () => {
    // The field that stops a caller treating a TIER 1 clean response as "safe
    // to ship": no PROVEN finding is decidable from configs alone.
    mutationMock.mockResolvedValue({
      analysable: true,
      findings: [],
      requiresRunEvidence: ['TOOL_REMOVED'],
    })

    const result = (await apiCompareVersionConfigs('hash', {
      baselineVersionId: 'a',
      targetVersionId: 'b',
    })) as { requiresRunEvidence: string[] }

    expect(result.requiresRunEvidence).toEqual(['TOOL_REMOVED'])
  })

  it('passes a null result through rather than coercing it to an empty object', async () => {
    mutationMock.mockResolvedValue(null)
    const result = await apiGetRunDivergence('hash', { runId: 'r', targetVersionId: 'v' })
    // `{}` would look like a report with no findings — a false clean produced
    // by a forwarder's null-coalescing.
    expect(result).toBeNull()
  })
})

// ===========================================================================
// §5. Field projection — where the guarantee lives now
// ===========================================================================
//
// This section used to test a route-level mirror of the "conclusion pulls its
// caveats" rule (apps/web/app/api/v1/_lib/divergenceFields.ts). That mirror has
// been DELETED: `convex/read_api.ts`'s `validateDivergenceFieldSelection` now
// force-includes `coverage`/`nextEventCursor` (run), `window`/`nextCursor`
// (fleet) and the config tier's provability fields whenever a projection names
// a conclusion-bearing field.
//
// The guarantee is therefore owned upstream and tested upstream. It is NOT
// re-tested here, and it deliberately CANNOT be: everything in this file mocks
// the Convex client, so the augmentation — which happens inside the Convex
// handler, below that mock — is invisible at this layer. An assertion here that
// `coverage` comes back would be asserting against a fixture we wrote, which is
// the definition of a vacuous test.
//
// What this layer still owns, and what tests/unit/blast_radius_v1_projection_
// route.test.ts pins through the real routes, is narrower and real: the route
// must forward the caller's projection VERBATIM and must not post-process the
// response. The upstream rule only protects a request that reaches it intact.
