// ---------------------------------------------------------------------------
// The OTLP span shape the ingest path accepts — CANONICAL.
//
// WHY THIS FILE EXISTS. This shape was mirrored by hand in three places: the
// mapper's `OtelSpanInput` (convex/helpers/otel_mapping.ts), the mutation's
// `spanValidator` (convex/otel_ingest.ts), and the OTLP route that decodes the
// wire body. Three hand-maintained copies of one type, sitting on the
// UNTRUSTED-INPUT path, where drift does not merely fail to compile — it means
// we validate a shape we do not parse, or parse a field nothing validates.
//
// That is the same hand-mirroring failure mode this project has already paid
// for repeatedly. Two of the three copies can now import this one. The third
// (`convex/`) cannot, by design — `convex/package.json` deliberately depends
// only on `convex` — so it stays a mirror, but a mirror pinned by
// {@link OTEL_SPAN_INPUT_FIELDS} rather than by discipline.
//
// Zero runtime dependencies. The one runtime export is a frozen array of field
// names, which is what lets a drift test compare a validator's keys against
// this type STRUCTURALLY instead of by scraping source text.
// ---------------------------------------------------------------------------

import type { OtelSpanKind } from "./events.js";

/**
 * One normalized OpenTelemetry span, as accepted by the ingest mutation.
 *
 * NORMALIZED, not raw OTLP: the transport is expected to have flattened OTLP's
 * `KeyValue[]` attribute list into a plain object. That flattening is
 * mechanical and lossless, and keeping it in the transport is what stops the
 * backend from growing a protobuf decoding surface — and what keeps the
 * mapper's ordering engine testable without OTLP fixtures.
 *
 * TIMESTAMPS ARE UNIX NANOSECONDS. Prefer the DECIMAL STRING form OTLP/JSON
 * already uses for uint64. A `number` is accepted for ergonomics but cannot
 * represent an epoch-nanosecond value exactly — float64 ULP at a 2026
 * epoch-nanosecond value (~1.75e18) is 256 ns — so every event derived from a
 * numeric timestamp is flagged `timing-approximated`. `bigint` is deliberately
 * absent: it is neither JSON nor Convex-serializable.
 *
 * `endTimeUnixNano` absent, or `"0"`, means the span HAS NOT ENDED. Zero is
 * "unset" on the wire; read as an instant it sorts to the front of the run,
 * putting a tool's result before the run began.
 */
export interface OtelSpanInput {
  /** W3C trace id — 32 lowercase hex chars. Rejected per-span if malformed. */
  traceId: string;
  /** W3C span id — 16 lowercase hex chars. Rejected per-span if malformed. */
  spanId: string;
  /** Absent or empty means "root". A parent naming a span not in the batch is an ORPHAN, never a run boundary. */
  parentSpanId?: string;
  name: string;
  kind?: OtelSpanKind;
  startTimeUnixNano: string | number;
  endTimeUnixNano?: string | number;
  /** Flattened attribute bag. Scalars, scalar arrays, or (Opt-In content) nested JSON. */
  attributes?: Record<string, unknown>;
  /** OTLP numeric status code (0 unset / 1 ok / 2 error) or the lowercased name. */
  status?: { code: number | "unset" | "ok" | "error"; message?: string };
  /** OTel `InstrumentationScope.name` — identifies WHOSE instrumentation produced the span. */
  scopeName?: string;
  /** Schema URL. A version outside the mapper's supported set is recorded as unmapped, never read under the wrong rulebook. */
  schemaUrl?: string;
  /** COUNT ONLY. Span events are not representable and are reported as `span-events-dropped`. */
  spanEventCount?: number;
  /** COUNT ONLY. Span links are not representable and are reported as `span-links-dropped`. */
  spanLinkCount?: number;
}

/**
 * Every field of {@link OtelSpanInput}, as runtime data.
 *
 * THE POINT: a drift test can compare a validator's key set against this array
 * and get a REAL guarantee, instead of scraping the keys out of source text and
 * hoping the regex keeps up. The two assertions below make the array provably
 * complete and provably free of invented names, so it cannot silently fall
 * behind the interface it describes:
 *
 *   - `satisfies readonly (keyof OtelSpanInput)[]` rejects a name that is not a
 *     field.
 *   - `_AllFieldsCovered` rejects a field that is not in the array.
 *
 * Adding a field to the interface without adding it here is therefore a
 * COMPILE error in this package, not a runtime surprise three packages away.
 */
export const OTEL_SPAN_INPUT_FIELDS = [
  "traceId",
  "spanId",
  "parentSpanId",
  "name",
  "kind",
  "startTimeUnixNano",
  "endTimeUnixNano",
  "attributes",
  "status",
  "scopeName",
  "schemaUrl",
  "spanEventCount",
  "spanLinkCount",
] as const satisfies readonly (keyof OtelSpanInput)[];

export type OtelSpanInputField = (typeof OTEL_SPAN_INPUT_FIELDS)[number];

/** Compile-time completeness: fails if a field of the interface is missing above. */
type _AllFieldsCovered =
  Exclude<keyof OtelSpanInput, OtelSpanInputField> extends never ? true : never;
const _assertAllFieldsCovered: _AllFieldsCovered = true;
void _assertAllFieldsCovered;

/** Fields that are REQUIRED on the wire. The rest are optional. */
export const OTEL_SPAN_INPUT_REQUIRED_FIELDS = [
  "traceId",
  "spanId",
  "name",
  "startTimeUnixNano",
] as const satisfies readonly OtelSpanInputField[];
