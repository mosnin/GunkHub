/**
 * Param-forwarding tables for the two v1 run-read forwarders that carry the
 * `?fields=` projection selector — `apiListRuns` and `apiGetRun` in
 * apps/web/src/lib/services/api_v1.ts — added in the SAME commit as the param
 * itself.
 *
 * Same hazard and same convention as tests/unit/event_window_api_v1_params.test.ts
 * and tests/unit/api_v1_failure_patterns_params.test.ts: these args cross a
 * hand-maintained `makeFunctionReference` string ref
 * (apps/web/src/lib/convexFunctions.ts), so nothing structurally typechecks the
 * forwarded object against the real Convex handler's `args`. A param declared
 * on the interface but omitted from the spread is not a type error — it is a
 * silent wrong answer, and this codebase has already shipped exactly that
 * (`apiListFailurePatterns` dropping `spiking`/`muted`, so `afr patterns
 * --spiking` returned unfiltered results for weeks).
 *
 * `fields` is a particularly bad param to drop: a dropped projection returns
 * the FULL document, which is a well-formed, plausible-looking response that
 * a caller cannot distinguish from a projection that legitimately included
 * every field they asked for.
 *
 * This file uses the STRONGER of the two existing conventions: a
 * `Record<keyof Params, true>` exhaustiveness assignment, so a param added to
 * either interface but not to its table FAILS TO COMPILE rather than merely
 * going uncovered.
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
  runs: [],
  pageSize: 0,
  run: {},
  eventCount: 0,
  artifactCount: 0,
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    read_api: {
      apiListRuns: 'read_api:apiListRuns',
      apiGetRun: 'read_api:apiGetRun',
    },
  },
}))

import { getPublicClient } from '@/lib/convexServer'
import {
  apiGetRun,
  apiListRuns,
  type ApiV1GetRunParams,
  type ApiV1ListRunsParams,
} from '@/lib/services/api_v1'

beforeEach(() => {
  mutationMock.mockClear()
  vi.mocked(getPublicClient).mockReturnValue({
    mutation: mutationMock,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
})

// ---------------------------------------------------------------------------
// apiListRuns
// ---------------------------------------------------------------------------

const LIST_PARAM_TABLE: { name: keyof ApiV1ListRunsParams; value: unknown }[] = [
  { name: 'status', value: 'failed' },
  { name: 'agentId', value: 'agent_1' },
  { name: 'environment', value: 'production' },
  { name: 'sessionId', value: 'sess_1' },
  { name: 'limit', value: 25 },
  { name: 'cursor', value: 'cursor_abc' },
  { name: 'fields', value: ['id', 'status'] },
]

describe('apiListRuns — every declared param reaches the Convex mutation call', () => {
  it.each(LIST_PARAM_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const params = { [name]: value } as ApiV1ListRunsParams
    await apiListRuns('hashed_key', params)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    // `name` widens to `string | number | symbol`; toHaveProperty wants a string.
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards apiKeyHash plus every param at once, with none dropped', async () => {
    const params: ApiV1ListRunsParams = {
      status: 'failed',
      agentId: 'agent_1',
      environment: 'production',
      sessionId: 'sess_1',
      limit: 10,
      cursor: 'cursor_xyz',
      fields: ['id', 'status', 'startedAt'],
    }
    await apiListRuns('hashed_key', params)

    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({
      apiKeyHash: 'hashed_key',
      status: 'failed',
      agentId: 'agent_1',
      environment: 'production',
      sessionId: 'sess_1',
      limit: 10,
      cursor: 'cursor_xyz',
      fields: ['id', 'status', 'startedAt'],
    })
  })

  /**
   * BACKWARD COMPATIBILITY, at the forwarder. Omitting `fields` must not send
   * `fields: undefined` — Convex argument validators reject unexpected keys,
   * and more importantly an existing caller's request must reach the backend
   * byte-identical to how it did before projection existed.
   */
  it('omits fields entirely when absent (never a stray `undefined` key)', async () => {
    await apiListRuns('hashed_key', {})
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key' })
    expect('fields' in args).toBe(false)
  })

  /**
   * The list is forwarded VERBATIM. Sorting, de-duplicating, trimming, or
   * dropping names here would (a) make the backend's "unknown field X" error
   * name a field the caller never sent, and (b) quietly answer a different
   * question than the one asked. Shape validation belongs at the route
   * (reject) and name validation in Convex (reject) — never here (transform).
   */
  it('forwards fields verbatim — no sorting, de-duplication, or trimming', async () => {
    const wire = ['zeta', 'alpha', 'zeta ']
    await apiListRuns('hashed_key', { fields: wire })
    expect(mutationMock.mock.calls[0]![1].fields).toEqual(['zeta', 'alpha', 'zeta '])
  })

  it('forwards a single-element list as a list, not a bare string', async () => {
    await apiListRuns('hashed_key', { fields: ['status'] })
    expect(mutationMock.mock.calls[0]![1].fields).toEqual(['status'])
  })

  it('LIST_PARAM_TABLE covers every field of ApiV1ListRunsParams', () => {
    const ALL_DECLARED_PARAMS = [
      'status',
      'agentId',
      'environment',
      'sessionId',
      'limit',
      'cursor',
      'fields',
    ] satisfies Array<keyof ApiV1ListRunsParams>
    // Exhaustiveness in the other direction: this assignment FAILS TO COMPILE
    // if `ApiV1ListRunsParams` grows a field not present in the list above.
    const _exhaustive: Record<keyof ApiV1ListRunsParams, true> = {
      status: true,
      agentId: true,
      environment: true,
      sessionId: true,
      limit: true,
      cursor: true,
      fields: true,
    }
    void _exhaustive
    expect(LIST_PARAM_TABLE.map((p) => String(p.name)).sort()).toEqual([...ALL_DECLARED_PARAMS].sort())
  })
})

