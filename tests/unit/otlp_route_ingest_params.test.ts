/**
 * FORWARDING GATE for `ingestOtelSpans`
 * (apps/web/src/lib/services/otel_ingest.ts).
 *
 * Same shape, and the same reason, as
 * `tests/unit/api_v1_failure_patterns_params.test.ts`: the args cross a
 * hand-maintained `makeFunctionReference` string ref
 * (apps/web/src/lib/convexFunctions.ts), so there is NO structural type check
 * between this forwarder and the real Convex handler's `args` validator. An
 * object spread that silently omits a declared param is not a type error. That
 * seam has shipped seven runtime bugs.
 *
 * This file is table-driven over EVERY key of `OtelIngestSpansParams`, so a
 * param added to the interface but not to the forwarding literal (or vice
 * versa) breaks a test instead of silently sending an OTLP batch to the
 * backend with a field missing — which on this path does not throw, it just
 * ingests into the wrong place or loses the trace's tail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mutationMock } = vi.hoisted(() => ({
  mutationMock: vi.fn<[unknown, Record<string, unknown>], unknown>(),
}))

vi.mock('@/lib/convexServer', () => ({
  getPublicClient: () => ({ mutation: mutationMock }),
  withConvexTimeout: async (p: unknown) => p,
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: { otel_ingest: { otelIngestSpans: 'otel_ingest:otelIngestSpans' } },
}))

import type { NormalizedSpan } from '@/lib/otel/types'

import { ingestOtelSpans, type OtelIngestSpansParams } from '@/lib/services/otel_ingest'

const SPAN: NormalizedSpan = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  name: 'chat gpt-4o',
  startTimeUnixNano: '1700000000000000000',
}

const FULL_PARAMS: Required<OtelIngestSpansParams> = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  agentId: 'agent_abc',
  agentVersion: 'v3',
  spans: [SPAN],
}

/**
 * Every param the interface declares, with a representative value and whether
 * the mutation treats it as required.
 *
 * `Record<keyof OtelIngestSpansParams, ...>` is the load-bearing part: adding
 * a field to the interface without adding it here is a COMPILE error, and
 * adding it here without forwarding it is a test failure.
 */
const PARAM_TABLE: Record<
  keyof OtelIngestSpansParams,
  { value: unknown; required: boolean }
> = {
  traceId: { value: '4bf92f3577b34da6a3ce929d0e0e4736', required: true },
  agentId: { value: 'agent_abc', required: true },
  agentVersion: { value: 'v3', required: false },
  spans: { value: [SPAN], required: true },
}

beforeEach(() => {
  mutationMock.mockReset()
  mutationMock.mockReturnValue({
    runId: 'run_1',
    runCreated: true,
    eventIds: ['evt_1'],
    unmappedCount: 0,
    rejected: [],
    diagnostics: [],
    runOpen: true,
    terminalType: null,
    firstSequenceNumber: 1,
    lastSequenceNumber: 1,
    stats: {
      spansIn: 1, spansAccepted: 1, spansMapped: 1, spansUnmapped: 0,
      spansRejected: 0, eventsOut: 1, clockSkewClamps: 0,
    },
  })
})

describe('ingestOtelSpans forwards every declared param', () => {
  it.each(Object.entries(PARAM_TABLE))('forwards %s', async (name, { value }) => {
    await ingestOtelSpans('hash_1', FULL_PARAMS)
    const args = mutationMock.mock.calls[0]![1]
    expect(args[name]).toEqual(value)
  })

  it('forwards the api key hash under the name Convex validates', async () => {
    await ingestOtelSpans('hash_1', FULL_PARAMS)
    // `apiKeyHash` is not part of `OtelIngestSpansParams` (it is a separate
    // positional argument, matching services/api_v1.ts), so the table above
    // cannot cover it and it needs its own assertion.
    expect(mutationMock.mock.calls[0]![1]['apiKeyHash']).toBe('hash_1')
  })

  it('sends NOTHING beyond the declared params', async () => {
    await ingestOtelSpans('hash_1', FULL_PARAMS)
    const sent = Object.keys(mutationMock.mock.calls[0]![1]).sort()
    // A stray key is rejected outright by the Convex args validator at
    // runtime, with an error that names the validator rather than this
    // forwarder. Catching it here names the right file.
    expect(sent).toEqual(['agentId', 'agentVersion', 'apiKeyHash', 'spans', 'traceId'].sort())
  })

  it('OMITS optional params rather than sending them as undefined', async () => {
    const { agentVersion: _drop, ...withoutOptional } = FULL_PARAMS
    await ingestOtelSpans('hash_1', withoutOptional)
    const args = mutationMock.mock.calls[0]![1]
    // Convex's `v.optional(...)` rejects an EXPLICIT `undefined` — it is not
    // the same as an absent key. The `...(x !== undefined && { x })` idiom is
    // what keeps these apart, and it is easy to lose in a refactor.
    expect('agentVersion' in args).toBe(false)
  })

  it('sends every required param unconditionally', async () => {
    const args = await ingestOtelSpans('hash_1', FULL_PARAMS).then(
      () => mutationMock.mock.calls[0]![1],
    )
    for (const [name, { required }] of Object.entries(PARAM_TABLE)) {
      if (required) expect(args[name], name).toBeDefined()
    }
  })

  it('does NOT invent a receivedAt', async () => {
    await ingestOtelSpans('hash_1', FULL_PARAMS)
    // The mutation takes the ingest clock itself. A web-layer clock forwarded
    // here would let a differently-skewed machine's `Date.now()` masquerade as
    // the backend's own observation, in the one field
    // (`provenance.receivedAt`) that exists specifically to make skew visible.
    expect(mutationMock.mock.calls[0]![1]).not.toHaveProperty('receivedAt')
  })

  it('passes the span objects through byte-identically', async () => {
    await ingestOtelSpans('hash_1', FULL_PARAMS)
    // The route decodes; the mutation maps. Nothing in between may reshape a
    // span — a dropped field here is a field the mapper reads as absent and
    // records as a loss reason on an append-only event.
    expect(mutationMock.mock.calls[0]![1]['spans']).toEqual([SPAN])
  })
})

describe('the ref itself', () => {
  it('is used directly, so scripts/check-convex-refs.ts can arg-check it', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../apps/web/src/lib/services/otel_ingest.ts', import.meta.url),
      'utf8',
    )
    // Optional chaining or a variable indirection here makes the call site
    // UNRESOLVABLE to the ref checker, which turns the seam that has already
    // shipped seven runtime bugs back into an unchecked one.
    expect(src).toContain('client.mutation(convex.otel_ingest.otelIngestSpans, {')

    // CODE lines only. The module's header comment explains why the optional
    // chain was removed and therefore contains the very string being banned —
    // a whole-file `not.toContain` would fail on its own documentation.
    const codeLines = src
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
    expect(codeLines.filter((l) => l.includes('convex.otel_ingest?.'))).toEqual([])
  })
})
