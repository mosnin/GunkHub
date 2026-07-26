// ---------------------------------------------------------------------------
// Event provenance — how a stored event came to exist.
//
// THE RULING THIS FILE IMPLEMENTS: an event DERIVED from an OpenTelemetry span
// must be distinguishable from one recorded natively by the SDK. Not optional,
// not a nice-to-have.
//
// The event log is evidentiary. Replay, diff, failure-pattern fingerprinting,
// run explanations and the fix-confidence engine all treat it as ground truth
// about what an agent actually did. A derived event is a DIFFERENT KIND OF
// CLAIM from a first-party one: it is our interpretation of somebody else's
// telemetry, under a particular semantic-convention version, possibly with
// information dropped on the way in. Rendering that as indistinguishable from
// a first-party recording is a lie about the strength of the evidence — and
// because the log is APPEND-ONLY, it is a permanent one that cannot be
// corrected in place.
//
// Nothing in this file is a runtime dependency. The helpers below are pure,
// dependency-free functions over plain data, matching the existing precedent
// in status.ts (`isTerminalStatus`, `RunStatusValues`).
// ---------------------------------------------------------------------------

/**
 * How an event entered the log.
 *
 * - `sdk`  — recorded first-party by `@agent-flight-recorder/sdk`. The SDK
 *            controls the shape, so the payload is exactly what the
 *            instrumented code reported.
 * - `otel` — DERIVED by the backend from an ingested OpenTelemetry span. The
 *            payload is our interpretation, not the agent's own report.
 *
 * Deliberately a closed union. A third ingest source is a decision that
 * deserves a compiler error at every switch site, not a silent string.
 */
export type EventSourceKind = "sdk" | "otel";

/**
 * Why an OTel span→event mapping lost information.
 *
 * CLOSED union on purpose. "Lossy" with no reason is an unfalsifiable
 * disclaimer; an engineer reading a derived event needs to know WHAT was lost
 * to judge whether the gap matters to the bug they are chasing. Adding a
 * reason should be a deliberate, reviewed contracts change.
 */
export type OtelMappingLossReason =
  /** Span attributes had no representation in the target payload shape. */
  | "attributes-dropped"
  /** Span events (OTel's per-span log records) were not representable. */
  | "span-events-dropped"
  /** Span links were dropped — cross-trace causality is not preserved. */
  | "span-links-dropped"
  /** A timestamp or duration was inferred/rounded rather than read directly. */
  | "timing-approximated"
  /** Token usage was partially available; counts are floors, not totals. */
  | "usage-partial"
  /** A value exceeded a size bound and was truncated. */
  | "payload-truncated"
  /** OTel span status was squashed onto our narrower error shape. */
  | "status-approximated"
  /**
   * A field our payload requires had NO source attribute and was synthesized
   * by the mapper (e.g. a `tool.call` `call_id` with no span attribute to read
   * it from). The most dangerous kind of loss: the value looks first-party but
   * was invented at ingest, so correlation built on it may be fictional.
   */
  | "identity-synthesized";

/**
 * Provenance of a first-party SDK recording.
 *
 * Carries no span identity because there is none — the instrumented process
 * reported this event directly.
 */
export interface NativeEventProvenance {
  source: "sdk";
  /**
   * SDK version that recorded it, when known. Mirrors `Run.sdkVersion` but is
   * per-event: a long run can be recorded across an SDK upgrade.
   */
  sdkVersion?: string;
}

/**
 * Provenance of an event DERIVED from an OpenTelemetry span.
 *
 * Every field here answers a question a debugging engineer actually asks when
 * a derived event looks wrong: *which span was this, in which trace, read
 * under which convention, by which mapper, and did we lose anything?* Without
 * them, "derived" is an unactionable badge — the engineer can see that we
 * interpreted something but cannot go look at what we interpreted.
 */
