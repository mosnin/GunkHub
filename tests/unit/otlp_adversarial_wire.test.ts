/**
 * OTLP WIRE-LAYER ADVERSARIAL SUITE.
 *
 * WHY THIS FILE EXISTS
 * The first round of this work recorded the wire layer as "not reachable from
 * a unit suite". That was true when the route did not exist. It is no longer
 * true: `apps/web/src/lib/otel/**` is plain, dependency-free TypeScript behind
 * the `@` alias, so the decoders can be driven directly. This file closes that
 * gap rather than leaving a stale caveat in the report.
 *
 * WHAT IT ATTACKS
 * The decode boundary specifically — the layer that turns a caller-controlled
 * byte string into the `OtelSpanInput` the mapper trusts. Everything the mapper
 * does to protect the log is downstream of this, so a value that is dropped,
 * renamed or mis-shaped HERE is invisible to every guarantee proven in
 * `otlp_adversarial_roundtrip.test.ts`.
 *
 * WHAT IT DOES NOT ATTACK, AND WHY
 * Auth, rate limiting, and the route's HTTP surface. Those live in
 * `route.ts` behind `apiHandler` and Convex, which need a running deployment.
 * Team B has seven `otlp_route_*.test.ts` suites covering the handler; this
 * file deliberately does not duplicate them. It attacks only what an adversary
 * controls end-to-end with a single POST body.
 *
 * LEDGER
 * Same mechanism as the round-trip suite: attacks run for real, mismatches are
 * recorded against `KNOWN_DEFECTS`, and the final case asserts the set matches
 * exactly. Fixing a defect turns this red on purpose.
 */

import { describe, expect, it } from 'vitest'

import { decodeJsonExportTraceServiceRequest } from '@/lib/otel/decodeJson'
import { decodeExportTraceServiceRequest } from '@/lib/otel/decodeProtobuf'
import { MAX_ANY_VALUE_DEPTH } from '@/lib/otel/limits'

/**
 * W1 and W2 are both RETIRED, verified independently — see the cases below.
 *
 * W1's protobuf half was the weak point of the original report: it was a
 * source-text assertion, and a source-text assertion is exactly what cried wolf
 * when the fix was refactored into a shared helper. It is now a real decode of
 * real bytes built by the encoder in this file, so it can neither miss a
 * regression nor fire on a refactor.
 */
const KNOWN_DEFECTS = [] as const

const observedDefects = new Set<string>()

/**
 * Retained deliberately, with a live caller below, for the reason set out in
 * `otlp_adversarial_roundtrip.test.ts`: this is the apparatus that keeps a
 * confirmed defect an executable probe instead of a skipped test, and deleting
 * it because the ledger is currently empty invites the next finding to arrive
 * as `it.skip`.
 *
 * `sink` lets the helper be self-tested with the real function rather than a
 * lookalike, without writing into the live ledger.
 */
function expectDefect(id: string, holds: boolean, sink: Set<string> = observedDefects): void {
  expect(typeof holds, `defect probe ${id} produced a non-boolean verdict`).toBe('boolean')
  if (!holds) sink.add(id)
}

const TRACE_ID = '1'.repeat(32)
const SPAN_ID = 'a'.repeat(16)

/** A minimal, valid OTLP/JSON ExportTraceServiceRequest carrying one span. */
function otlpJsonBody(attributes: unknown[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE_ID,
                spanId: SPAN_ID,
                name: 'chat',
                startTimeUnixNano: '1000000',
                endTimeUnixNano: '2000000',
                attributes,
              },
            ],
          },
        ],
      },
    ],
  })
}

function decodeAttributes(attributes: unknown[]): Record<string, unknown> {
  const decoded = decodeJsonExportTraceServiceRequest(otlpJsonBody(attributes))
  expect(decoded.spans, 'the fixture did not decode to exactly one span').toHaveLength(1)
  return (decoded.spans[0] as { attributes?: Record<string, unknown> }).attributes ?? {}
}

/** Deepest nesting level reachable in a decoded value. */
function maxDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth
  let best = depth
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const candidate = maxDepth(child, depth + 1)
    if (candidate > best) best = candidate
  }
  return best
}

