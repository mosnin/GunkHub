/**
 * END-TO-END behaviour of POST /api/v1/traces
 * (apps/web/app/api/v1/traces/route.ts).
 *
 * The Convex mutation is replaced by a small in-memory fake that enforces the
 * SAME three things the real one does — key resolution with an `ingest:write`
 * scope check, org derivation from the key, and (orgId, traceId) -> run
 * resolution. That is deliberate: the properties under test here are
 * properties of the ROUTE's composition (what it forwards, what it collapses,
 * what status it picks), and a fake that got org scoping wrong would let a
 * route bug hide behind a backend bug.
 *
 * Request bodies are produced by the REAL OTel serializers, so what these
 * tests POST is byte-for-byte what an `OTLPTraceExporter` would POST.
 */
import { POST } from '@app/api/v1/traces/route'
import { context, trace } from '@opentelemetry/api'
import { JsonTraceSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProtoReader, WIRE_LENGTH_DELIMITED, WIRE_VARINT } from '@/lib/otel/protobuf'
// Imported here rather than after the `vi.mock` calls below purely for import
// ordering: vitest hoists `vi.hoisted` and every `vi.mock` factory above ALL
// imports, so the route still loads against the mocked modules.

// ---------------------------------------------------------------------------
// The fake backend.
// ---------------------------------------------------------------------------

// `vi.mock` factories are hoisted above every top-level binding, so anything
// they close over must be created inside `vi.hoisted`. The route uses
// `instanceof ConvexTimeoutError`, so the mock must export a REAL class, not a
// stub object.
const { FakeConvexTimeoutError, mutationMock } = vi.hoisted(() => {
  class FakeConvexTimeoutError extends Error {
    constructor() {
      super('convex timeout')
      this.name = 'ConvexTimeoutError'
    }
  }
  return {
    FakeConvexTimeoutError,
    mutationMock: vi.fn<[unknown, Record<string, unknown>], unknown>(),
  }
})

interface FakeKey {
  orgId: string
  scopes: string[]
}

/** hash -> key. `hashApiKey` below is `sha256`-free: it just prefixes. */
const KEYS = new Map<string, FakeKey>([
  ['h:orgA-ingest', { orgId: 'orgA', scopes: ['ingest:write'] }],
  ['h:orgB-ingest', { orgId: 'orgB', scopes: ['ingest:write'] }],
  ['h:orgA-readonly', { orgId: 'orgA', scopes: ['read'] }],
])

/** agentId -> owning org. */
const AGENTS = new Map<string, string>([
  ['agent_A', 'orgA'],
  ['agent_B', 'orgB'],
])

/** `${orgId}::${traceId}` -> runId. Proves org-scoped run resolution. */
let RUNS = new Map<string, string>()
let runCounter = 0
/** Every call the route made, for forwarding assertions. */
let calls: Array<Record<string, unknown>> = []
/** Per-trace overrides so a test can force a specific backend failure. */
let failures = new Map<string, Error>()

function fakeMutation(_ref: unknown, args: Record<string, unknown>): unknown {
  calls.push(args)

  const key = KEYS.get(args['apiKeyHash'] as string)
  // Mirrors convex/sdk_ingest.ts resolveApiKey: unknown key and wrong scope
  // throw DIFFERENT messages. The route must collapse them anyway.
  if (key === undefined) throw new Error('Unauthorized')
  if (!key.scopes.includes('ingest:write')) {
    throw new Error('Forbidden: API key lacks required scope "ingest:write"')
  }

  const agentOrg = AGENTS.get(args['agentId'] as string)
  // Mirrors the real mutation's collapsed outcome: a nonexistent agent and an
  // agent in another org are the same error.
  if (agentOrg === undefined || agentOrg !== key.orgId) throw new Error('Agent not found')

  const traceId = args['traceId'] as string
  const forced = failures.get(traceId)
  if (forced !== undefined) throw forced

  const runKey = `${key.orgId}::${traceId}`
  let runId = RUNS.get(runKey)
  const runCreated = runId === undefined
  if (runId === undefined) {
    runCounter += 1
    runId = `run_${String(runCounter)}`
    RUNS.set(runKey, runId)
  }

  const spans = args['spans'] as unknown[]
  return {
    runId,
    runCreated,
    eventIds: spans.map((_, i) => `evt_${runId!}_${String(i)}`),
    unmappedCount: 0,
    rejected: [],
    diagnostics: [],
    runOpen: true,
    terminalType: null,
    firstSequenceNumber: 1,
    lastSequenceNumber: spans.length,
    stats: {
      spansIn: spans.length,
      spansAccepted: spans.length,
      spansMapped: spans.length,
      spansUnmapped: 0,
      spansRejected: 0,
      eventsOut: spans.length,
      clockSkewClamps: 0,
    },
  }
}

