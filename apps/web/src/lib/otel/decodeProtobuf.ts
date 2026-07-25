// ---------------------------------------------------------------------------
// OTLP/HTTP `ExportTraceServiceRequest` (application/x-protobuf) decoder.
//
// Field numbers below are from opentelemetry-proto v1
// (`opentelemetry/proto/collector/trace/v1/trace_service.proto` and
// `opentelemetry/proto/trace/v1/trace.proto`). They are frozen by protobuf's
// own compatibility guarantees — a field number never changes meaning — so
// hard-coding them is safe in a way that hard-coding, say, an attribute NAME
// would not be.
//
// UNKNOWN FIELDS ARE SKIPPED, NEVER REJECTED. An exporter built against a
// newer opentelemetry-proto will send fields we have never heard of; protobuf
// requires that to be a no-op, and an OTLP receiver that 400s on it is broken
// for every exporter that upgrades before we do.
// ---------------------------------------------------------------------------

import {
  MAX_ANY_VALUE_DEPTH,
  MAX_ATTRIBUTES_PER_SPAN,
  MAX_SPANS_PER_REQUEST,
} from './limits'
import {
  ProtobufDecodeError,
  ProtoReader,
  WIRE_FIXED64,
  WIRE_LENGTH_DELIMITED,
  WIRE_VARINT,
} from './protobuf'
import {
  bytesToHex,
  isValidSpanId,
  isValidTraceId,
  setAttribute,
  SPAN_KIND_BY_ORDINAL,
  type DecodedTraceBatch,
  type NormalizedSpan,
  type OtelAttributeValue,
  type SpanDecodeRejection,
} from './types'

// --- ExportTraceServiceRequest ---
const F_REQ_RESOURCE_SPANS = 1

// --- ResourceSpans ---
const F_RS_SCOPE_SPANS = 2
const F_RS_SCHEMA_URL = 3

// --- ScopeSpans ---
const F_SS_SCOPE = 1
const F_SS_SPANS = 2
const F_SS_SCHEMA_URL = 3

// --- InstrumentationScope ---
const F_SCOPE_NAME = 1

// --- Span ---
const F_SPAN_TRACE_ID = 1
const F_SPAN_SPAN_ID = 2
const F_SPAN_PARENT_SPAN_ID = 4
const F_SPAN_NAME = 5
const F_SPAN_KIND = 6
const F_SPAN_START_TIME = 7
const F_SPAN_END_TIME = 8
const F_SPAN_ATTRIBUTES = 9
const F_SPAN_EVENTS = 11
const F_SPAN_LINKS = 13
const F_SPAN_STATUS = 15

// --- Status ---
const F_STATUS_MESSAGE = 2
const F_STATUS_CODE = 3

// --- KeyValue ---
const F_KV_KEY = 1
const F_KV_VALUE = 2

// --- AnyValue (oneof) ---
const F_AV_STRING = 1
const F_AV_BOOL = 2
const F_AV_INT = 3
const F_AV_DOUBLE = 4
const F_AV_ARRAY = 5
const F_AV_KVLIST = 6
const F_AV_BYTES = 7

// --- ArrayValue / KeyValueList ---
const F_LIST_VALUES = 1

// `apps/web/tsconfig.json` targets ES2017: BigInt LITERALS are a syntax error
// there. Hoisted constants, not inlinable. See protobuf.ts for the same note.
const B0 = BigInt(0)
const B_2_63 = BigInt(1) << BigInt(63)
const B_2_64 = BigInt(1) << BigInt(64)

/**
 * Decode an OTLP `AnyValue`.
 *
 * `int_value` is a proto3 `int64` and is returned as a `number` when it fits
 * in the safe-integer range and as a DECIMAL STRING when it does not. Silently
 * returning a lossy `number` for a value above 2^53 would corrupt exactly the
 * attributes most worth being exact about (token counts are safe; ids and
 * nanosecond durations are not).
 */