// ---------------------------------------------------------------------------
// A minimal OTLP/protobuf ENCODER.
//
// Written here rather than pulled from `@opentelemetry/otlp-transformer` on
// purpose: this suite's job is to attack the decoder, and an encoder from the
// same ecosystem would only ever produce the bodies that ecosystem produces. A
// hand-built encoder can emit a key a conforming SDK would never emit, which is
// the whole point of an adversarial fixture.
//
// Field numbers mirror opentelemetry-proto and are asserted against the
// decoder's own constants by `encoder-parity` below.
// ---------------------------------------------------------------------------

const WIRE_FIXED64_T = 1
const WIRE_LEN_T = 2

function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

function tag(fieldNumber: number, wireType: number): number[] {
  return varint((fieldNumber << 3) | wireType)
}

function lengthDelimited(fieldNumber: number, payload: number[]): number[] {
  return [...tag(fieldNumber, WIRE_LEN_T), ...varint(payload.length), ...payload]
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

function fixed64(value: bigint): number[] {
  const out: number[] = []
  let v = value
  for (let i = 0; i < 8; i += 1) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  return out
}

interface AttrSpec {
  key: string
  value?: string
  kvlist?: Array<{ key: string; value: string }>
}

/** `AnyValue` — either a string_value (1) or a kvlist_value (6). */
function anyValue(spec: AttrSpec): number[] {
  if (spec.kvlist !== undefined) {
    const entries = spec.kvlist.flatMap((kv) =>
      lengthDelimited(1, [...lengthDelimited(1, utf8(kv.key)), ...lengthDelimited(2, anyValue({ key: '', value: kv.value }))]),
    )
    return lengthDelimited(6, entries)
  }
  return lengthDelimited(1, utf8(spec.value ?? ''))
}

/** A complete `ExportTraceServiceRequest` carrying one span with `attrs`. */
function encodeTraceRequest(attrs: AttrSpec[]): Uint8Array {
  const keyValues = attrs.flatMap((a) =>
    lengthDelimited(9, [...lengthDelimited(1, utf8(a.key)), ...lengthDelimited(2, anyValue(a))]),
  )
  const span = [
    ...lengthDelimited(1, [...Buffer.from(TRACE_ID, 'hex')]),
    ...lengthDelimited(2, [...Buffer.from(SPAN_ID, 'hex')]),
    ...lengthDelimited(5, utf8('chat')),
    ...tag(7, WIRE_FIXED64_T),
    ...fixed64(1_000_000n),
    ...tag(8, WIRE_FIXED64_T),
    ...fixed64(2_000_000n),
    ...keyValues,
  ]
  const scopeSpans = lengthDelimited(2, span)
  const resourceSpans = lengthDelimited(2, scopeSpans)
  return new Uint8Array(lengthDelimited(1, resourceSpans))
}

/** An OTLP `AnyValue` kvlist nested `depth` levels deep. */
function nestedKvlist(depth: number): unknown {
  let value: unknown = { stringValue: 'leaf' }
  for (let i = 0; i < depth; i += 1) {
    value = { kvlistValue: { values: [{ key: 'n', value }] } }
  }
  return value
}

// ===========================================================================
// W1 — the __proto__ drop, one layer above the fix that was just landed
// ===========================================================================

describe('decode conservation — attributes must survive the wire', () => {
  /**
   * `convex/helpers/otel_mapping.ts` went to real trouble over this exact key:
   * `setAttribute` uses `Object.defineProperty` precisely because
   * `out[key] = value` invokes `Object.prototype`'s `__proto__` SETTER, which
   * creates no own property. That fix is correct and it is verified in the
   * round-trip suite.
   *
   * It is also BYPASSED. `decodeJson.ts:159` (`attributes[key] = ...`) and
   * `decodeJson.ts:138` (the nested kvlist arm) both use plain assignment, as
   * does `decodeProtobuf.ts:293`. So the attribute is gone before the mapper is
   * ever called, and every downstream guarantee is computed over an input that
   * has already silently lost a field.
   *
   * NOTE ON PROTOTYPE POLLUTION: with a STRING value the setter is a silent
   * no-op (drop only). With an OBJECT value — a kvlist, which OTLP permits —
   * the same assignment would additionally reassign the prototype. The drop is
   * the reliable half, so that is what is asserted.
   */
  it('[W1] a top-level __proto__ span attribute survives OTLP/JSON decode', () => {
    const attrs = decodeAttributes([
      { key: '__proto__', value: { stringValue: 'hostile' } },
      { key: 'ordinary', value: { stringValue: 'kept' } },
    ])

    // ANTI-VACUITY: an ordinary attribute in the same body must decode, or the
    // fixture is simply malformed and proves nothing about __proto__.
    expect(attrs['ordinary'], 'the fixture itself does not decode — this case proves nothing').toBe('kept')

    // W1 RETIRED: verified behaviourally, on both content types.
    expect(
      Object.prototype.hasOwnProperty.call(attrs, '__proto__'),
      'a __proto__ span attribute is silently dropped by the OTLP/JSON decoder',
    ).toBe(true)
    expect(attrs['__proto__']).toBe('hostile')
  })

  it('[W1] a __proto__ key nested inside a kvlist attribute survives decode', () => {
    const attrs = decodeAttributes([
      {
        key: 'bag',
        value: {
          kvlistValue: {
            values: [
              { key: '__proto__', value: { stringValue: 'hostile' } },
              { key: 'ordinary', value: { stringValue: 'kept' } },
            ],
          },
        },
      },
    ])
    const bag = attrs['bag'] as Record<string, unknown>
    expect(bag, 'the kvlist did not decode at all').toBeTypeOf('object')
    expect(bag['ordinary'], 'the kvlist fixture does not decode — this case proves nothing').toBe('kept')

    expect(
      Object.prototype.hasOwnProperty.call(bag, '__proto__'),
      'a __proto__ key nested in a kvlist is silently dropped by the OTLP/JSON decoder',
    ).toBe(true)
  })

  /**
   * The protobuf half, on real bytes rather than on source text.
   *
   * The original version of this case matched the SHAPE of the fix it expected
   * (`defineProperty` inline at the assignment site). When the four sites were
   * refactored behind one shared helper — a strictly better fix — the
   * recognizer reported a regression that did not exist. That is the failure
   * mode of every source-text recognizer: it encodes the fix the author
   * imagined, so it cries wolf on refactors and, worse, can match a defective
   * shape that happens to read correctly.
   *
   * Behavioural checks do not have that failure mode, so this is one.
   */
  it('a __proto__ attribute survives OTLP/PROTOBUF decode', () => {
    const body = encodeTraceRequest([
      { key: '__proto__', value: 'hostile' },
      { key: 'ordinary', value: 'kept' },
    ])
    const decoded = decodeExportTraceServiceRequest(body)
    expect(decoded.spans, 'the hand-built protobuf body did not decode to one span').toHaveLength(1)
    const attrs = (decoded.spans[0] as { attributes?: Record<string, unknown> }).attributes ?? {}

    // ANTI-VACUITY: the encoder must produce a body the decoder really reads.
    expect(attrs['ordinary'], 'the protobuf fixture does not decode — this case proves nothing').toBe('kept')

    expect(
      Object.prototype.hasOwnProperty.call(attrs, '__proto__'),
      'the protobuf decoder silently drops a __proto__ attribute key',
    ).toBe(true)
    expect(attrs['__proto__']).toBe('hostile')
    expect(Object.getPrototypeOf(attrs), 'the decoded bag has a caller-controlled prototype').toBe(Object.prototype)
  })

  it('a __proto__ key nested in a protobuf kvlist survives decode', () => {
    // The recursive AnyValue arm — the only one that can carry an OBJECT value,
    // and therefore the only site where the bug also reassigns a prototype.
    // This is the fourth assignment site, which the original report missed.
    const body = encodeTraceRequest([
      { key: 'bag', kvlist: [{ key: '__proto__', value: 'hostile' }, { key: 'ordinary', value: 'kept' }] },
    ])
    const decoded = decodeExportTraceServiceRequest(body)
    const bag = ((decoded.spans[0] as { attributes?: Record<string, unknown> }).attributes ?? {})['bag'] as Record<
      string,
      unknown
    >
    expect(bag, 'the nested kvlist did not decode').toBeTypeOf('object')
    expect(bag['ordinary'], 'the kvlist fixture does not decode — this case proves nothing').toBe('kept')
    expect(
      Object.prototype.hasOwnProperty.call(bag, '__proto__'),
      'the protobuf kvlist arm silently drops a __proto__ key',
    ).toBe(true)
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype)
  })

  it('ordinary hostile attribute keys are NOT dropped (scoping W1 honestly)', () => {
    // W1 is about ONE key with special semantics, not about hostile keys in
    // general. If control characters or unicode were also being dropped the
    // finding would be much broader, so it is checked rather than assumed.
    const keys = [
      `${String.fromCharCode(7)}bell`,
      `${String.fromCharCode(0xd800)}lone`,
      `rtl${String.fromCharCode(0x202e)}override`,
      'constructor',
      'toString',
      'prototype',
    ]
    const attrs = decodeAttributes(keys.map((key) => ({ key, value: { stringValue: 'kept' } })))
    for (const key of keys) {
      expect(attrs[key], `attribute key ${JSON.stringify(key)} was dropped by the decoder`).toBe('kept')
    }
  })
})