export interface OtelEventProvenance {
  source: "otel";
  /** W3C trace id — 32 lowercase hex chars. The key for finding the sibling spans. */
  traceId: string;
  /** W3C span id — 16 lowercase hex chars. Identifies the exact source span. */
  spanId: string;
  /** Parent span id, when the span had one. Lets a reader rebuild the source tree. */
  parentSpanId?: string;
  /**
   * The raw OTel span name, preserved verbatim. Our `EventType` is a lossy
   * classification of it; this is what the emitting instrumentation actually
   * called the operation, and it is often the only string that matches what
   * the engineer sees in their own tracing backend.
   */
  spanName: string;
  /**
   * Instrumentation scope name (the OTel `InstrumentationScope.name`), e.g.
   * `"openinference.instrumentation.langchain"`. Identifies WHOSE
   * instrumentation produced the span, which is usually the first thing to
   * check when a mapping is systematically wrong.
   */
  scopeName?: string;
  /**
   * The semantic-convention version the mapper interpreted this span under,
   * e.g. `"1.29.0"`. REQUIRED.
   *
   * OTel's GenAI conventions are actively churning: the same attribute name
   * has meant different things across versions. An event derived under 1.27
   * and one derived under 1.31 are not the same claim, and a reader debugging
   * a wrong value must be able to tell which rulebook produced it. Recording
   * "otel" without recording the convention version is recording that we
   * guessed, without recording what we guessed from.
   */
  semconvVersion: string;
  /**
   * Version of OUR mapping code that produced this event. REQUIRED and
   * distinct from `semconvVersion`: the convention can be stable while our
   * reading of it has a bug. When a mapper bug is found, this is the field
   * that identifies exactly which stored events are suspect — and since the
   * log is append-only, identifying them is the only remedy available.
   */
  mapperVersion: string;
  /**
   * True when the mapping did NOT carry over everything the span contained.
   * REQUIRED, and required to be explicit: a mapper that has not considered
   * whether it lost information cannot leave this blank and have the omission
   * read as "lossless".
   */
  lossy: boolean;
  /**
   * What was lost. MUST be non-empty when `lossy` is true (enforced by
   * {@link isProvenanceConsistent}, not by the type system — TypeScript
   * cannot express "non-empty iff a sibling boolean").
   */
  lossReasons?: OtelMappingLossReason[];
  /**
   * Server wall clock at ingest, epoch ms. Deliberately separate from the
   * event's `timestamp`, which comes from the SPAN and is therefore the
   * emitting process's clock. Keeping both is what makes clock skew visible
   * instead of making it look like out-of-order execution.
   */
  receivedAt: number;
}

/**
 * Discriminated union over {@link EventSourceKind}.
 *
 * Consumers should switch on `source` rather than probing for the presence of
 * `traceId`, so that adding a future source is a compiler error at every site.
 */
export type EventProvenance = NativeEventProvenance | OtelEventProvenance;

/**
 * The provenance assumed for a stored event that carries none.
 *
 * See {@link resolveEventProvenance} for why this default is sound, and for
 * the single place it is allowed to be applied.
 */
export const IMPLIED_NATIVE_PROVENANCE: NativeEventProvenance = { source: "sdk" };

/**
 * Normalize a stored event's optional `provenance` into a definite claim.
 *
 * THIS IS THE ONLY PLACE "absent means native" IS ALLOWED TO BE ASSUMED, and
 * the assumption is sound for a specific, expiring reason: every event stored
 * before OTel ingestion shipped was written by the first-party SDK ingest
 * path, because no other writer existed. The default is not a guess about
 * unknown data; it is a true statement about a closed set of rows.
 *
 * What keeps it true going forward is NOT this function — it is that the only
 * contract describing a derived write ({@link OtelDerivedEventWrite}) makes
 * provenance REQUIRED, so a derived event cannot be written without one.
 *
 * Consumers that must not silently assume anything (an export bundle, an
 * evidentiary view, a compliance read) should test `event.provenance ===
 * undefined` themselves and render "unrecorded" rather than calling this.
 */
export function resolveEventProvenance(
  provenance: EventProvenance | undefined,
): EventProvenance {
  return provenance ?? IMPLIED_NATIVE_PROVENANCE;
}

/**
 * True when the event was derived from an OTel span rather than recorded
 * first-party.
 *
 * Takes the whole provenance (not an event) so it composes with both stored
 * events and in-flight write payloads.
 */
export function isDerivedProvenance(
  provenance: EventProvenance | undefined,
): provenance is OtelEventProvenance {
  return provenance?.source === "otel";
}

/**
 * Narrowing predicate for the invariants the TYPE SYSTEM cannot express.
 *
 * Returns false when a provenance record is internally contradictory:
 *   - `lossy: true` with no `lossReasons` (an unfalsifiable disclaimer)
 *   - `lossy: false` with `lossReasons` (a contradiction)
 *   - a `traceId`/`spanId` that is not W3C-shaped hex
 *   - a non-finite or non-positive `receivedAt`
 *
 * Intended for use at the ingest boundary, so a malformed provenance is
 * rejected BEFORE it is written into an append-only table where it can never
 * be corrected.
 */
export function isProvenanceConsistent(provenance: EventProvenance): boolean {
  if (provenance.source === "sdk") return true;

  const { traceId, spanId, parentSpanId, lossy, lossReasons, receivedAt } = provenance;

  if (!/^[0-9a-f]{32}$/.test(traceId)) return false;
  if (!/^[0-9a-f]{16}$/.test(spanId)) return false;
  if (parentSpanId !== undefined && !/^[0-9a-f]{16}$/.test(parentSpanId)) return false;
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return false;
  if (lossy && (lossReasons === undefined || lossReasons.length === 0)) return false;
  if (!lossy && lossReasons !== undefined && lossReasons.length > 0) return false;

  return true;
}
