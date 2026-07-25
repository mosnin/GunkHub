/**
 * `?fields=` query-param parsing/validation for every v1 read route that
 * carries the server-side field projection Team A added to
 * `convex/read_api.ts`:
 *   - GET /api/v1/runs
 *   - GET /api/v1/runs/[runId]
 *   - GET /api/v1/runs/[runId]/events
 *   - GET /api/v1/patterns
 *   - GET /api/v1/patterns/[fingerprintHash]/evidence
 *
 * All five are driven through ONE table so no endpoint's parsing can drift
 * from the others — a `fields` list accepted on one route and rejected on
 * another is its own kind of wrong answer.
 *
 * Both routes are imported for real (via the `@app` alias) with their
 * infrastructure dependencies stubbed — `withApiHandler` to a pass-through,
 * `hashApiKey`, and the service forwarders — so what is under test is exactly
 * the parsing the routes perform (and the shared helper they delegate to,
 * apps/web/app/api/v1/_lib/fieldsParam.ts, which is NOT mocked), not a copy of
 * it reimplemented here. Same shape as
 * tests/unit/event_window_route_validation.test.ts.
 *
 * The rules being pinned:
 *   1. Omitted `fields` => full document, request byte-identical to before
 *      projection existed. Backward compatibility is absolute.
 *   2. A well-formed list is forwarded VERBATIM as a string array.
 *   3. Every malformed list is REJECTED with 400 INVALID_ARGUMENT, never
 *      coerced. Empty is NOT "all fields"; whitespace is not trimmed;
 *      duplicates are not collapsed. Coercion here yields a well-formed,
 *      plausible-looking response that answers a different question than the
 *      caller asked — the `Number()`-style leniency this codebase has been
 *      burned by before.
 *   4. UNKNOWN FIELD NAMES are not checked at this layer at all. The field
 *      vocabulary lives in convex/read_api.ts, which names the offender and
 *      lists the valid names; the route surfaces that error unmodified. Two
 *      lists that can disagree is the failure this deliberately avoids — so
 *      there is a test asserting the route does NOT reject an unknown name
 *      itself, and one asserting it passes the backend's message through.
 *   5. Field selection never changes WHICH records are addressed, and an
 *      unknown-field error is indistinguishable across "record exists",
 *      "record does not exist", and "record belongs to another org".
 */