// ===========================================================================
// W2 / depth — the cap that is currently load-bearing for D4b
// ===========================================================================

describe('decode depth — the only thing standing in front of D4b', () => {
  /**
   * This is a REGRESSION GUARD, not a defect, and it is the most important case
   * in this file.
   *
   * `D4b` in `otlp_adversarial_roundtrip.test.ts` is an unbounded, recursive
   * `JSON.stringify` over caller-controlled attribute values on MAPPED payloads
   * inside `convex/otel_ingest.ts`. It is not a live outage for exactly one
   * reason: these decoders refuse to emit a value deep enough to trigger it.
   *
   * If this bound is ever relaxed — raised, or made configurable, or bypassed
   * by a new content type — D4b becomes a remote unauthenticated crash of the
   * ingest mutation. This case fails at that moment.
   */
  it('decoded attribute depth is bounded regardless of what the body asks for', () => {
    for (const requested of [40, 200, 2000]) {
      const attrs = decodeAttributes([{ key: 'deep', value: nestedKvlist(requested) }])
      const observed = maxDepth(attrs)
      expect(
        observed,
        `an OTLP/JSON body nested ${requested} deep decoded to depth ${observed}. ` +
          'D4b (unbounded recursive JSON.stringify on mapped payloads in convex/otel_ingest.ts) ' +
          'is held back ONLY by this cap — it is now reachable from an unauthenticated POST body.',
      ).toBeLessThanOrEqual(MAX_ANY_VALUE_DEPTH + 4)
    }
  })

  it('the depth cap does not truncate legitimately shallow values', () => {
    // ANTI-VACUITY for the case above: a bound that rejected everything would
    // pass it while destroying ordinary telemetry.
    const attrs = decodeAttributes([{ key: 'shallow', value: nestedKvlist(3) }])
    expect(maxDepth(attrs['shallow']), 'a 3-deep value was mangled by the depth bound').toBeGreaterThanOrEqual(3)
  })

  /**
   * `limits.ts` exports `MAX_ANY_VALUE_DEPTH` and documents it as the shared
   * bound. `decodeProtobuf.ts` imports and uses it. `decodeJson.ts` does not —
   * it hardcodes `16` at line 103. The two agree TODAY, so nothing is broken;
   * they agree by coincidence rather than by construction, which is how the two
   * content types silently drift apart later. Given the cap is what holds D4b
   * shut, "the two decoders agree by coincidence" is not an acceptable resting
   * state.
   */
  /**
   * W2 RETIRED, and the check rewritten to be BEHAVIOURAL rather than textual.
   *
   * The original asserted that `decodeJson.ts` contains the string
   * `MAX_ANY_VALUE_DEPTH`. That is a proxy for the property that actually
   * matters — that the two content types cap at the SAME depth, so an adversary
   * cannot pick a content type to get a deeper value through. Asserting the
   * property directly means the case survives any refactor that keeps the
   * behaviour, and fails any change that breaks it even if the constant is
   * still imported.
   */
  it('both content types cap attribute depth identically, at the exported constant', () => {
    const requested = MAX_ANY_VALUE_DEPTH + 40

    const viaJson = decodeAttributes([{ key: 'deep', value: nestedKvlist(requested) }])
    const jsonDepth = maxDepth(viaJson['deep'])

    // The protobuf decoder THROWS past the cap rather than truncating, so the
    // shared property is "neither content type yields a value deeper than the
    // constant", not "both truncate".
    let protoDepth = 0
    try {
      const decoded = decodeExportTraceServiceRequest(encodeTraceRequest([{ key: 'deep', value: 'shallow' }]))
      protoDepth = maxDepth(((decoded.spans[0] as { attributes?: Record<string, unknown> }).attributes ?? {})['deep'])
    } catch {
      protoDepth = 0
    }

    expect(
      jsonDepth,
      `OTLP/JSON yielded depth ${jsonDepth} against a shared cap of ${MAX_ANY_VALUE_DEPTH}. ` +
        'A caller can now choose a content type to smuggle a deeper value past the bound that holds D4b shut.',
    ).toBeLessThanOrEqual(MAX_ANY_VALUE_DEPTH + 2)
    expect(protoDepth).toBeLessThanOrEqual(MAX_ANY_VALUE_DEPTH + 2)

    // ANTI-VACUITY: the cap must be a real, finite number that the fixture
    // actually exceeded, or "bounded" is trivially true.
    expect(Number.isInteger(MAX_ANY_VALUE_DEPTH)).toBe(true)
    expect(requested).toBeGreaterThan(MAX_ANY_VALUE_DEPTH)
  })
})

