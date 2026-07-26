// ---------------------------------------------------------------------------
// OTLP/HTTP `ExportTraceServiceRequest` (application/json) decoder.
//
// OTLP/JSON is proto3's canonical JSON mapping with TWO deliberate deviations
// the spec calls out, and getting either wrong makes this endpoint silently
// wrong rather than loudly broken:
//
//   1. `trace_id` / `span_id` / `parent_span_id` are HEX strings, NOT the
//      base64 that proto3 JSON mandates for `bytes`. This is the single most
//      commonly mis-implemented part of OTLP/JSON.
//   2. 64-bit fields (`startTimeUnixNano`) may be a JSON string OR a number.
//      They are emitted as strings by every conforming exporter precisely
//      because a JSON number cannot hold an epoch-nanosecond value — so a
//      NUMERIC timestamp is accepted but is already lossy on arrival.
//
// Field names may be camelCase (canonical) or the original snake_case (proto3
// JSON parsers MUST accept both). Both are read here.
// ---------------------------------------------------------------------------

import {
  MAX_ANY_VALUE_DEPTH,
  MAX_ATTRIBUTES_PER_SPAN,
  MAX_SPANS_PER_REQUEST,
} from './limits'
import {
  bytesToHex,
  isValidSpanId,
  isValidTraceId,
  setAttribute,
  SPAN_KIND_BY_ORDINAL,
  type DecodedTraceBatch,
  type NormalizedSpan,
  type OtelAttributeValue,
  type OtelSpanKind,
  type SpanDecodeRejection,
} from './types'

/** Thrown for JSON that is not a plausible export request. Maps to 400. */
export class OtlpJsonDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OtlpJsonDecodeError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Read a field under either its camelCase or snake_case spelling. */
function pick(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  const a = obj[camel]
  return a !== undefined ? a : obj[snake]
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Normalize a uint64 field to a decimal string.
 *
 * A JSON `number` is accepted (the spec permits it) but is converted through
 * `BigInt(Math.trunc(...))`, which makes the precision that was ALREADY lost
 * when the exporter serialized it explicit rather than compounding it. We do
 * not pretend the value is exact; we also do not reject a conforming exporter.
 */
function asUint64String(v: unknown): string | undefined {
  if (typeof v === 'string') {
    if (!/^\d+$/.test(v)) return undefined
    return BigInt(v).toString()
  }
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return BigInt(Math.trunc(v)).toString()
  }
  return undefined
}

/**
 * Normalize an id field.
 *
 * Accepts hex (what OTLP/JSON actually specifies) and, defensively, base64 of
 * the right decoded length — some hand-rolled exporters follow proto3 JSON
 * literally. Accepting both costs nothing and the two are unambiguous by
 * length and alphabet.
 */
function asIdHex(v: unknown, byteLength: number): string | undefined {
  const s = asString(v)
  if (s === undefined || s === '') return undefined

  const hexLen = byteLength * 2
  if (s.length === hexLen && /^[0-9a-fA-F]+$/.test(s)) return s.toLowerCase()

  // base64 fallback — only when it decodes to exactly the expected length.
  try {
    const bin = atob(s)
    if (bin.length !== byteLength) return undefined
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytesToHex(bytes)
  } catch {
    return undefined
  }
}

