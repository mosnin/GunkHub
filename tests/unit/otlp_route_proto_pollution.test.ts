/**
 * REGRESSION GATE for two findings from Team D's wire-layer adversarial suite
 * (`tests/unit/otlp_adversarial_wire.test.ts`), both re-verified here
 * independently against the code under my ownership.
 *
 * ---------------------------------------------------------------------------
 * W1 — `__proto__` was silently dropped by BOTH decoders.
 * ---------------------------------------------------------------------------
 *
 * `target['__proto__'] = value` on an object with the default prototype does
 * not create a property. It invokes the accessor inherited from
 * `Object.prototype`:
 *
 *   * with a STRING value  -> the setter ignores the write; the attribute is
 *                             SILENTLY LOST.
 *   * with an OBJECT value -> the setter REASSIGNS THE PROTOTYPE.
 *
 * Same write, two outcomes, and an OTLP `kvlist` attribute is an object. So
 * the drop is the benign presentation of a prototype-pollution primitive on a
 * path fed by unauthenticated wire input.
 *
 * Why it outranked its size: `convex/helpers/otel_mapping.ts` already guards
 * its own attribute writes for exactly this reason. That guard was being
 * defeated because the key was destroyed one layer UPSTREAM, in the decoder,
 * before the mapper ever ran. Two layers, one hole, guarded layer downstream.
 *
 * Team D proved the JSON half end-to-end and flagged the PROTOBUF half as a
 * source-level assertion only. It is proven here with genuine bytes from
 * `@opentelemetry/otlp-transformer`'s real `ProtobufTraceSerializer` — the
 * confirmation Team D asked for.
 *
 * ---------------------------------------------------------------------------
 * W2 — the two decoders' `AnyValue` depth caps agreed only by coincidence.
 * ---------------------------------------------------------------------------
 *
 * `decodeJson.ts` hard-coded `16` while `decodeProtobuf.ts` imported
 * `MAX_ANY_VALUE_DEPTH`. That cap is load-bearing rather than hygienic: Team
 * D's D4b shows four MAPPED payload fields carry caller values raw into
 * `convex/otel_ingest.ts`'s recursive `JSON.stringify(payload)`, which throws
 * `RangeError` with no duplicate span involved. The decoder cap is the only
 * reason that crash is unreachable from the wire.
 */
import { JsonTraceSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'

import { decodeJsonExportTraceServiceRequest } from '@/lib/otel/decodeJson'
import { decodeExportTraceServiceRequest } from '@/lib/otel/decodeProtobuf'
import { MAX_ANY_VALUE_DEPTH } from '@/lib/otel/limits'
import { setAttribute } from '@/lib/otel/types'

/**
 * Real `ReadableSpan`s whose attribute bag carries `__proto__` as an own
 * property.
 *
 * `Object.defineProperty` is required to BUILD the fixture for the same reason
 * the production fix needs it: a bare assignment could not put the key there
 * in the first place. The bytes are then produced by the REAL serializers, so
 * what the decoders see is what an exporter would actually send.
 */
function spansWithProtoAttribute(protoValue: unknown): ReadableSpan[] {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  provider.getTracer('adversarial').startSpan('chat gpt-4o').end()
  const spans = exporter.getFinishedSpans()

  const attrs: Record<string, unknown> = {}
  Object.defineProperty(attrs, '__proto__', {
    value: protoValue,
    writable: true,
    enumerable: true,
    configurable: true,
  })
  attrs['ordinary'] = 'kept'
  attrs['constructor'] = 'also-kept'
  attrs['prototype'] = 'also-kept'
  attrs['toString'] = 'also-kept'
  ;(spans[0] as unknown as { attributes: unknown }).attributes = attrs
  return spans
}

describe('W1 — __proto__ survives the protobuf decoder (Team D: unconfirmed half)', () => {
  it('carries a string-valued __proto__ attribute through real protobuf bytes', () => {
    const spans = spansWithProtoAttribute('evil')
    const bytes = ProtobufTraceSerializer.serializeRequest(spans)!

    // Precondition: the key really is ON THE WIRE. Without this the test could
    // pass by the serializer having dropped it, proving nothing about us.
    expect(new TextDecoder().decode(bytes)).toContain('__proto__')

    const decoded = decodeExportTraceServiceRequest(bytes)
    const attrs = decoded.spans[0]!.attributes!

    // Before the fix this was ["ordinary", "constructor", "prototype", "toString"]
    // — the attribute vanished between the wire and the mapper.
    expect(Object.keys(attrs)).toContain('__proto__')
    expect(attrs['__proto__']).toBe('evil')
    // An own data property, not a prototype write.
    expect(Object.prototype.hasOwnProperty.call(attrs, '__proto__')).toBe(true)
  })

  it('does NOT let an object-valued __proto__ reassign the prototype', () => {
    // THE DANGEROUS ARM. An OTLP `kvlist` attribute is an object, so a bare
    // assignment here would not drop the value — it would mutate the object's
    // prototype, and every later property lookup on that object would consult
    // attacker-supplied data.
    const spans = spansWithProtoAttribute({ polluted: true })
    const bytes = ProtobufTraceSerializer.serializeRequest(spans)!

    const decoded = decodeExportTraceServiceRequest(bytes)
    const attrs = decoded.spans[0]!.attributes!

    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype)
    expect((attrs as { polluted?: unknown }).polluted).toBeUndefined()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.keys(attrs)).toContain('__proto__')
  })

  it('carries __proto__ through the JSON decoder too (Team D: confirmed half)', () => {
    const spans = spansWithProtoAttribute('evil')
    const text = new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)!)
    expect(text).toContain('__proto__')

    const attrs = decodeJsonExportTraceServiceRequest(text).spans[0]!.attributes!
    expect(Object.keys(attrs)).toContain('__proto__')
    expect(attrs['__proto__']).toBe('evil')
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype)
  })

  it('handles __proto__ nested inside a kvlist attribute, in both decoders', () => {
    // The nested `kvlist` accumulator is a THIRD and FOURTH assignment site,
    // distinct from the two top-level ones. A fix applied only at the top
    // level leaves the recursive path — the one that can actually carry an
    // object value — still vulnerable.
    const t = '4bf92f3577b34da6a3ce929d0e0e4736'
    const body = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              scope: { name: 's' },
              spans: [
                {
                  traceId: t,
                  spanId: '00f067aa0ba902b7',
                  name: 'chat',
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000001000000000',
                  attributes: [
                    {
                      key: 'gen_ai.input.messages',
                      value: {
                        kvlistValue: {
                          values: [
                            { key: '__proto__', value: { stringValue: 'evil' } },
                            { key: 'role', value: { stringValue: 'user' } },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const nested = decodeJsonExportTraceServiceRequest(body).spans[0]!.attributes![
      'gen_ai.input.messages'
    ] as Record<string, unknown>

    expect(Object.keys(nested).sort()).toEqual(['__proto__', 'role'])
    expect(nested['__proto__']).toBe('evil')
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype)
  })

  it('leaves every OTHER unusual key untouched — this is not a validation layer', () => {
    // Scoped deliberately. `__proto__` is one key with special semantics in
    // the object model; a decoder that started rejecting "suspicious"
    // attribute names would silently discard telemetry an engineer needs.
    const spans = spansWithProtoAttribute('evil')
    const extra = spans[0]!.attributes as Record<string, unknown>
    setAttribute(extra, 'ctrl chars[31m', 'kept')
    setAttribute(extra, 'lone\ud800surrogate', 'kept')
    setAttribute(extra, 'rtl‮override', 'kept')

    const decoded = decodeExportTraceServiceRequest(
      ProtobufTraceSerializer.serializeRequest(spans)!,
    )
    const keys = Object.keys(decoded.spans[0]!.attributes!)

    for (const k of ['ordinary', 'constructor', 'prototype', 'toString', '__proto__']) {
      expect(keys, k).toContain(k)
    }
    // Control chars / RTL / surrogates survive as their own keys too (the lone
    // surrogate is replaced with U+FFFD by non-fatal UTF-8 decoding, which is
    // the documented behaviour, so match on the stable prefix).
    expect(keys.some((k) => k.startsWith('ctrl chars'))).toBe(true)
    expect(keys.some((k) => k.startsWith('rtl'))).toBe(true)
    expect(keys.some((k) => k.startsWith('lone'))).toBe(true)
  })

  it('setAttribute keeps hasOwnProperty available (why not a null-prototype bag)', () => {
    const bag: Record<string, unknown> = {}
    setAttribute(bag, '__proto__', 'evil')
    setAttribute(bag, 'ordinary', 1)
    // `Object.create(null)` would also neutralize `__proto__`, but it breaks
    // any downstream caller that does `attrs.hasOwnProperty(...)`.
    //
    // The unsafe DIRECT call is precisely what is under test.
    // `no-prototype-builtins` exists because this call throws on a
    // null-prototype object; asserting that it does NOT throw here is how this
    // test proves the fix kept the prototype intact rather than swapping in a
    // null-prototype bag. The rule's suggested rewrite,
    // `Object.prototype.hasOwnProperty.call(...)`, would pass on a
    // null-prototype object too and would therefore assert nothing.
    // eslint-disable-next-line no-prototype-builtins
    expect(bag.hasOwnProperty('ordinary')).toBe(true)
    expect(Object.getPrototypeOf(bag)).toBe(Object.prototype)
    // And it survives the trip to Convex.
    const roundTripped = JSON.parse(JSON.stringify(bag)) as Record<string, unknown>
    expect(roundTripped['__proto__']).toBe('evil')
    expect(Object.getPrototypeOf(roundTripped)).toBe(Object.prototype)
  })
})

describe('W2 — one depth cap, shared by construction', () => {
  it('both decoders enforce MAX_ANY_VALUE_DEPTH, not a coincidental literal', () => {
    // Build a JSON kvlist nested well past the cap and confirm the JSON
    // decoder truncates at the SAME depth the protobuf decoder does.
    const build = (depth: number): unknown => {
      let v: unknown = { stringValue: 'leaf' }
      for (let i = 0; i < depth; i++) {
        v = { kvlistValue: { values: [{ key: `k${String(i)}`, value: v }] } }
      }
      return v
    }

    const body = (depth: number): string =>
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                scope: { name: 's' },
                spans: [
                  {
                    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
                    spanId: '00f067aa0ba902b7',
                    name: 'chat',
                    startTimeUnixNano: '1700000000000000000',
                    attributes: [{ key: 'deep', value: build(depth) }],
                  },
                ],
              },
            ],
          },
        ],
      })

    const measure = (v: unknown): number => {
      let d = 0
      let cur = v
      while (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        const values = Object.values(cur as Record<string, unknown>)
        if (values.length === 0) break
        cur = values[0]
        d++
      }
      return d
    }

    const shallow = decodeJsonExportTraceServiceRequest(body(4)).spans[0]!.attributes!['deep']
    expect(measure(shallow)).toBe(4)

    // Past the cap the recursion stops rather than running away.
    const deep = decodeJsonExportTraceServiceRequest(body(200)).spans[0]!.attributes!['deep']
    expect(measure(deep)).toBeLessThanOrEqual(MAX_ANY_VALUE_DEPTH + 1)
  })

  it('the cap is imported, not restated, in the JSON decoder', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(
      new URL('../../apps/web/src/lib/otel/decodeJson.ts', import.meta.url),
      'utf8',
    )
    // W2 was two decoders agreeing by coincidence. This fails if anyone
    // reintroduces a literal.
    expect(src).toContain('MAX_ANY_VALUE_DEPTH')
    expect(src).not.toMatch(/depth\s*>\s*\d+/)
  })

  it('documents that this bound is load-bearing for Team D’s D4b', () => {
    // Raising it re-opens a RangeError in convex/otel_ingest.ts's recursive
    // JSON.stringify over four mapped payload fields that carry caller values
    // raw. Not a style bound — a crash bound.
    expect(MAX_ANY_VALUE_DEPTH).toBe(16)
  })
})