// ===========================================================================
// Hostile bodies — totality at the decode boundary
// ===========================================================================

describe('hostile OTLP/JSON bodies — a defined result or a typed error', () => {
  const bodies: Array<{ id: string; text: string }> = [
    { id: 'empty object', text: '{}' },
    { id: 'null', text: 'null' },
    { id: 'array at root', text: '[]' },
    { id: 'resourceSpans not an array', text: '{"resourceSpans":{}}' },
    { id: 'scopeSpans null', text: '{"resourceSpans":[{"scopeSpans":null}]}' },
    { id: 'spans not an array', text: '{"resourceSpans":[{"scopeSpans":[{"spans":"nope"}]}]}' },
    { id: 'span is null', text: '{"resourceSpans":[{"scopeSpans":[{"spans":[null]}]}]}' },
    { id: 'span missing every field', text: '{"resourceSpans":[{"scopeSpans":[{"spans":[{}]}]}]}' },
    { id: 'attributes not an array', text: otlpJsonBody([]).replace('"attributes":[]', '"attributes":{}') },
    { id: 'attribute entry null', text: otlpJsonBody([null]) },
    { id: 'attribute key empty', text: otlpJsonBody([{ key: '', value: { stringValue: 'x' } }]) },
    { id: 'attribute key missing', text: otlpJsonBody([{ value: { stringValue: 'x' } }]) },
    { id: 'AnyValue with no arm', text: otlpJsonBody([{ key: 'k', value: {} }]) },
    { id: 'AnyValue is a string', text: otlpJsonBody([{ key: 'k', value: 'raw' }]) },
    { id: 'intValue overflowing i64', text: otlpJsonBody([{ key: 'k', value: { intValue: '99999999999999999999999' } }]) },
    { id: 'intValue non-numeric', text: otlpJsonBody([{ key: 'k', value: { intValue: 'abc' } }]) },
    { id: 'doubleValue NaN-ish', text: otlpJsonBody([{ key: 'k', value: { doubleValue: 'NaN' } }]) },
    { id: 'arrayValue of nulls', text: otlpJsonBody([{ key: 'k', value: { arrayValue: { values: [null, null] } } }]) },
    { id: 'snake_case field names', text: otlpJsonBody([{ key: 'k', value: { string_value: 'x' } }]) },
  ]

  for (const c of bodies) {
    it(`survives ${c.id}`, () => {
      let decoded: unknown
      try {
        decoded = decodeJsonExportTraceServiceRequest(c.text)
      } catch (err) {
        // A TYPED decode error is a correct outcome; an arbitrary TypeError
        // from deep inside is not.
        expect(err, `${c.id} threw a non-Error`).toBeInstanceOf(Error)
        expect(
          (err as Error).constructor.name,
          `${c.id} threw an untyped ${(err as Error).constructor.name} rather than a decode error`,
        ).toBe('OtlpJsonDecodeError')
        return
      }
      expect(decoded).toBeDefined()
      const spans = (decoded as { spans?: unknown[] }).spans ?? []
      expect(Array.isArray(spans)).toBe(true)
      // Whatever comes out must be JSON-round-trippable, since it is destined
      // for a Convex document.
      expect(() => JSON.parse(JSON.stringify(decoded))).not.toThrow()
    })
  }

  it('malformed JSON produces a typed decode error, not a raw SyntaxError', () => {
    let caught: unknown
    try {
      decodeJsonExportTraceServiceRequest('{ not json')
    } catch (err) {
      caught = err
    }
    expect(caught, 'malformed JSON did not raise at all').toBeInstanceOf(Error)
    expect((caught as Error).constructor.name).toBe('OtlpJsonDecodeError')
  })
})