vi.mock('@/lib/convexServer', () => ({
  // Deterministic and reversible so the fake key table above is readable. The
  // real one is sha256; the route only ever passes the RESULT downstream, and
  // asserting "the raw secret never leaves the route" is easier with a
  // recognizable transform.
  hashApiKey: (k: string) => `h:${k}`,
  getPublicClient: () => ({ mutation: mutationMock }),
  withConvexTimeout: async (p: unknown) => p,
  ConvexTimeoutError: FakeConvexTimeoutError,
  CONVEX_CALL_TIMEOUT_MS: 10_000,
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: { otel_ingest: { otelIngestSpans: 'otel_ingest:otelIngestSpans' } },
}))

// ---------------------------------------------------------------------------
// Fixtures — real OTLP bytes.
// ---------------------------------------------------------------------------

function makeSpans(names: string[], sameTrace = true) {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const tracer = provider.getTracer('openinference.instrumentation.openai', '0.1.0')
  if (sameTrace) {
    const root = tracer.startSpan(names[0]!)
    const ctx = trace.setSpan(context.active(), root)
    for (const n of names.slice(1)) tracer.startSpan(n, {}, ctx).end()
    root.end()
  } else {
    for (const n of names) tracer.startSpan(n).end()
  }
  return exporter.getFinishedSpans()
}

function protoBody(names: string[], sameTrace = true): Uint8Array {
  return ProtobufTraceSerializer.serializeRequest(makeSpans(names, sameTrace))!
}

function jsonBody(names: string[], sameTrace = true): string {
  return new TextDecoder().decode(JsonTraceSerializer.serializeRequest(makeSpans(names, sameTrace))!)
}

const AUTH_A = { 'x-api-key': 'orgA-ingest', 'x-afr-agent-id': 'agent_A' }
const AUTH_B = { 'x-api-key': 'orgB-ingest', 'x-afr-agent-id': 'agent_B' }

function post(
  body: Uint8Array | string | null,
  headers: Record<string, string>,
): Promise<Response> {
  const req = new Request('https://afr.test/api/v1/traces', {
    method: 'POST',
    headers,
    ...(body !== null && { body: body as unknown as BodyInit }),
  })
  // withApiHandler types its param as NextRequest but only touches
  // Request-shaped members plus `nextUrl`, which this route never reads.
  return POST(req as never)
}

/** Read `partial_success` out of a protobuf ExportTraceServiceResponse. */
async function partialSuccess(
  res: Response,
): Promise<{ rejectedSpans: number; errorMessage: string } | null> {
  const r = new ProtoReader(new Uint8Array(await res.arrayBuffer()))
  let out: { rejectedSpans: number; errorMessage: string } | null = null
  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === 1 && wireType === WIRE_LENGTH_DELIMITED) {
      const inner = r.readMessage()
      let rejectedSpans = 0
      let errorMessage = ''
      while (!inner.eof) {
        const t = inner.readTag()
        if (t.fieldNumber === 1 && t.wireType === WIRE_VARINT) rejectedSpans = inner.readVarintAsNumber()
        else if (t.fieldNumber === 2 && t.wireType === WIRE_LENGTH_DELIMITED) errorMessage = inner.readString()
        else inner.skipField(t.wireType)
      }
      out = { rejectedSpans, errorMessage }
    } else r.skipField(wireType)
  }
  return out
}

beforeEach(() => {
  mutationMock.mockClear()
  mutationMock.mockImplementation(fakeMutation)
  calls = []
  RUNS = new Map()
  failures = new Map()
  runCounter = 0
})

// ---------------------------------------------------------------------------