import { GET as GET_PATTERN_EVIDENCE } from '@app/api/v1/patterns/[fingerprintHash]/evidence/route'
import { GET as GET_PATTERNS } from '@app/api/v1/patterns/route'
import { GET as GET_EVENTS } from '@app/api/v1/runs/[runId]/events/route'
import { GET as GET_RUN } from '@app/api/v1/runs/[runId]/route'
import { GET as GET_RUNS } from '@app/api/v1/runs/route'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted` so the mocks exist before the (hoisted) `vi.mock` factories
// below reference them, which lets every import stay at the top of the file
// where import/order wants them.
const { apiListRunsMock, apiGetRunMock, apiGetRunEventsMock, apiListFailurePatternsMock, apiGetEvidenceMock } =
  vi.hoisted(() => ({
    apiListRunsMock: vi.fn(async (_hash: string, _params: Record<string, unknown>) => ({
      runs: [],
      pageSize: 0,
      total: 0,
    })),
    apiGetRunMock: vi.fn(async (_hash: string, _params: Record<string, unknown>) => ({
      run: { id: 'run_1' },
      eventCount: 0,
      artifactCount: 0,
    })),
    apiGetRunEventsMock: vi.fn(async (_hash: string, _params: Record<string, unknown>) => ({
      events: [],
      nextCursor: undefined,
    })),
    apiListFailurePatternsMock: vi.fn(async (_hash: string, _params: Record<string, unknown>) => ({
      patterns: [],
      nextCursor: undefined,
    })),
    apiGetEvidenceMock: vi.fn(async (_hash: string, _params: Record<string, unknown>) => ({
      pattern: { fingerprintHash: 'abc123def456' },
    })),
  }))

vi.mock('@/lib/services/api_v1', () => ({
  apiListRuns: (hash: string, params: Record<string, unknown>) => apiListRunsMock(hash, params),
  apiGetRun: (hash: string, params: Record<string, unknown>) => apiGetRunMock(hash, params),
  apiGetRunEvents: (hash: string, params: Record<string, unknown>) => apiGetRunEventsMock(hash, params),
  apiListFailurePatterns: (hash: string, params: Record<string, unknown>) =>
    apiListFailurePatternsMock(hash, params),
  apiGetFailurePatternEvidence: (hash: string, params: Record<string, unknown>) =>
    apiGetEvidenceMock(hash, params),
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

const REQUEST_ID = 'req-fields-1'

function makeReq(query: string) {
  return {
    headers: { get: (h: string) => (h === 'x-api-key' ? 'afr_test_key' : null) },
    nextUrl: { searchParams: new URLSearchParams(query) },
  }
}

function callList(query: string) {
  // The handler's real signature after the withApiHandler pass-through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET_RUNS as any)(makeReq(query), { requestId: REQUEST_ID }) as Promise<Response>
}

function callGet(query: string, runId = 'run_1') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET_RUN as any)(makeReq(query), { requestId: REQUEST_ID }, { params: { runId } }) as Promise<Response>
}

function callEvents(query: string, runId = 'run_1') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET_EVENTS as any)(makeReq(query), { requestId: REQUEST_ID }, { params: { runId } }) as Promise<Response>
}

function callPatterns(query: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (GET_PATTERNS as any)(makeReq(query), { requestId: REQUEST_ID }) as Promise<Response>
}

/** A syntactically valid fingerprint — the route 400s on shape before `fields` is reached. */
const FINGERPRINT = 'abc123def456'

function callEvidence(query: string, fingerprintHash = FINGERPRINT) {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (GET_PATTERN_EVIDENCE as any)(makeReq(query), { requestId: REQUEST_ID }, { params: { fingerprintHash } })
  ) as Promise<Response>
}

/**
 * The two service mocks differ only in their (irrelevant here) resolved value,
 * so the shared table below refers to them through the one thing it actually
 * uses: the recorded `(apiKeyHash, params)` call tuples. Typing the table with
 * either concrete mock type would force a cast between two unrelated return
 * shapes.
 */
interface CallRecorder {
  mock: { calls: [string, Record<string, unknown>][] }
}

/** Every route under test, driven through one table so none of them drifts. */
const ROUTES: [string, (query: string) => Promise<Response>, () => CallRecorder][] = [
  ['GET /api/v1/runs', callList, () => apiListRunsMock],
  ['GET /api/v1/runs/[runId]', (q: string) => callGet(q), () => apiGetRunMock],
  ['GET /api/v1/runs/[runId]/events', (q: string) => callEvents(q), () => apiGetRunEventsMock],
  ['GET /api/v1/patterns', callPatterns, () => apiListFailurePatternsMock],
  ['GET /api/v1/patterns/[fingerprintHash]/evidence', (q: string) => callEvidence(q), () => apiGetEvidenceMock],
]

beforeEach(() => {
  apiListRunsMock.mockClear()
  apiGetRunMock.mockClear()
  apiGetRunEventsMock.mockClear()
  apiListFailurePatternsMock.mockClear()
  apiGetEvidenceMock.mockClear()
  apiListRunsMock.mockImplementation(async () => ({ runs: [], pageSize: 0, total: 0 }))
  apiGetRunMock.mockImplementation(async () => ({ run: { id: 'run_1' }, eventCount: 0, artifactCount: 0 }))
  apiGetRunEventsMock.mockImplementation(async () => ({ events: [], nextCursor: undefined }))
  apiListFailurePatternsMock.mockImplementation(async () => ({ patterns: [], nextCursor: undefined }))
  apiGetEvidenceMock.mockImplementation(async () => ({ pattern: { fingerprintHash: FINGERPRINT } }))
})

describe.each(ROUTES)('%s — fields validation', (_label, call, service) => {
  const REJECTED = [
    // `?fields=` is NOT "all fields". A caller that serialized an empty
    // selection asked for something incoherent; handing back the full document
    // is the wrong-but-plausible answer.
    ['empty value', 'fields='],
    ['whitespace-only value', 'fields=%20'],
    ['tab-only value', 'fields=%09'],
    ['a single empty entry among valid ones', 'fields=id,,status'],
    ['a trailing comma', 'fields=id,'],
    ['a leading comma', 'fields=,id'],
    ['only a comma', 'fields=,'],
    ['a whitespace-only entry', 'fields=id,%20,status'],
    // Trimming would accept two different query strings as the same request
    // and would mask a client that joined its list with ", ".
    ['leading whitespace on an entry', 'fields=%20id'],
    ['trailing whitespace on an entry', 'fields=id%20'],
    ['whitespace after a separator', 'fields=id,%20status'],
    // `+` decodes to a space in a query string.
    ['a plus-encoded space', 'fields=id,+status'],
    // De-duplicating hides a caller whose field set was built twice.
    ['a duplicate entry', 'fields=id,status,id'],
    ['a duplicate as the immediate next entry', 'fields=id,id'],
    // Only-the-first-wins is exactly the silent coercion this rejects.
    ['a repeated fields parameter', 'fields=id&fields=status'],
    ['a repeated fields parameter where one is empty', 'fields=id&fields='],
  ] as const

  it.each(REJECTED)('rejects %s with 400 INVALID_ARGUMENT and never calls Convex', async (_l, query) => {
    const res = await call(query)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string }; requestId: string }
    expect(body.error.code).toBe('INVALID_ARGUMENT')
    expect(body.error.message).toMatch(/fields/)
    expect(body.requestId).toBe(REQUEST_ID)
    // NO SECOND SOURCE OF TRUTH: a route-level SHAPE error must never quote a
    // field vocabulary. Only convex/read_api.ts, which derives the set from
    // the live schema, may say "valid fields are: ...". If this ever starts
    // failing, a field list has been copied into the web layer where it can
    // drift from the schema.
    expect(body.error.message).not.toMatch(/valid fields are/)
    // The whole point of rejecting rather than coercing: no read is performed.
    expect(service()).not.toHaveBeenCalled()
  })

  const ACCEPTED: [string, string, string[]][] = [
    ['a single field', 'fields=status', ['status']],
    ['several fields', 'fields=id,status,startedAt', ['id', 'status', 'startedAt']],
    ['field names with underscores and digits', 'fields=agent_id,v2', ['agent_id', 'v2']],
    // NOT a route concern: convex/read_api.ts owns the field vocabulary and is
    // the one component allowed to say "unknown field". Rejecting here would
    // create a second list that can disagree with the first.
    ['an unknown field name (Convex rejects it, not the route)', 'fields=nope', ['nope']],
    ['a dotted path (vocabulary is the backend’s business)', 'fields=payload.model', ['payload.model']],
  ]

  it.each(ACCEPTED)('accepts %s and forwards it verbatim', async (_l, query, expected) => {
    const res = await call(query)
    expect(res.status).toBe(200)
    expect(service()).toHaveBeenCalledTimes(1)
    const [hash, params] = service().mock.calls[0]!
    expect(hash).toBe('hashed:afr_test_key')
    expect(params.fields).toEqual(expected)
  })

  /**
   * BACKWARD COMPATIBILITY. An existing consumer sends no `fields` at all and
   * must reach the service with a request indistinguishable from the one it
   * sent before projection existed — not `fields: undefined`, not `fields: []`.
   */
  it('omits fields entirely when the query param is absent', async () => {
    const res = await call('limit=10')
    expect(res.status).toBe(200)
    const [, params] = service().mock.calls[0]!
    expect('fields' in params).toBe(false)
  })

  it('rejects a malformed fields even when the other params are valid', async () => {
    const res = await call('fields=id,,status&limit=5&cursor=c_abc')
    expect(res.status).toBe(400)
    expect(service()).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/runs — fields composes with the existing filters', () => {
  it('forwards fields alongside status/agentId/limit/cursor, none dropped', async () => {
    await callList('status=failed&agentId=agent_1&environment=prod&session=s_1&limit=5&cursor=c_abc&fields=id,status')
    const [, params] = apiListRunsMock.mock.calls[0]!
    expect(params).toEqual({
      status: 'failed',
      agentId: 'agent_1',
      environment: 'prod',
      sessionId: 's_1',
      limit: 5,
      cursor: 'c_abc',
      fields: ['id', 'status'],
    })
  })

  /**
   * TENANCY / SELECTION INVARIANCE: field selection is response shaping only.
   * The filters that decide WHICH runs come back must be byte-identical with
   * and without `fields` — otherwise a projection could widen or narrow the
   * result set, and org scoping is a property of that set.
   */
  it('does not change any record-selecting filter when fields is added', async () => {
    await callList('status=failed&agentId=agent_1&limit=5')
    const withoutFields = apiListRunsMock.mock.calls[0]![1]

    apiListRunsMock.mockClear()
    await callList('status=failed&agentId=agent_1&limit=5&fields=id')
    const withFields = apiListRunsMock.mock.calls[0]![1]

    const { fields: _projection, ...selectors } = withFields
    expect(selectors).toEqual(withoutFields)
  })
})

describe('GET /api/v1/runs/[runId]/events — fields composes with the window params', () => {
  it('forwards fields alongside fromSequence/limit/cursor, none dropped', async () => {
    await callEvents('fromSequence=42&limit=5&cursor=c_abc&fields=sequenceNumber,type')
    const [, params] = apiGetRunEventsMock.mock.calls[0]!
    expect(params).toEqual({
      runId: 'run_1',
      fromSequence: 42,
      limit: 5,
      cursor: 'c_abc',
      fields: ['sequenceNumber', 'type'],
    })
  })

  /**
   * The two reject-never-coerce params are independent: a valid projection
   * does not rescue a malformed window, and a valid window does not rescue a
   * malformed projection. Either way nothing is read.
   */
  it('rejects a malformed fromSequence even with a valid fields, and vice versa', async () => {
    expect((await callEvents('fromSequence=3.7&fields=type')).status).toBe(400)
    expect((await callEvents('fromSequence=42&fields=type,type')).status).toBe(400)
    expect(apiGetRunEventsMock).not.toHaveBeenCalled()
  })

  /**
   * `fields` cannot move the window floor or change which events match it —
   * projection is response shaping only.
   */
  it('does not change the window when fields is added', async () => {
    await callEvents('fromSequence=42&limit=5')
    const withoutFields = apiGetRunEventsMock.mock.calls[0]![1]

    apiGetRunEventsMock.mockClear()
    await callEvents('fromSequence=42&limit=5&fields=type')
    const { fields: _projection, ...selectors } = apiGetRunEventsMock.mock.calls[0]![1]
    expect(selectors).toEqual(withoutFields)
  })
})

describe('GET /api/v1/patterns — fields is stricter than the sibling filters, on purpose', () => {
  it('forwards fields alongside the lifecycle filters, none dropped', async () => {
    await callPatterns('agentId=agent_1&spiking=true&status=resolved&limit=5&fields=fingerprintHash,count')
    const [, params] = apiListFailurePatternsMock.mock.calls[0]!
    expect(params).toEqual({
      agentId: 'agent_1',
      spiking: true,
      status: 'resolved',
      limit: 5,
      fields: ['fingerprintHash', 'count'],
    })
  })

  /**
   * Every other filter on this route parses permissively — a junk value is
   * treated as unset, because an ignored filter can only WIDEN the result set,
   * which the caller can see. `fields` is the opposite: an ignored projection
   * NARROWS the document and is invisible. Pinned so the asymmetry survives a
   * future "make it consistent with the other params" tidy-up.
   */
  it('ignores a junk status but rejects a junk fields', async () => {
    const okRes = await callPatterns('status=banana')
    expect(okRes.status).toBe(200)
    expect(apiListFailurePatternsMock.mock.calls[0]![1]).toEqual({})

    apiListFailurePatternsMock.mockClear()
    const badRes = await callPatterns('fields=count,count')
    expect(badRes.status).toBe(400)
    expect(apiListFailurePatternsMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/patterns/[fingerprintHash]/evidence — fields projects the embedded pattern only', () => {
  it('forwards fields alongside the fingerprint, which is unchanged', async () => {
    await callEvidence('fields=fingerprintHash,count')
    expect(apiGetEvidenceMock.mock.calls[0]![1]).toEqual({
      fingerprintHash: FINGERPRINT,
      fields: ['fingerprintHash', 'count'],
    })
  })

  /**
   * The pre-existing fingerprint-shape guard still runs first: a malformed
   * fingerprint 400s regardless of `fields`, and no read happens either way.
   */
  it('still rejects a malformed fingerprint, with or without fields', async () => {
    expect((await callEvidence('', 'not-a-hash')).status).toBe(400)
    expect((await callEvidence('fields=count', 'not-a-hash')).status).toBe(400)
    expect(apiGetEvidenceMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/runs/[runId] — fields does not touch record selection', () => {
  it('forwards the same runId with and without fields', async () => {
    await callGet('', 'run_abc')
    expect(apiGetRunMock.mock.calls[0]![1]).toEqual({ runId: 'run_abc' })

    apiGetRunMock.mockClear()
    await callGet('fields=id,status', 'run_abc')
    expect(apiGetRunMock.mock.calls[0]![1]).toEqual({ runId: 'run_abc', fields: ['id', 'status'] })
  })
})

/**
 * TENANCY: an argument error must not become an existence oracle.
 *
 * A malformed `fields` is rejected by the route before the API key is even
 * hashed, so the response cannot depend on the addressed record at all — the
 * three cases below (a run in the caller's org, a run id that does not exist,
 * and a run id belonging to a DIFFERENT org) must produce byte-identical
 * responses. If they ever diverged, `?fields=,` would be a probe for "does
 * this run id exist somewhere in the system".
 */
describe('GET /api/v1/runs/[runId] — malformed fields is indistinguishable across tenancy cases', () => {
  const RUN_IDS = [
    ['a run in the caller’s org', 'run_owned'],
    ['a run id that does not exist', 'run_missing'],
    ['a run belonging to another org', 'run_other_org'],
  ] as const

  it('returns the identical 400 body and status for every case, and never reads', async () => {
    const bodies: string[] = []
    for (const [, runId] of RUN_IDS) {
      apiGetRunMock.mockClear()
      const res = await callGet('fields=', runId)
      expect(res.status).toBe(400)
      expect(apiGetRunMock).not.toHaveBeenCalled()
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
    // And it leaks nothing about the addressed record.
    expect(bodies[0]).not.toMatch(/run_owned|run_missing|run_other_org/)
  })
})

/**
 * The backend's unknown-field error is surfaced FAITHFULLY: the route neither
 * swallows it, nor rewrites it, nor substitutes a field list of its own. The
 * message the caller reads is the one convex/read_api.ts wrote — the single
 * source of truth for which fields exist.
 *
 * NOTE ON STATUS: the code (`INVALID_ARGUMENT`) and message pass through
 * unchanged; the HTTP status is decided by the SHARED resolver in
 * apps/web/src/lib/apiErrorMapping.ts, whose `EXTRA_CODE_TO_STATUS` maps
 * `INVALID_ARGUMENT -> 422` for every v1 route (a pre-existing, deliberate
 * choice this change does not own and must not special-case per-route — a
 * per-route override would be exactly the second-source-of-truth problem in a
 * different guise). Route-level SHAPE rejections above are 400 because they
 * use the routes' own inline idiom. This test pins the actual behavior so the
 * split is visible rather than assumed.
 */
describe('GET /api/v1/runs/[runId] — an unknown field name is surfaced from Convex, not invented here', () => {
  const CONVEX_MESSAGE =
    'INVALID_ARGUMENT: unknown field "nope"; valid fields are: id, status, startedAt, endedAt'

  beforeEach(() => {
    apiGetRunMock.mockImplementation(async () => {
      throw new Error(CONVEX_MESSAGE)
    })
  })

  it('passes the backend’s code and message through untouched', async () => {
    const res = await callGet('fields=nope')
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_ARGUMENT')
    // The offending field AND the valid list come from the backend verbatim.
    expect(body.error.message).toContain('unknown field "nope"')
    expect(body.error.message).toContain('valid fields are: id, status, startedAt, endedAt')
    // Pinned, not asserted-as-desired — see the NOTE ON STATUS above.
    expect(res.status).toBe(422)
  })

  it('reaches Convex at all (the route did not pre-empt it with its own field list)', async () => {
    await callGet('fields=nope')
    expect(apiGetRunMock).toHaveBeenCalledTimes(1)
    expect(apiGetRunMock.mock.calls[0]![1].fields).toEqual(['nope'])
  })

  /**
   * TENANCY, the harder half: the unknown-field error must be identical
   * whether the addressed run exists, does not exist, or belongs to another
   * org. Convex validates the projection argument before it discloses anything
   * about the record, so all three throw the same error — and the route must
   * not add run-specific context on the way out.
   */
  it('is byte-identical across exists / missing / other-org', async () => {
    const bodies: string[] = []
    for (const runId of ['run_owned', 'run_missing', 'run_other_org']) {
      const res = await callGet('fields=nope', runId)
      expect(res.status).toBe(422)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).not.toMatch(/run_owned|run_missing|run_other_org/)
  })
})
