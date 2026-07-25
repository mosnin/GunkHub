// ---------------------------------------------------------------------------
// The normalized span shape this route produces and forwards to Convex.
//
// STRUCTURAL MIRROR of `OtelSpanInput` in convex/helpers/otel_mapping.ts, NOT
// an import of it.
//
// Why a mirror: `apps/web` may not import from `convex/` (CLAUDE.md file
// ownership map + the "no relative imports that escape a package root" rule),
// and `packages/contracts` does not export the mapper's input type — it only
// exports the OUTPUT-side types (`OtelEventProvenance`, `OtelDerivedEventWrite`).
//
// Why that is a PROBLEM and not just an inconvenience: this is precisely the
// hand-maintained-mirror shape that has already produced seven runtime bugs
// through convexFunctions.ts. It is defended by
// `tests/unit/otlp_route_convex_drift.test.ts`, which extracts the key set of
// `spanValidator` from `convex/otel_ingest.ts` and compares it against
// `keyof NormalizedSpan` — in BOTH directions, since a field only Convex knows
// is data this decoder never populates, and a field only this side knows is one
// Convex's validator rejects outright at runtime. Drift is a test failure, not
// a production surprise.
//
// (Source-text extraction rather than a type import: a type import would have
// to be registered in `tests/tsconfig.convex-seam.json`, because
// `convex/tsconfig.json` deliberately disables `exactOptionalPropertyTypes`.
// This gate is deliberately addable without touching shared config.)
//
// THE REAL FIX, which is not this team's to make: `OtelSpanInput` belongs in
// `packages/contracts`, alongside the provenance types that describe the other
// end of the same pipeline. See the report accompanying this work.
// ---------------------------------------------------------------------------

/** Mirror of the mapper's `OtelSpanKind`. */
export type OtelSpanKind =
  | 'unspecified'
  | 'internal'
  | 'server'
  | 'client'
  | 'producer'
  | 'consumer'

/**
 * OTLP `SpanKind` enum values, in wire order. Index = the protobuf varint.
 * Anything outside the range decodes to `unspecified` rather than failing —
 * an exporter from a future OTLP version must not lose its whole batch to an
 * enum member we have not heard of.
 */
export const SPAN_KIND_BY_ORDINAL: readonly OtelSpanKind[] = [
  'unspecified',
  'internal',
  'server',
  'client',
  'producer',
  'consumer',
]

/** Mirror of the mapper's attribute value type. */
export type OtelAttributeValue = unknown

/**
 * A decoded, normalized OTel span.
 *
 * Nanosecond timestamps are DECIMAL STRINGS. The mapper accepts
 * `bigint | string | number` and documents that `number` is unsafe at
 * nanosecond scale (it flags every derived event `timing-approximated`), and
 * `bigint` does not survive JSON serialization to Convex. A decimal string is
 * the only form that is both exact and transportable, so this decoder always
 * produces one and the "numeric timestamp" degradation path is unreachable
 * from this route.
 */
export interface NormalizedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind?: OtelSpanKind
  startTimeUnixNano: string
  endTimeUnixNano?: string
  attributes?: Readonly<Record<string, OtelAttributeValue>>
  status?: { code: number | 'unset' | 'ok' | 'error'; message?: string }
  scopeName?: string
  schemaUrl?: string
  spanEventCount?: number
  spanLinkCount?: number
}

/**
 * A span the decoder REFUSED, with the reason.
 *
 * Kept as data rather than thrown, because one malformed span in a batch of
 * 500 must not fail the other 499 — that is exactly what OTLP's partial
 * success exists to express. A thrown error here would turn a recoverable
 * partial into a 400 that the exporter is spec-forbidden from retrying, and
 * the 499 good spans would be lost permanently.
 */
export interface SpanDecodeRejection {
  /** Present when we got far enough to read one. */
  spanId?: string
  reason:
    | 'malformed-trace-id'
    | 'malformed-span-id'
    | 'malformed-parent-span-id'
    | 'missing-start-time'
    | 'span-limit-exceeded'
}

/** The result of decoding one OTLP export request body. */
export interface DecodedTraceBatch {
  spans: NormalizedSpan[]
  /** Spans present on the wire but not forwarded. Feeds `rejected_spans`. */
  rejected: SpanDecodeRejection[]
}

/**
 * Assign a decoded attribute onto an accumulator object.
 *
 * USE THIS AT EVERY ATTRIBUTE ASSIGNMENT SITE IN BOTH DECODERS. A bare
 * `target[key] = value` is WRONG here, and the reason is one key:
 *
 *   `__proto__` is not an ordinary property name on an object with the default
 *   prototype. It is an accessor inherited from `Object.prototype`, so
 *   `target['__proto__'] = v` does not create a property at all — it invokes a
 *   setter. With a STRING value the setter ignores the write and the attribute
 *   VANISHES; with an OBJECT value (an OTLP `kvlist` attribute) the same write
 *   REASSIGNS THE PROTOTYPE. The silent-drop case is the benign presentation
 *   of a prototype-pollution primitive reachable from unauthenticated wire
 *   input, and it is the same write either way.
 *
 * Confirmed on BOTH decoders against genuine bytes from
 * `@opentelemetry/otlp-transformer`'s real serializers — see
 * `tests/unit/otlp_route_proto_pollution.test.ts`.
 *
 * Why this outranks its size: `convex/helpers/otel_mapping.ts` already guards
 * its own attribute writes for exactly this reason, and that guard was being
 * defeated because the key was destroyed HERE, one layer upstream, before the
 * mapper ever saw it. Two layers, one hole, and the guarded layer was
 * downstream of the lossy one.
 *
 * `Object.defineProperty` rather than a null-prototype accumulator: it creates
 * an ordinary own data property while leaving the object's prototype intact,
 * so downstream code that calls `attrs.hasOwnProperty(...)` — which a
 * null-prototype object would break — keeps working. The value survives
 * `JSON.stringify`, and `JSON.parse` treats `__proto__` as an own property, so
 * nothing is polluted on the way to Convex either.
 *
 * NOTE the deliberately narrow scope. Control characters, lone surrogates, RTL
 * overrides, and the keys `constructor`, `prototype` and `toString` all pass
 * through a bare assignment intact and are NOT filtered here. This is one key
 * with special semantics in the object model, not an attribute-validation
 * layer — a decoder that started rejecting "suspicious" attribute names would
 * be silently discarding telemetry an engineer needs to debug with.
 */
export function setAttribute(
  target: Record<string, OtelAttributeValue>,
  key: string,
  value: OtelAttributeValue,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

const HEX_32 = /^[0-9a-f]{32}$/
const HEX_16 = /^[0-9a-f]{16}$/

/** All-zero ids are OTLP's "invalid/unset" sentinel, not real ids. */
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

export function isValidTraceId(id: string): boolean {
  return HEX_32.test(id) && id !== ZERO_TRACE_ID
}

export function isValidSpanId(id: string): boolean {
  return HEX_16.test(id) && id !== ZERO_SPAN_ID
}

/** Byte -> two lowercase hex chars. Precomputed so the hot path is one lookup. */
const HEX_BYTE: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
)

/**
 * Bytes → lowercase hex.
 *
 * Lowercase because `OtelEventProvenance` is validated by
 * `isProvenanceConsistent` (packages/contracts/src/provenance.ts) against
 * `/^[0-9a-f]{32}$/` — an uppercase id would be rejected at the write
 * boundary, after decode, with a much less useful error.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX_BYTE[b] ?? '00'
  return out
}