describe('happy paths', () => {
  it('accepts a real protobuf export and answers 200 in protobuf', async () => {
    const res = await post(protoBody(['invoke_agent a', 'chat gpt-4o']), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    // Full success: `partial_success` unset, i.e. an empty message.
    expect(await partialSuccess(res)).toBeNull()

    expect(calls).toHaveLength(1)
    expect(calls[0]!['apiKeyHash']).toBe('h:orgA-ingest')
    expect(calls[0]!['agentId']).toBe('agent_A')
    // The RAW key must never cross the boundary — only its hash. Asserted as
    // "no forwarded VALUE equals the raw secret" rather than a substring
    // search, because the test's stand-in hash deliberately embeds its input.
    expect(Object.values(calls[0]!)).not.toContain('orgA-ingest')
    expect(calls[0]).not.toHaveProperty('apiKey')
    expect((calls[0]!['spans'] as unknown[])).toHaveLength(2)
  })

  it('accepts a real JSON export and answers 200 in JSON', async () => {
    const res = await post(jsonBody(['chat gpt-4o']), {
      'content-type': 'application/json',
      ...AUTH_A,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({})
  })

  it('forwards the optional agent version only when the header is present', async () => {
    await post(protoBody(['chat']), { 'content-type': 'application/x-protobuf', ...AUTH_A })
    expect(calls[0]).not.toHaveProperty('agentVersion')

    await post(protoBody(['chat']), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
      'x-afr-agent-version': 'v7',
    })
    expect(calls[1]!['agentVersion']).toBe('v7')
  })

  it('issues ONE call per trace for a multi-trace export', async () => {
    const res = await post(protoBody(['t1', 't2', 't3'], /* sameTrace */ false), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })
    expect(res.status).toBe(200)
    // OTLP explicitly permits many traces per export. Each is its own run and
    // its own transaction; batching them into one call would let one trace's
    // spans consume another's sequence numbers.
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((c) => c['traceId'] as string)).size).toBe(3)
    for (const c of calls) {
      const spans = c['spans'] as Array<{ traceId: string }>
      expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([c['traceId']]))
    }
  })

  it('answers 200 to an empty export', async () => {
    const res = await post(protoBody([], false), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})

describe('auth failures are indistinguishable', () => {
  const body = () => protoBody(['chat gpt-4o'])

  it('missing key, unknown key, and wrong-scope key are byte-identical 401s', async () => {
    const b = body()
    const noKey = await post(b, { 'content-type': 'application/x-protobuf', 'x-afr-agent-id': 'agent_A' })
    const unknown = await post(b, {
      'content-type': 'application/x-protobuf',
      'x-api-key': 'this-key-does-not-exist',
      'x-afr-agent-id': 'agent_A',
    })
    const wrongScope = await post(b, {
      'content-type': 'application/x-protobuf',
      'x-api-key': 'orgA-readonly',
      'x-afr-agent-id': 'agent_A',
    })

    for (const res of [noKey, unknown, wrongScope]) {
      expect(res.status).toBe(401)
      expect(res.headers.get('content-type')).toBe('application/x-protobuf')
      // 401 is non-retryable per the OTLP spec: no backoff fixes a credential.
      expect(res.headers.get('retry-after')).toBeNull()
    }

    const bodies = await Promise.all(
      [noKey, unknown, wrongScope].map(async (r) => [...new Uint8Array(await r.arrayBuffer())]),
    )
    // THE ORACLE TEST. A 403 for wrong-scope (which the /api/v1 read routes
    // return) tells an attacker brute-forcing keys which guesses EXIST,
    // because only an existing key can produce a 403.
    expect(bodies[1]).toEqual(bodies[0])
    expect(bodies[2]).toEqual(bodies[0])
    expect([noKey, unknown, wrongScope].map((r) => r.status)).not.toContain(403)
  })

  it('a nonexistent agent and another org’s agent are the same answer', async () => {
    const b = body()
    const missing = await post(b, {
      'content-type': 'application/x-protobuf',
      'x-api-key': 'orgA-ingest',
      'x-afr-agent-id': 'agent_does_not_exist',
    })
    const crossOrg = await post(b, {
      'content-type': 'application/x-protobuf',
      'x-api-key': 'orgA-ingest',
      // A REAL agent — but it belongs to org B.
      'x-afr-agent-id': 'agent_B',
    })

    expect(missing.status).toBe(crossOrg.status)
    expect([...new Uint8Array(await missing.arrayBuffer())]).toEqual(
      [...new Uint8Array(await crossOrg.arrayBuffer())],
    )
    // Non-retryable: pointing at somebody else's agent is not transient.
    expect(crossOrg.headers.get('retry-after')).toBeNull()
  })
})

describe('cross-org isolation', () => {
  it('the SAME traceId under two orgs’ keys produces two unrelated runs', async () => {
    const spans = makeSpans(['invoke_agent x', 'chat gpt-4o'])
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    const traceId = spans[0]!.spanContext().traceId

    const a = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })
    const b = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_B })

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(calls).toHaveLength(2)
    // Both calls name the same trace...
    expect(calls[0]!['traceId']).toBe(traceId)
    expect(calls[1]!['traceId']).toBe(traceId)
    // ...and the route passes NO org of its own. The org is derived solely
    // from the key hash inside Convex, which is what makes cross-org ingest
    // structurally impossible rather than carefully avoided: there is no org
    // parameter for the route to get wrong.
    expect(calls[0]).not.toHaveProperty('orgId')
    expect(calls[0]).not.toHaveProperty('organizationId')
    // Two distinct runs, one per org.
    expect(RUNS.get(`orgA::${traceId}`)).toBeDefined()
    expect(RUNS.get(`orgB::${traceId}`)).toBeDefined()
    expect(RUNS.get(`orgA::${traceId}`)).not.toBe(RUNS.get(`orgB::${traceId}`))
  })

  it('org B cannot append to a run org A already created for that trace', async () => {
    const spans = makeSpans(['invoke_agent x'])
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    const traceId = spans[0]!.spanContext().traceId

    await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })
    const runA = RUNS.get(`orgA::${traceId}`)

    await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_B })
    expect(RUNS.get(`orgA::${traceId}`)).toBe(runA)
    expect(RUNS.get(`orgB::${traceId}`)).not.toBe(runA)
  })
})