/** Decode an OTLP/JSON `AnyValue`. */
function decodeAnyValue(v: unknown, depth: number): OtelAttributeValue {
  // SHARED with decodeProtobuf.ts. Previously the literal `16`, which agreed
  // with the protobuf decoder by coincidence rather than by construction.
  //
  // This bound is LOAD-BEARING, not just anti-stack-overflow hygiene: Team D's
  // D4b shows four mapped payload fields (`tool.call.input`,
  // `tool.result.output`, `llm.request.messages[].content`,
  // `custom.data.otel.systemInstructions`) carry caller values RAW into
  // `convex/otel_ingest.ts`'s recursive `JSON.stringify(payload)`, which throws
  // `RangeError` on deep nesting with no duplicate span involved. This cap is
  // the only reason that crash is unreachable from the wire. RAISING IT
  // RE-OPENS A CRASH — Team D's regression guard fails loudly naming D4b.
  if (depth > MAX_ANY_VALUE_DEPTH || !isRecord(v)) return undefined

  const stringValue = pick(v, 'stringValue', 'string_value')
  if (typeof stringValue === 'string') return stringValue

  const boolValue = pick(v, 'boolValue', 'bool_value')
  if (typeof boolValue === 'boolean') return boolValue

  const intValue = pick(v, 'intValue', 'int_value')
  if (typeof intValue === 'string' && /^-?\d+$/.test(intValue)) {
    const b = BigInt(intValue)
    return b <= BigInt(Number.MAX_SAFE_INTEGER) && b >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(b)
      : intValue
  }
  if (typeof intValue === 'number') return intValue

  const doubleValue = pick(v, 'doubleValue', 'double_value')
  if (typeof doubleValue === 'number') return doubleValue

  const bytesValue = pick(v, 'bytesValue', 'bytes_value')
  if (typeof bytesValue === 'string') return bytesValue

  const arrayValue = pick(v, 'arrayValue', 'array_value')
  if (isRecord(arrayValue) && Array.isArray(arrayValue['values'])) {
    return (arrayValue['values'] as unknown[]).map((item) => decodeAnyValue(item, depth + 1))
  }

  const kvlistValue = pick(v, 'kvlistValue', 'kvlist_value')
  if (isRecord(kvlistValue) && Array.isArray(kvlistValue['values'])) {
    const out: Record<string, OtelAttributeValue> = {}
    for (const entry of kvlistValue['values'] as unknown[]) {
      if (!isRecord(entry)) continue
      const key = asString(entry['key'])
      if (key === undefined || key === '') continue
      setAttribute(out, key, decodeAnyValue(entry['value'], depth + 1))
    }
    return out
  }

  // An AnyValue with no oneof arm set is the proto3 default: an empty string.
  return undefined
}

function decodeAttributes(raw: unknown): {
  attributes: Record<string, OtelAttributeValue>
  count: number
} {
  const attributes: Record<string, OtelAttributeValue> = {}
  let count = 0
  if (!Array.isArray(raw)) return { attributes, count }

  for (const entry of raw as unknown[]) {
    if (count >= MAX_ATTRIBUTES_PER_SPAN) break
    if (!isRecord(entry)) continue
    const key = asString(entry['key'])
    if (key === undefined || key === '') continue
    setAttribute(attributes, key, decodeAnyValue(entry['value'], 0))
    count++
  }
  return { attributes, count }
}

/**
 * `SpanKind` in OTLP/JSON is either the enum NAME (`"SPAN_KIND_CLIENT"`) or the
 * ordinal. Both are accepted; anything unrecognized is `undefined` rather than
 * an error, matching the protobuf decoder's forward-compatibility posture.
 */
function decodeSpanKind(raw: unknown): OtelSpanKind | undefined {
  if (typeof raw === 'number') return SPAN_KIND_BY_ORDINAL[raw]
  if (typeof raw === 'string') {
    const name = raw.replace(/^SPAN_KIND_/, '').toLowerCase()
    return SPAN_KIND_BY_ORDINAL.find((k) => k === name)
  }
  return undefined
}

function decodeStatusCode(raw: unknown): number | undefined {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const name = raw.replace(/^STATUS_CODE_/, '').toUpperCase()
    if (name === 'UNSET') return 0
    if (name === 'OK') return 1
    if (name === 'ERROR') return 2
  }
  return undefined
}