function decodeAnyValue(r: ProtoReader, depth: number): OtelAttributeValue {
  if (depth > MAX_ANY_VALUE_DEPTH) {
    throw new ProtobufDecodeError(`AnyValue nested deeper than ${String(MAX_ANY_VALUE_DEPTH)}`)
  }

  let value: OtelAttributeValue = undefined

  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    switch (fieldNumber) {
      case F_AV_STRING:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        value = r.readString()
        break
      case F_AV_BOOL:
        if (wireType !== WIRE_VARINT) { r.skipField(wireType); break }
        value = r.readVarint() !== B0
        break
      case F_AV_INT: {
        if (wireType !== WIRE_VARINT) { r.skipField(wireType); break }
        const raw = r.readVarint()
        // proto3 encodes negative int64 as the 64-bit two's complement.
        const signed = raw >= B_2_63 ? raw - B_2_64 : raw
        value =
          signed <= BigInt(Number.MAX_SAFE_INTEGER) && signed >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(signed)
            : signed.toString()
        break
      }
      case F_AV_DOUBLE:
        if (wireType !== WIRE_FIXED64) { r.skipField(wireType); break }
        value = r.readDouble()
        break
      case F_AV_ARRAY: {
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        const inner = r.readMessage()
        const items: OtelAttributeValue[] = []
        while (!inner.eof) {
          const t = inner.readTag()
          if (t.fieldNumber === F_LIST_VALUES && t.wireType === WIRE_LENGTH_DELIMITED) {
            items.push(decodeAnyValue(inner.readMessage(), depth + 1))
          } else {
            inner.skipField(t.wireType)
          }
        }
        value = items
        break
      }
      case F_AV_KVLIST: {
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        const inner = r.readMessage()
        const obj: Record<string, OtelAttributeValue> = {}
        while (!inner.eof) {
          const t = inner.readTag()
          if (t.fieldNumber === F_LIST_VALUES && t.wireType === WIRE_LENGTH_DELIMITED) {
            const kv = decodeKeyValue(inner.readMessage(), depth + 1)
            if (kv !== null) setAttribute(obj, kv.key, kv.value)
          } else {
            inner.skipField(t.wireType)
          }
        }
        value = obj
        break
      }
      case F_AV_BYTES: {
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        // Hex rather than base64: this ends up inside an append-only event
        // payload that an engineer reads by eye, and OTLP/JSON itself uses hex
        // for the only bytes fields that matter here (ids).
        value = bytesToHex(r.readBytes())
        break
      }
      default:
        r.skipField(wireType)
    }
  }

  return value
}

function decodeKeyValue(
  r: ProtoReader,
  depth: number,
): { key: string; value: OtelAttributeValue } | null {
  let key: string | undefined
  let value: OtelAttributeValue = undefined

  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === F_KV_KEY && wireType === WIRE_LENGTH_DELIMITED) {
      key = r.readString()
    } else if (fieldNumber === F_KV_VALUE && wireType === WIRE_LENGTH_DELIMITED) {
      value = decodeAnyValue(r.readMessage(), depth + 1)
    } else {
      r.skipField(wireType)
    }
  }

  if (key === undefined || key === '') return null
  return { key, value }
}

function decodeStatus(r: ProtoReader): { code: number; message?: string } {
  let code = 0
  let message: string | undefined

  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === F_STATUS_MESSAGE && wireType === WIRE_LENGTH_DELIMITED) {
      message = r.readString()
    } else if (fieldNumber === F_STATUS_CODE && wireType === WIRE_VARINT) {
      code = r.readVarintAsNumber()
    } else {
      r.skipField(wireType)
    }
  }

  return { code, ...(message !== undefined && message !== '' && { message }) }
}

/**
 * Decode one `Span`.
 *
 * Returns a rejection rather than throwing for span-level problems (bad ids,
 * missing start time) so that one bad span costs one span, not the batch. Only
 * FRAMING errors — a truncated message, an impossible length — throw, because
 * past those the reader's position is meaningless and the remaining spans
 * cannot be located at all.
 */