describe('content type and shape errors', () => {
  it('rejects a bad Content-Type with 415, answered in JSON', async () => {
    for (const ct of ['text/plain', 'application/octet-stream', 'application/grpc']) {
      const res = await post(protoBody(['chat']), { 'content-type': ct, ...AUTH_A })
      expect(res.status).toBe(415)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(res.headers.get('retry-after')).toBeNull()
      expect(await res.json()).toMatchObject({ code: 3 })
    }
    expect(calls).toHaveLength(0)
  })

  it('rejects a missing Content-Type rather than sniffing the body', async () => {
    const req = new Request('https://afr.test/api/v1/traces', {
      method: 'POST',
      headers: AUTH_A,
      body: 'plain text' as unknown as BodyInit,
    })
    // `fetch` supplies text/plain for a string body, so this exercises the
    // "unsupported type" branch either way.
    const res = await POST(req as never)
    expect(res.status).toBe(415)
  })

  it('rejects a missing x-afr-agent-id with 400, before any backend call', async () => {
    const res = await post(protoBody(['chat']), {
      'content-type': 'application/x-protobuf',
      'x-api-key': 'orgA-ingest',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rejects a corrupt protobuf body with 400 (non-retryable)', async () => {
    const good = protoBody(['chat gpt-4o'])
    const res = await post(good.subarray(0, good.length - 4), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })
    expect(res.status).toBe(400)
    // A body this malformed is malformed identically on every retry, so
    // marking it retryable would spin the exporter forever.
    expect(res.headers.get('retry-after')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rejects an oversized body with 413 before the backend is touched', async () => {
    const huge = new Uint8Array(5 * 1024 * 1024)
    const res = await post(huge, { 'content-type': 'application/x-protobuf', ...AUTH_A })
    expect(res.status).toBe(413)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('partial success', () => {
  it('malformed spans among good ones are a 200 with rejected_spans, NOT an error', async () => {
    // A hand-built JSON batch is the only way to inject a span the real SDK
    // cannot produce. Three good, two structurally invalid.
    const t = '4bf92f3577b34da6a3ce929d0e0e4736'
    const span = (spanId: string, extra: Record<string, unknown> = {}) => ({
      traceId: t,
      spanId,
      name: 'chat gpt-4o',
      kind: 3,
      startTimeUnixNano: '1700000000000000000',
      endTimeUnixNano: '1700000001000000000',
      ...extra,
    })
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: 's' },
              spans: [
                span('00f067aa0ba902b1'),
                span('00f067aa0ba902b2'),
                span('00f067aa0ba902b3'),
                span('zzzznothexzzzzzz'),
                span('00f067aa0ba902b5', { startTimeUnixNano: '0' }),
              ],
            },
          ],
        },
      ],
    })

    const res = await post(body, { 'content-type': 'application/json', ...AUTH_A })

    // THE CENTRAL RULING. The three good spans were durably written; telling
    // the exporter "failed" makes it retry the whole batch, and on an
    // append-only log those three become a SECOND set of events that can never
    // be deleted.
    expect(res.status).toBe(200)
    expect(res.headers.get('retry-after')).toBeNull()

    const payload = (await res.json()) as {
      partialSuccess?: { rejectedSpans?: string; errorMessage?: string }
    }
    expect(payload.partialSuccess?.rejectedSpans).toBe('2')
    expect(payload.partialSuccess?.errorMessage).toContain('malformed-span-id=1')
    expect(payload.partialSuccess?.errorMessage).toContain('missing-start-time=1')

    // The three good ones really did go through.
    expect(calls).toHaveLength(1)
    expect((calls[0]!['spans'] as unknown[])).toHaveLength(3)
  })

  it('one failing trace among several is a 200 partial, not a 5xx', async () => {
    const spans = makeSpans(['t1', 't2'], false)
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    const doomed = spans[1]!.spanContext().traceId
    failures.set(doomed, new Error('RUN_NOT_ACTIVE: run is no longer accepting events'))

    const res = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })

    expect(res.status).toBe(200)
    const partial = await partialSuccess(res)
    expect(partial?.rejectedSpans).toBe(1)
    expect(partial?.errorMessage).toContain('RUN_NOT_ACTIVE')
  })

  it('when NOTHING was written, a permanent backend failure is non-retryable', async () => {
    const spans = makeSpans(['only'])
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    failures.set(
      spans[0]!.spanContext().traceId,
      new Error('OTEL_TRACE_TOO_OLD: trace predates the stale-run ceiling'),
    )

    const res = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })
    expect(res.status).toBe(400)
    // A retryable status here would put the exporter in a permanent loop: the
    // trace's age never decreases.
    expect(res.headers.get('retry-after')).toBeNull()
  })

  it('maps BATCH_TOO_LARGE / PAYLOAD_TOO_LARGE to a non-retryable 413', async () => {
    for (const code of ['BATCH_TOO_LARGE', 'PAYLOAD_TOO_LARGE']) {
      const spans = makeSpans(['only'])
      const body = ProtobufTraceSerializer.serializeRequest(spans)!
      failures.set(spans[0]!.spanContext().traceId, new Error(`${code}: too big`))
      const res = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })
      expect(res.status).toBe(413)
      expect(res.headers.get('retry-after')).toBeNull()
    }
  })

  it('a backend TIMEOUT is retryable, with Retry-After', async () => {
    const spans = makeSpans(['only'])
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    failures.set(spans[0]!.spanContext().traceId, new FakeConvexTimeoutError())

    const res = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })
    // Genuinely transient — this is the one class the exporter SHOULD retry,
    // and the only reason its data is not lost.
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('60')
  })
})