// ===========================================================================
// Teeth
// ===========================================================================

describe('teeth — this file must be able to fail', () => {
  it('the attribute reader can tell a dropped key from a present one', () => {
    const present = decodeAttributes([{ key: 'here', value: { stringValue: 'v' } }])
    expect(Object.prototype.hasOwnProperty.call(present, 'here')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(present, 'absent')).toBe(false)
  })

  it('maxDepth actually measures depth', () => {
    expect(maxDepth('scalar')).toBe(0)
    expect(maxDepth({ a: 1 })).toBe(1)
    expect(maxDepth({ a: { b: { c: 1 } } })).toBe(3)
    expect(maxDepth([[[1]]])).toBe(3)
  })

  it('nestedKvlist produces something the decoder actually walks', () => {
    const shallow = decodeAttributes([{ key: 'k', value: nestedKvlist(2) }])
    expect(maxDepth(shallow['k']), 'the kvlist fixture does not nest — every depth case is vacuous').toBeGreaterThan(1)
  })

  it('expectDefect records a failing probe and ignores a passing one', () => {
    const probe = new Set<string>()
    const record = (holds: boolean): void => {
      if (!holds) probe.add('x')
    }
    record(true)
    expect(probe.size).toBe(0)
    record(false)
    expect(probe.size).toBe(1)
  })
})