function decodeSpan(
  r: ProtoReader,
  scopeName: string | undefined,
  schemaUrl: string | undefined,
): NormalizedSpan | SpanDecodeRejection {
  let traceId: string | undefined
  let spanId: string | undefined
  let parentSpanId: string | undefined
  let name = ''
  let kindOrdinal: number | undefined
  let startTime: bigint | undefined
  let endTime: bigint | undefined
  let status: { code: number; message?: string } | undefined
  const attributes: Record<string, OtelAttributeValue> = {}
  let attributeCount = 0
  let spanEventCount = 0
  let spanLinkCount = 0

  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    switch (fieldNumber) {
      case F_SPAN_TRACE_ID:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        traceId = bytesToHex(r.readBytes())
        break
      case F_SPAN_SPAN_ID:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        spanId = bytesToHex(r.readBytes())
        break
      case F_SPAN_PARENT_SPAN_ID: {
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        const raw = bytesToHex(r.readBytes())
        // Empty bytes and all-zero both mean "no parent" on the wire. The
        // mapper treats absent/empty/self as root, so normalize to absent.
        if (raw !== '' && !/^0+$/.test(raw)) parentSpanId = raw
        break
      }
      case F_SPAN_NAME:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        name = r.readString()
        break
      case F_SPAN_KIND:
        if (wireType !== WIRE_VARINT) { r.skipField(wireType); break }
        kindOrdinal = r.readVarintAsNumber()
        break
      case F_SPAN_START_TIME:
        if (wireType !== WIRE_FIXED64) { r.skipField(wireType); break }
        startTime = r.readFixed64()
        break
      case F_SPAN_END_TIME:
        if (wireType !== WIRE_FIXED64) { r.skipField(wireType); break }
        endTime = r.readFixed64()
        break
      case F_SPAN_ATTRIBUTES: {
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        const sub = r.readMessage()
        // The message is consumed either way — dropping past the cap must not
        // desynchronize the outer reader.
        if (attributeCount >= MAX_ATTRIBUTES_PER_SPAN) break
        const kv = decodeKeyValue(sub, 0)
        if (kv !== null) {
          setAttribute(attributes, kv.key, kv.value)
          attributeCount++
        }
        break
      }
      case F_SPAN_EVENTS:
        // Counted, not decoded. The mapper takes only a COUNT
        // (`spanEventCount`) because span events have no representation in our
        // payload shapes; it reports the loss as `span-events-dropped`.
        // Decoding bodies we would immediately discard would be pure attack
        // surface.
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        r.skipField(wireType)
        spanEventCount++
        break
      case F_SPAN_LINKS:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        r.skipField(wireType)
        spanLinkCount++
        break
      case F_SPAN_STATUS:
        if (wireType !== WIRE_LENGTH_DELIMITED) { r.skipField(wireType); break }
        status = decodeStatus(r.readMessage())
        break
      default:
        r.skipField(wireType)
    }
  }

  if (traceId === undefined || !isValidTraceId(traceId)) {
    return { ...(spanId !== undefined && { spanId }), reason: 'malformed-trace-id' }
  }
  if (spanId === undefined || !isValidSpanId(spanId)) {
    return { reason: 'malformed-span-id' }
  }
  if (parentSpanId !== undefined && !isValidSpanId(parentSpanId)) {
    return { spanId, reason: 'malformed-parent-span-id' }
  }
  if (startTime === undefined || startTime === B0) {
    // A span with no start instant has no position in any ordering. The mapper
    // would have to invent one, and an invented instant on an append-only,
    // evidentiary log is worse than a reported rejection.
    return { spanId, reason: 'missing-start-time' }
  }

  const kind =
    kindOrdinal !== undefined ? SPAN_KIND_BY_ORDINAL[kindOrdinal] : undefined

  return {
    traceId,
    spanId,
    ...(parentSpanId !== undefined && { parentSpanId }),
    name,
    ...(kind !== undefined && { kind }),
    startTimeUnixNano: startTime.toString(),
    // Zero means "not ended" on the wire; the mapper documents that it must
    // reach it as ABSENT, because zero read as an instant sorts the span to
    // the front of the run.
    ...(endTime !== undefined && endTime !== B0 && { endTimeUnixNano: endTime.toString() }),
    ...(attributeCount > 0 && { attributes }),
    ...(status !== undefined && { status }),
    ...(scopeName !== undefined && scopeName !== '' && { scopeName }),
    ...(schemaUrl !== undefined && schemaUrl !== '' && { schemaUrl }),
    ...(spanEventCount > 0 && { spanEventCount }),
    ...(spanLinkCount > 0 && { spanLinkCount }),
  }
}