// ---------------------------------------------------------------------------
// Wire-layer attacks. These need NO valid credential to attempt, which is why
// they are the ones most likely to be exercised in the wild.
// ---------------------------------------------------------------------------

describe('encoding confusion', () => {
  it('a PROTOBUF body sent with application/json is a clean 400, not a mis-parse', async () => {
    const res = await post(protoBody(['chat gpt-4o']) as unknown as string, {
      'content-type': 'application/json',
      ...AUTH_A,
    })
    // Rejected on the declared type, never sniffed. A receiver that guessed
    // from the leading byte would eventually mis-parse a protobuf body that
    // happens to start with 0x7b and report a decode error nobody can act on.
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('retry-after')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('a JSON body sent with application/x-protobuf is a clean 400 in PROTOBUF', async () => {
    const res = await post(jsonBody(['chat gpt-4o']), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })
    expect(res.status).toBe(400)
    // The error is answered in the encoding the CLIENT declared, even though
    // that declaration is what was wrong — a client that sent x-protobuf will
    // try to parse the reply as protobuf.
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect(calls).toHaveLength(0)
  })

  it('a gzip bomb is refused with 413 and never reaches the backend', async () => {
    const payload = new Uint8Array(64 * 1024 * 1024)
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(payload)
        c.close()
      },
    })
    const stream = src.pipeThrough(
      new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    )
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) chunks.push(value)
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const bomb = new Uint8Array(total)
    let o = 0
    for (const c of chunks) {
      bomb.set(c, o)
      o += c.byteLength
    }

    // Small on the wire — every Content-Length check in the world passes it.
    expect(bomb.byteLength).toBeLessThan(64 * 1024)

    const res = await post(bomb, {
      'content-type': 'application/x-protobuf',
      'content-encoding': 'gzip',
      ...AUTH_A,
    })
    expect(res.status).toBe(413)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('an unsupported Content-Encoding is 415, not a silent identity read', async () => {
    const res = await post(protoBody(['chat']), {
      'content-type': 'application/x-protobuf',
      'content-encoding': 'br',
      ...AUTH_A,
    })
    expect(res.status).toBe(415)
    expect(calls).toHaveLength(0)
  })
})