// ---------------------------------------------------------------------------
// apiGetRun
// ---------------------------------------------------------------------------

const GET_PARAM_TABLE: { name: keyof ApiV1GetRunParams; value: unknown }[] = [
  { name: 'runId', value: 'run_1' },
  { name: 'fields', value: ['id', 'status'] },
]

describe('apiGetRun — every declared param reaches the Convex mutation call', () => {
  it.each(GET_PARAM_TABLE)('forwards $name unchanged', async ({ name, value }) => {
    const params = { runId: 'run_1', [name]: value } as ApiV1GetRunParams
    await apiGetRun('hashed_key', params)

    expect(mutationMock).toHaveBeenCalledTimes(1)
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toHaveProperty(String(name), value)
  })

  it('forwards apiKeyHash plus every param at once, with none dropped', async () => {
    await apiGetRun('hashed_key', { runId: 'run_1', fields: ['id', 'status'] })
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key', runId: 'run_1', fields: ['id', 'status'] })
  })

  it('omits fields entirely when absent (never a stray `undefined` key)', async () => {
    await apiGetRun('hashed_key', { runId: 'run_1' })
    const [, args] = mutationMock.mock.calls[0]!
    expect(args).toEqual({ apiKeyHash: 'hashed_key', runId: 'run_1' })
    expect('fields' in args).toBe(false)
  })

  /**
   * TENANCY: the projection selector must not touch the record selector. The
   * `runId` reaching Convex is identical with and without `fields`, so
   * projection can never change WHICH record is addressed — org scoping stays
   * entirely inside the Convex function and is unaffected by field selection.
   */
  it('sends an identical runId with and without fields', async () => {
    await apiGetRun('hashed_key', { runId: 'run_1' })
    const withoutFields = mutationMock.mock.calls[0]![1]

    mutationMock.mockClear()
    await apiGetRun('hashed_key', { runId: 'run_1', fields: ['id'] })
    const withFields = mutationMock.mock.calls[0]![1]

    expect(withFields.runId).toBe(withoutFields.runId)
    expect(withFields.apiKeyHash).toBe(withoutFields.apiKeyHash)
    // The projection is the ONLY difference between the two calls.
    const { fields: _omitted, ...rest } = withFields
    expect(rest).toEqual(withoutFields)
  })

  it('GET_PARAM_TABLE covers every field of ApiV1GetRunParams', () => {
    const ALL_DECLARED_PARAMS = ['runId', 'fields'] satisfies Array<keyof ApiV1GetRunParams>
    const _exhaustive: Record<keyof ApiV1GetRunParams, true> = {
      runId: true,
      fields: true,
    }
    void _exhaustive
    expect(GET_PARAM_TABLE.map((p) => String(p.name)).sort()).toEqual([...ALL_DECLARED_PARAMS].sort())
  })
})