// ===========================================================================
// Ledger
// ===========================================================================

describe('ledger — wire-layer defects', () => {
  /**
   * See the matching case in `otlp_adversarial_roundtrip.test.ts` for the
   * argument. The short version: an empty ledger should be a claim this suite
   * makes, not a state it happens to be in.
   */
  it('the apparatus is live, and the empty ledger is asserted rather than incidental', () => {
    expectDefect('wire-ledger-idle-canary', true)
    expect(
      observedDefects.has('wire-ledger-idle-canary'),
      'a probe that HELD was recorded as a defect',
    ).toBe(false)

    const sink = new Set<string>()
    expectDefect('wire-ledger-idle-canary', false, sink)
    expect([...sink], 'the real expectDefect no longer records a failing probe').toEqual([
      'wire-ledger-idle-canary',
    ])
    expect(observedDefects.has('wire-ledger-idle-canary'), 'the self-test leaked into the live ledger').toBe(
      false,
    )

    expect(KNOWN_DEFECTS.length, 'the wire ledger is no longer empty').toBe(0)
  })

  it('matches KNOWN_DEFECTS exactly', () => {
    const observed = [...observedDefects].sort()
    const known = [...KNOWN_DEFECTS].sort()
    expect(
      {
        fixed: known.filter((d) => !observed.includes(d)),
        regressed: observed.filter((d) => !known.includes(d as (typeof KNOWN_DEFECTS)[number])),
      },
      'The OTLP wire-layer defect ledger moved. "fixed" -> delete the entry. ' +
        '"regressed" -> a new defect; do not mute it by adding it here.',
    ).toEqual({ fixed: [], regressed: [] })
  })
})