function decodeScope(r: ProtoReader): string | undefined {
  let name: string | undefined
  while (!r.eof) {
    const { fieldNumber, wireType } = r.readTag()
    if (fieldNumber === F_SCOPE_NAME && wireType === WIRE_LENGTH_DELIMITED) {
      name = r.readString()
    } else {
      r.skipField(wireType)
    }
  }
  return name
}

/**
 * Decode a full OTLP/HTTP protobuf export request.
 *
 * @throws {ProtobufDecodeError} on framing-level corruption only. The caller
 * maps that to 400 (non-retryable) — correct, because a body this malformed
 * will be malformed identically on every retry.
 */
export function decodeExportTraceServiceRequest(body: Uint8Array): DecodedTraceBatch {
  const root = new ProtoReader(body)
  const spans: NormalizedSpan[] = []
  const rejected: SpanDecodeRejection[] = []

  while (!root.eof) {
    const { fieldNumber, wireType } = root.readTag()
    if (fieldNumber !== F_REQ_RESOURCE_SPANS || wireType !== WIRE_LENGTH_DELIMITED) {
      root.skipField(wireType)
      continue
    }

    const rs = root.readMessage()
    let resourceSchemaUrl: string | undefined

    // ResourceSpans fields can arrive in any order; protobuf makes no ordering
    // guarantee. Collect scope_spans ranges first, then apply the (possibly
    // later-declared) resource-level schema_url to all of them.
    const scopeSpanReaders: ProtoReader[] = []

    while (!rs.eof) {
      const t = rs.readTag()
      if (t.fieldNumber === F_RS_SCOPE_SPANS && t.wireType === WIRE_LENGTH_DELIMITED) {
        scopeSpanReaders.push(rs.readMessage())
      } else if (t.fieldNumber === F_RS_SCHEMA_URL && t.wireType === WIRE_LENGTH_DELIMITED) {
        resourceSchemaUrl = rs.readString()
      } else {
        rs.skipField(t.wireType)
      }
    }

    for (const ss of scopeSpanReaders) {
      let scopeName: string | undefined
      let scopeSchemaUrl: string | undefined
      const spanReaders: ProtoReader[] = []

      while (!ss.eof) {
        const t = ss.readTag()
        if (t.fieldNumber === F_SS_SCOPE && t.wireType === WIRE_LENGTH_DELIMITED) {
          scopeName = decodeScope(ss.readMessage())
        } else if (t.fieldNumber === F_SS_SPANS && t.wireType === WIRE_LENGTH_DELIMITED) {
          spanReaders.push(ss.readMessage())
        } else if (t.fieldNumber === F_SS_SCHEMA_URL && t.wireType === WIRE_LENGTH_DELIMITED) {
          scopeSchemaUrl = ss.readString()
        } else {
          ss.skipField(t.wireType)
        }
      }

      // ScopeSpans.schema_url wins over ResourceSpans.schema_url: it is the
      // narrower declaration, and it is the one the instrumentation that
      // produced these specific spans attached.
      const schemaUrl = scopeSchemaUrl ?? resourceSchemaUrl

      for (const sr of spanReaders) {
        if (spans.length >= MAX_SPANS_PER_REQUEST) {
          rejected.push({ reason: 'span-limit-exceeded' })
          continue
        }
        const decoded = decodeSpan(sr, scopeName, schemaUrl)
        if ('reason' in decoded) rejected.push(decoded)
        else spans.push(decoded)
      }
    }
  }

  return { spans, rejected }
}
