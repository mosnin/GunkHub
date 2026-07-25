/**
 * OTLP/JSON decoding (apps/web/src/lib/otel/decodeJson.ts).
 *
 * The fixtures here are produced by the REAL `JsonTraceSerializer` from
 * `@opentelemetry/otlp-transformer` wherever a full request is needed, for the
 * same reason the protobuf suite uses the real protobuf serializer: OTLP/JSON
 * deviates from proto3 JSON in two places (hex ids instead of base64;
 * uint64 as a string), and a self-written fixture would encode the author's
 * belief about those deviations rather than the wire reality.
 *
 * Hand-written JSON appears only where the point is to feed something the real
 * serializer will never emit — snake_case field names, a numeric timestamp, a
 * malformed id.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'

import {
  decodeJsonExportTraceServiceRequest,
  OtlpJsonDecodeError,
} from '@/lib/otel/decodeJson'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_ID = '00f067aa0ba902b7'
const PARENT_ID = '00f067aa0ba902b8'

function realJsonBody(): string {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const tracer = provider.getTracer('openinference.instrumentation.openai', '0.1.0')
  const s = tracer.startSpan('chat gpt-4o', {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.request.temperature': 0.7,
      'gen_ai.response.finish_reasons': ['stop'],
    },
  })
  s.setStatus({ code: SpanStatusCode.ERROR, message: 'context length exceeded' })
  s.end()
  const bytes = JsonTraceSerializer.serializeRequest(exporter.getFinishedSpans())
  return new TextDecoder().decode(bytes!)
}

describe('OTLP/JSON decode — against the real JSON serializer', () => {
  it('round-trips a span produced by the real OTel SDK', () => {
    const decoded = decodeJsonExportTraceServiceRequest(realJsonBody())

    expect(decoded.rejected).toEqual([])
    expect(decoded.spans).toHaveLength(1)
    const span = decoded.spans[0]!

    expect(span.name).toBe('chat gpt-4o')
    expect(span.kind).toBe('client')
    // HEX, lowercase — this is OTLP/JSON's documented deviation from proto3
    // JSON, and a decoder that base64-decoded here would produce ids that fail
    // `isProvenanceConsistent` at the write boundary.
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    // Nanosecond timestamps survive as exact decimal STRINGS.
    expect(span.startTimeUnixNano).toMatch(/^\d+$/)
    expect(span.endTimeUnixNano).toMatch(/^\d+$/)
    expect(span.attributes?.['gen_ai.request.model']).toBe('gpt-4o')
    expect(span.attributes?.['gen_ai.usage.input_tokens']).toBe(1200)
    expect(span.attributes?.['gen_ai.request.temperature']).toBeCloseTo(0.7, 10)
    expect(span.attributes?.['gen_ai.response.finish_reasons']).toEqual(['stop'])
    expect(span.status?.code).toBe(2)
    expect(span.status?.message).toBe('context length exceeded')
    expect(span.scopeName).toBe('openinference.instrumentation.openai')
  })

  it('produces the SAME normalized span from JSON and protobuf', async () => {
    // The two decoders are separate code; nothing but a test keeps them
    // agreeing. If they diverge, the same exporter switching from the default
    // protobuf to JSON silently changes what gets recorded.
    const { ProtobufTraceSerializer } = await import('@opentelemetry/otlp-transformer')
    const { decodeExportTraceServiceRequest } = await import('@/lib/otel/decodeProtobuf')

    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    const tracer = provider.getTracer('scope-x', '1.0.0')
    const s = tracer.startSpan('execute_tool search_web', {
      kind: SpanKind.INTERNAL,
      attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_web' },
    })
    s.end()
    const finished = exporter.getFinishedSpans()

    const fromJson = decodeJsonExportTraceServiceRequest(
      new TextDecoder().decode(JsonTraceSerializer.serializeRequest(finished)!),
    )
    const fromProto = decodeExportTraceServiceRequest(
      ProtobufTraceSerializer.serializeRequest(finished)!,
    )

    expect(fromJson.spans).toEqual(fromProto.spans)
  })
})

describe('OTLP/JSON decode — spec deviations and hostile input', () => {
  const baseSpan = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: 'chat gpt-4o',
    kind: 3,
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
  }

  const wrap = (spans: unknown[]): string =>
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ scope: { name: 's' }, spans }] }] })

  it('accepts snake_case field names, which proto3 JSON parsers MUST accept', () => {
    const body = JSON.stringify({
      resource_spans: [
        {
          scope_spans: [
            {
              scope: { name: 's' },
              spans: [
                {
                  trace_id: TRACE_ID,
                  span_id: SPAN_ID,
                  parent_span_id: PARENT_ID,
                  name: 'chat',
                  start_time_unix_nano: '1700000000000000000',
                  end_time_unix_nano: '1700000001000000000',
                },
              ],
            },
          ],
        },
      ],
    })
    const decoded = decodeJsonExportTraceServiceRequest(body)
    expect(decoded.spans).toHaveLength(1)
    expect(decoded.spans[0]!.parentSpanId).toBe(PARENT_ID)
  })

  it('accepts the enum NAME form of kind and status, not only the ordinal', () => {
    const decoded = decodeJsonExportTraceServiceRequest(
      wrap([{ ...baseSpan, kind: 'SPAN_KIND_CLIENT', status: { code: 'STATUS_CODE_ERROR' } }]),
    )
    expect(decoded.spans[0]!.kind).toBe('client')
    expect(decoded.spans[0]!.status?.code).toBe(2)
  })

  it('accepts a NUMERIC uint64 timestamp, which the spec permits', () => {
    const decoded = decodeJsonExportTraceServiceRequest(
      wrap([{ ...baseSpan, startTimeUnixNano: 1_700_000_000_000_000_000 }]),
    )
    // Normalized to a decimal string regardless of the wire form, so the
    // downstream mapper never sees the unsafe `number` path.
    expect(typeof decoded.spans[0]!.startTimeUnixNano).toBe('string')
  })

  it('treats endTimeUnixNano === 0 as NOT ENDED, not as an instant', () => {
    const decoded = decodeJsonExportTraceServiceRequest(
      wrap([{ ...baseSpan, endTimeUnixNano: '0' }]),
    )
    // Zero is "unset" on the wire. Read as an instant it sorts to the front of
    // the run, putting a tool's result before the run began.
    expect(decoded.spans[0]!.endTimeUnixNano).toBeUndefined()
  })

  it('REJECTS a bad span without failing the batch — partial success, not 400', () => {
    const decoded = decodeJsonExportTraceServiceRequest(
      wrap([
        baseSpan,
        { ...baseSpan, spanId: 'nothex' },
        { ...baseSpan, traceId: '0'.repeat(32) },
        { ...baseSpan, startTimeUnixNano: undefined },
      ]),
    )
    // The one good span survives. This is the whole reason decode rejections
    // are DATA rather than exceptions: a thrown error here would 400 the
    // request, and the OTLP spec forbids the exporter from retrying a 400, so
    // the good span would be lost permanently to one bad sibling.
    expect(decoded.spans).toHaveLength(1)
    expect(decoded.rejected.map((r) => r.reason).sort()).toEqual([
      'malformed-span-id',
      'malformed-trace-id',
      'missing-start-time',
    ])
  })

  it('treats an all-zero parent span id as "no parent", not as malformed', () => {
    const decoded = decodeJsonExportTraceServiceRequest(
      wrap([{ ...baseSpan, parentSpanId: '0'.repeat(16) }]),
    )
    expect(decoded.spans).toHaveLength(1)
    expect(decoded.spans[0]!.parentSpanId).toBeUndefined()
  })

  it('throws on a body that is not an export request at all', () => {
    expect(() => decodeJsonExportTraceServiceRequest('not json')).toThrow(OtlpJsonDecodeError)
    expect(() => decodeJsonExportTraceServiceRequest('[1,2,3]')).toThrow(OtlpJsonDecodeError)
    expect(() => decodeJsonExportTraceServiceRequest('{"hello":"world"}')).toThrow(
      OtlpJsonDecodeError,
    )
  })

  it('accepts `{}` as an empty export', () => {
    const decoded = decodeJsonExportTraceServiceRequest('{}')
    expect(decoded.spans).toEqual([])
    expect(decoded.rejected).toEqual([])
  })
})