function decodeSpan(
  raw: Record<string, unknown>,
  scopeName: string | undefined,
  schemaUrl: string | undefined,
): NormalizedSpan | SpanDecodeRejection {
  const traceId = asIdHex(pick(raw, 'traceId', 'trace_id'), 16)
  const spanId = asIdHex(pick(raw, 'spanId', 'span_id'), 8)
  const parentSpanId = asIdHex(pick(raw, 'parentSpanId', 'parent_span_id'), 8)

  if (traceId === undefined || !isValidTraceId(traceId)) {
    return { ...(spanId !== undefined && { spanId }), reason: 'malformed-trace-id' }
  }
  if (spanId === undefined || !isValidSpanId(spanId)) {
    return { reason: 'malformed-span-id' }
  }
  if (parentSpanId !== undefined && !isValidSpanId(parentSpanId)) {
    // An all-zero parent is the "no parent" sentinel, not a malformed one.
    if (!/^0+$/.test(parentSpanId)) {
      return { spanId, reason: 'malformed-parent-span-id' }
    }
  }

  const startTimeUnixNano = asUint64String(pick(raw, 'startTimeUnixNano', 'start_time_unix_nano'))
  if (startTimeUnixNano === undefined || startTimeUnixNano === '0') {
    return { spanId, reason: 'missing-start-time' }
  }

  const endRaw = asUint64String(pick(raw, 'endTimeUnixNano', 'end_time_unix_nano'))
  const endTimeUnixNano = endRaw !== undefined && endRaw !== '0' ? endRaw : undefined

  const { attributes, count } = decodeAttributes(pick(raw, 'attributes', 'attributes'))
  const kind = decodeSpanKind(raw['kind'])

  let status: { code: number; message?: string } | undefined
  const rawStatus = raw['status']
  if (isRecord(rawStatus)) {
    const code = decodeStatusCode(rawStatus['code'])
    const message = asString(rawStatus['message'])
    if (code !== undefined) {
      status = { code, ...(message !== undefined && message !== '' && { message }) }
    }
  }

  const events = raw['events']
  const links = raw['links']
  const spanEventCount = Array.isArray(events) ? events.length : 0
  const spanLinkCount = Array.isArray(links) ? links.length : 0

  const validParent =
    parentSpanId !== undefined && isValidSpanId(parentSpanId) ? parentSpanId : undefined

  return {
    traceId,
    spanId,
    ...(validParent !== undefined && { parentSpanId: validParent }),
    name: asString(raw['name']) ?? '',
    ...(kind !== undefined && { kind }),
    startTimeUnixNano,
    ...(endTimeUnixNano !== undefined && { endTimeUnixNano }),
    ...(count > 0 && { attributes }),
    ...(status !== undefined && { status }),
    ...(scopeName !== undefined && scopeName !== '' && { scopeName }),
    ...(schemaUrl !== undefined && schemaUrl !== '' && { schemaUrl }),
    ...(spanEventCount > 0 && { spanEventCount }),
    ...(spanLinkCount > 0 && { spanLinkCount }),
  }
}

/**
 * Decode a full OTLP/JSON export request.
 *
 * @throws {OtlpJsonDecodeError} when the top-level shape is not an export
 * request at all. A body that IS an export request but contains bad spans
 * returns them in `rejected` instead — same partial-success reasoning as the
 * protobuf decoder.
 */
export function decodeJsonExportTraceServiceRequest(text: string): DecodedTraceBatch {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new OtlpJsonDecodeError('body is not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw new OtlpJsonDecodeError('body is not a JSON object')
  }

  const resourceSpans = pick(parsed, 'resourceSpans', 'resource_spans')
  if (resourceSpans === undefined) {
    // An export request with zero resource_spans is legal and means "nothing
    // to report". Distinguish it from a body that is some OTHER JSON document
    // entirely, which is a client error worth a 400.
    if (Object.keys(parsed).length > 0) {
      throw new OtlpJsonDecodeError('body has no resourceSpans field')
    }
    return { spans: [], rejected: [] }
  }
  if (!Array.isArray(resourceSpans)) {
    throw new OtlpJsonDecodeError('resourceSpans is not an array')
  }

  const spans: NormalizedSpan[] = []
  const rejected: SpanDecodeRejection[] = []

  for (const rs of resourceSpans as unknown[]) {
    if (!isRecord(rs)) continue
    const resourceSchemaUrl = asString(pick(rs, 'schemaUrl', 'schema_url'))
    const scopeSpans = pick(rs, 'scopeSpans', 'scope_spans')
    if (!Array.isArray(scopeSpans)) continue

    for (const ss of scopeSpans as unknown[]) {
      if (!isRecord(ss)) continue
      const scope = ss['scope']
      const scopeName = isRecord(scope) ? asString(scope['name']) : undefined
      const schemaUrl = asString(pick(ss, 'schemaUrl', 'schema_url')) ?? resourceSchemaUrl

      const rawSpans = ss['spans']
      if (!Array.isArray(rawSpans)) continue

      for (const s of rawSpans as unknown[]) {
        if (!isRecord(s)) continue
        if (spans.length >= MAX_SPANS_PER_REQUEST) {
          rejected.push({ reason: 'span-limit-exceeded' })
          continue
        }
        const decoded = decodeSpan(s, scopeName, schemaUrl)
        if ('reason' in decoded) rejected.push(decoded)
        else spans.push(decoded)
      }
    }
  }

  return { spans, rejected }
}