describe('the rejected_spans: 0 trap', () => {
  it('NEVER reports full success when the backend wrote nothing and rejected nothing', async () => {
    // Team D defects D3/D9: the mutation refuses a batch IN FULL on a single
    // oversized payload or inconsistent provenance, and `RejectedSpanReport`
    // has no reason member for either — so the refusal can come back as a
    // successful return with empty `eventIds` AND empty `rejected`.
    mutationMock.mockImplementationOnce((_ref, args) => {
      calls.push(args)
      return {
        runId: 'run_x',
        runCreated: false,
        eventIds: [],
        unmappedCount: 0,
        rejected: [],
        diagnostics: [],
        runOpen: true,
        terminalType: null,
        firstSequenceNumber: null,
        lastSequenceNumber: null,
        stats: {
          spansIn: 2, spansAccepted: 0, spansMapped: 0, spansUnmapped: 0,
          spansRejected: 0, eventsOut: 0, clockSkewClamps: 0,
        },
      }
    })

    const res = await post(protoBody(['invoke_agent a', 'chat gpt-4o']), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })

    // A 200 here is us promising, on our word, that discarded data is safe —
    // the exporter drops its buffer on that promise.
    expect(res.status).not.toBe(200)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('still reports full success when the backend really did write', async () => {
    const res = await post(protoBody(['invoke_agent a']), {
      'content-type': 'application/x-protobuf',
      ...AUTH_A,
    })
    expect(res.status).toBe(200)
    expect(await partialSuccess(res)).toBeNull()
  })
})

describe('resilience to an unrecognized backend throw', () => {
  it('a mapper RangeError becomes a retryable 503 with a real OTLP body', async () => {
    const spans = makeSpans(['only'])
    const body = ProtobufTraceSerializer.serializeRequest(spans)!
    // Team D: `compareDuplicateCandidates` raises an unguarded RangeError on a
    // deeply-nested attribute value attached to a duplicated span id,
    // reachable by any ingest-key holder.
    failures.set(spans[0]!.spanContext().traceId, new RangeError('Maximum call stack size exceeded'))

    const res = await post(body, { 'content-type': 'application/x-protobuf', ...AUTH_A })

    // NOT a bodyless 500 — the worst possible answer, since it is both
    // non-retryable and unparseable.
    expect(res.status).not.toBe(500)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    // The body really is a google.rpc.Status the exporter can decode.
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(0)
    const r = new ProtoReader(bytes)
    const tag = r.readTag()
    expect(tag.fieldNumber).toBe(1)
  })

  it('every failure path answers with a parseable body in the negotiated encoding', async () => {
    const cases: Array<[string, Record<string, string>, Uint8Array | string]> = [
      ['unauth', { 'content-type': 'application/x-protobuf' }, protoBody(['a'])],
      ['bad-agent', { 'content-type': 'application/x-protobuf', 'x-api-key': 'orgA-ingest' }, protoBody(['a'])],
      ['corrupt', { 'content-type': 'application/x-protobuf', ...AUTH_A }, protoBody(['a']).subarray(0, 6)],
      ['oversized', { 'content-type': 'application/x-protobuf', ...AUTH_A }, new Uint8Array(5 * 1024 * 1024)],
    ]
    for (const [label, headers, body] of cases) {
      const res = await post(body, headers)
      expect(res.status, label).toBeGreaterThanOrEqual(400)
      expect(res.headers.get('content-type'), label).toBe('application/x-protobuf')
      const bytes = new Uint8Array(await res.arrayBuffer())
      // Non-empty and decodable as a protobuf message.
      expect(bytes.byteLength, label).toBeGreaterThan(0)
      expect(() => {
        const r = new ProtoReader(bytes)
        while (!r.eof) r.skipField(r.readTag().wireType)
      }, label).not.toThrow()
    }
  })
})
