// ---------------------------------------------------------------------------
// Temporal ordering of a run's events.
//
// THE RULING THIS FILE IMPLEMENTS: for an event DERIVED from an OpenTelemetry
// span, `sequenceNumber` is THE ORDER WE LEARNED ABOUT THE EVENT, not the
// order it happened. Temporal truth is carried separately, in
// {@link TemporalOrderKey}, and a replay or diff projection over a derived run
// MUST sort by it.
//
// WHY THE TWO DIVERGE, stated once so nobody has to re-derive it. Within a
// single OTLP batch they coincide, because the whole batch is learned at once
// and the mapper canonicalises it. ACROSS batches they cannot: a span arriving
// in batch 2 that occurred before spans already appended in batch 1 cannot be
// inserted before them, because insertion requires renumbering, and renumbering
// an append-only log is permanent corruption (Event Log Rule 1). So it is
// APPENDED, and the temporal truth rides alongside.
//
// `event.provenance.source === "otel"` is the signal that tells a consumer
// which ordering applies — which is the concrete reason provenance had to be
// mandatory on the derived write path rather than advisory.
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES IN CONTRACTS
// ---------------------------------------------------------------------------
// This module is CANONICAL. It previously existed as two hand-maintained
// copies — one in `convex/helpers/otel_mapping.ts` (which produces the key) and
// one in `apps/web/src/lib/replay/temporal.ts` (which consumes it) — because
// `apps/web` may not import from `convex/`. Two copies of an ordering
// comparator do not stay identical; they diverge, and the symptom is a run that
// renders in one order in the browser and another in `afr` and MCP, with
// nothing to say which is right.
//
// Every TypeScript consumer (`apps/web`, `packages/sdk`, `packages/cli`,
// `packages/mcp`) imports from here. `convex/` still mirrors it, because
// `convex/` has no dependency on this package by design (see
// `convex/package.json`) — that mirror is the ONE remaining copy and it is
// pinned by a drift test, not by discipline.
//
// Zero runtime dependencies, pure functions over plain data — the same posture
// as `provenance.ts` and `status.ts`.
// ---------------------------------------------------------------------------

import { isDerivedProvenance, type OtelEventProvenance } from "./provenance.js";

import type { Event } from "./entities.js";

/**
 * The temporal truth, carried separately from `sequenceNumber`.
 *
 * Nanosecond values are DECIMAL STRINGS, not `bigint` and not `number`:
 * `bigint` is neither storable in Convex nor serializable to JSON, and `number`
 * cannot hold an epoch-nanosecond value without losing resolution — float64 ULP
 * at a 2026 epoch-nanosecond value (~1.75e18) is 256 ns, so `Number()` collapses
 * any two instants under ~128 ns apart into the same value, manufacturing ties
 * out of genuinely ordered input.
 *
 * Decimal-STRING comparison is equally wrong across differing lengths
 * (`'999999999' > '1750000000000000000'` because `'9' > '1'`), which is why
 * every comparison below goes through `BigInt`.
 */
export interface TemporalOrderKey {
  /** Effective (skew-clamped) instant, epoch nanoseconds, decimal string. */
  instantUnixNano: string;
  /**
   * RAW instant as the emitting process reported it. Differs from
   * `instantUnixNano` iff a clamp was applied — which is what makes a clamp
   * VISIBLE rather than indistinguishable from the data having been that way.
   */
  rawInstantUnixNano: string;
  phase: "open" | "close";
  /** Depth in the reconstructed span tree. -1 for the synthesized run boundary. */
  depth: number;
  spanId: string;
}

function cmpBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The comparator a REPLAY or DIFF projection must use over derived events.
 *
 * The four levels, in order, each for a stated reason:
 *
 *  1. Effective instant, at nanosecond precision.
 *  2. Opens before closes at the same instant — FORCED, not chosen: a
 *     zero-duration child of a parent starting at the same instant would
 *     otherwise have its close ordered before its open.
 *  3. Depth: outside-in for opens, inside-out for closes. This is what turns
 *     (1)+(2) into correct BRACKETING — a parent opens before its child and
 *     closes after it, and when either instant is EQUAL, depth decides.
 *  4. Span id: arbitrary, but TOTAL and STABLE. Ties on timestamp are not an
 *     edge case — fan-out dispatched in one tick shares a start instant
 *     exactly, and millisecond-granularity clocks pad with zeros so spans
 *     genuinely microseconds apart arrive byte-identical. Span ids are unique
 *     within a trace by definition, so lexicographic order is total. It carries
 *     no meaning; it is a STABLE FICTION, which is the most that is available
 *     when the true order is unrecoverable. A tiebreak on ARRAY INDEX would
 *     look deterministic in a single-batch test and would in fact encode the
 *     exporter's flush order, which carries no information at all (a
 *     BatchSpanProcessor flushes by completion, so children normally arrive
 *     before parents).
 */
export function compareTemporalOrder(a: TemporalOrderKey, b: TemporalOrderKey): number {
  const byInstant = cmpBigint(BigInt(a.instantUnixNano), BigInt(b.instantUnixNano));
  if (byInstant !== 0) return byInstant;
  const aPhase = a.phase === "open" ? 0 : 1;
  const bPhase = b.phase === "open" ? 0 : 1;
  if (aPhase !== bPhase) return aPhase - bPhase;
  if (a.depth !== b.depth) return a.phase === "open" ? a.depth - b.depth : b.depth - a.depth;
  return cmpString(a.spanId, b.spanId);
}

// ---------------------------------------------------------------------------
// Reading the key off a stored event
// ---------------------------------------------------------------------------

const DECIMAL_NANOS = /^\d+$/;

/**
 * Structural validation of a stored key.
 *
 * A malformed key is treated as ABSENT rather than trusted. A half-parsed
 * ordering key produces a confidently wrong timeline, which is strictly worse
 * than an admittedly unverified one.
 */
export function isTemporalOrderKey(value: unknown): value is TemporalOrderKey {
  if (typeof value !== "object" || value === null) return false;
  const k = value as Record<string, unknown>;
  if (typeof k["instantUnixNano"] !== "string" || !DECIMAL_NANOS.test(k["instantUnixNano"])) return false;
  if (typeof k["rawInstantUnixNano"] !== "string" || !DECIMAL_NANOS.test(k["rawInstantUnixNano"])) return false;
  if (k["phase"] !== "open" && k["phase"] !== "close") return false;
  if (typeof k["depth"] !== "number" || !Number.isInteger(k["depth"])) return false;
  if (typeof k["spanId"] !== "string") return false;
  return true;
}

/**
 * Reads a stored event's temporal-order key, or `undefined` when it has none.
 *
 * Returns `undefined` for native events BY DESIGN — they have no span and no
 * clamp, and their `sequenceNumber` IS their temporal order.
 *
 * The legacy nested location (`provenance.temporalOrder`) is still probed. The
 * canonical location is the sibling field `event.temporalOrder`; the nested
 * probe costs nothing and keeps a reader that predates the schema column
 * working rather than silently reporting every derived run as unverified.
 */
export function readTemporalOrder(event: Event): TemporalOrderKey | undefined {
  const direct = (event as { temporalOrder?: unknown }).temporalOrder;
  if (isTemporalOrderKey(direct)) return direct;

  const nested = (event.provenance as { temporalOrder?: unknown } | undefined)?.temporalOrder;
  if (isTemporalOrderKey(nested)) return nested;

  return undefined;
}

// ---------------------------------------------------------------------------
// Per-event timing honesty
// ---------------------------------------------------------------------------

/**
 * What an event's timestamp actually IS: measured, or inferred.
 *
 * `timing-approximated` in `provenance.lossReasons` means the instant was
 * CLAMPED or ROUNDED by the mapper, not read from the wire. The mapper clamps
 * parent-child instants so that no causal edge points forward in time — a
 * necessary repair (a child that starts before its parent is unrenderable as a
 * tree, and under an append-only log would give a `parentEventId` pointing at a
 * LATER sequence number) but a repair nonetheless. Rendering the result in the
 * same treatment as a measured timestamp asserts a precision we do not have.
 */
export interface EventTiming {
  /** True when this timestamp was read from the source, not inferred. */
  measured: boolean;
  /** True when the mapper reported `timing-approximated` for this event. */
  approximated: boolean;
  /**
   * True when the effective instant DIFFERS from the raw one — i.e. a clamp was
   * actually applied to this specific event, not merely declared possible.
   * Requires a stored `temporalOrder`; `false` when the key is absent.
   */
  clamped: boolean;
  /** Effective (post-clamp) instant, epoch ns decimal string. Absent without a key. */
  effectiveInstantUnixNano?: string;
  /** Raw instant as the emitting process reported it. Absent without a key. */
  rawInstantUnixNano?: string;
  /**
   * `effective - raw`, epoch nanoseconds, as a decimal string that may carry a
   * leading `-`. Present only when `clamped` is true.
   *
   * SIGN CONVENTION: positive means the event was pushed LATER than the emitter
   * claimed (the usual case — a child clamped forward to its parent's start);
   * negative means it was pulled EARLIER.
   */
  skewNano?: string;
}

/**
 * Classifies one event's timing.
 *
 * Native events are always `measured: true` — the instrumented process reported
 * the instant directly and nothing clamped it.
 */
export function readEventTiming(event: Event): EventTiming {
  const provenance = event.provenance;
  if (!isDerivedProvenance(provenance)) {
    return { measured: true, approximated: false, clamped: false };
  }

  const approximated = declaresApproximation(provenance);
  const key = readTemporalOrder(event);

  if (key === undefined) {
    return { measured: !approximated, approximated, clamped: false };
  }

  const effective = BigInt(key.instantUnixNano);
  const raw = BigInt(key.rawInstantUnixNano);
  const clamped = effective !== raw;

  const timing: EventTiming = {
    measured: !approximated && !clamped,
    approximated,
    clamped,
    effectiveInstantUnixNano: key.instantUnixNano,
    rawInstantUnixNano: key.rawInstantUnixNano,
  };
  if (clamped) timing.skewNano = (effective - raw).toString();
  return timing;
}

function declaresApproximation(provenance: OtelEventProvenance): boolean {
  return (provenance.lossReasons ?? []).includes("timing-approximated");
}

const NANOS_PER_MS = BigInt(1_000_000);
const NANOS_PER_US = BigInt(1_000);

const NANOS_PER_S = NANOS_PER_MS * BigInt(1000);

/**
 * Truncate `abs` nanoseconds into `unit`, keeping THREE SIGNIFICANT DIGITS.
 *
 * Two properties, and the whole design is the tension between them:
 *
 *  - TRUNCATION, never rounding, so the rendered number can never reach the
 *    next unit's threshold. Rounding produced `+1000ms` for 999,999,999 ns
 *    (which is one second) and `+1000.0µs` for 999,999 ns (which is one
 *    millisecond) — a summary that names the wrong order of magnitude.
 *  - FRACTIONAL DIGITS, so truncation does not understate the value. Plain
 *    integer truncation rendered 8,900,000,000 ns as `-8s`, hiding 900 ms of
 *    clock skew at exactly the scale where skew stops being rounding noise and
 *    starts being a broken clock.
 *
 * Three significant digits satisfies both: the digit budget shrinks as the
 * whole part grows, so `8.90s` keeps its tenths and `999ms` (999.999999 ms)
 * stays under 1000 without inventing precision. Everything is BigInt — a
 * float64 cannot hold an epoch-nanosecond value, and this must stay exact.
 */
function truncateToSignificant(abs: bigint, unit: bigint): string {
  const whole = abs / unit;
  const wholeText = whole.toString();
  const fractionDigits = Math.max(0, 3 - wholeText.length);
  if (fractionDigits === 0) return wholeText;
  const scale = BigInt(10) ** BigInt(fractionDigits);
  const fraction = ((abs % unit) * scale) / unit;
  return `${wholeText}.${fraction.toString().padStart(fractionDigits, "0")}`;
}

/**
 * Renders a signed nanosecond delta for a dense, scannable UI cell.
 *
 * Deliberately coarse: an engineer reading a skew value is asking "is this
 * microseconds of rounding, or seconds of a broken clock?", and a 19-digit
 * nanosecond figure answers that worse than `+412ms` does.
 *
 * COARSE IS NOT THE SAME AS UNDERSTATED, which is the distinction two earlier
 * versions of this function each got wrong in opposite directions — one
 * rounding up across a unit boundary, one truncating away the fractional part
 * entirely. Clock skew between an agent and its tools is itself a debugging
 * signal, so a summary that turns 8.9 seconds into `-8s` is understating the
 * very thing the reader opened the cell to see.
 *
 * The exact value is never lost either way: {@link EventTiming.skewNano} and
 * {@link RunOrdering.maxAbsSkewNano} keep full nanosecond precision. This is
 * only the scannable summary — which is also why it is cheap to get right.
 */
export function formatSkew(skewNano: string): string {
  const value = BigInt(skewNano);
  const sign = value < BigInt(0) ? "-" : "+";
  const abs = value < BigInt(0) ? -value : value;
  // Sub-microsecond values are already at most three digits, and a fractional
  // nanosecond does not exist — nanoseconds are the unit of record.
  if (abs < NANOS_PER_US) return `${sign}${abs.toString()}ns`;
  if (abs < NANOS_PER_MS) return `${sign}${truncateToSignificant(abs, NANOS_PER_US)}µs`;
  if (abs < NANOS_PER_S) return `${sign}${truncateToSignificant(abs, NANOS_PER_MS)}ms`;
  return `${sign}${truncateToSignificant(abs, NANOS_PER_S)}s`;
}

// ---------------------------------------------------------------------------
// What a run's rendered order is entitled to claim
// ---------------------------------------------------------------------------

/**
 * Which claim the rendered order of a run's events is entitled to make.
 *
 * - `sequence-native`    — every event was recorded first-party. `sequenceNumber`
 *                          IS temporal order, because the SDK assigned it at the
 *                          moment the event happened. Full confidence, and the
 *                          ONLY basis under which the pre-existing code path
 *                          runs unchanged.
 * - `temporal`           — the run contains derived events and EVERY derived
 *                          event carries a `temporalOrder` key. Ordered by
 *                          {@link compareTemporalOrder}. This is the order things
 *                          happened, to the precision the emitter's clock allows.
 * - `ingest-unverified`  — the run contains derived events and at least one has
 *                          NO ordering key. The only order available is arrival
 *                          order, which for a multi-batch trace is the order the
 *                          collector happened to flush. Rendered, but LABELLED:
 *                          it must not be read as a timeline.
 */
export type OrderingBasis = "sequence-native" | "temporal" | "ingest-unverified";

export interface RunOrdering {
  basis: OrderingBasis;
  /** Count of events whose provenance says `otel`. */
  derivedCount: number;
  /** Count of events that are native (explicitly `sdk`, or provenance absent). */
  nativeCount: number;
  /** Count of derived events carrying a usable `temporalOrder` key. */
  keyedCount: number;
  /** True when the run mixes native and derived events. Rare, but the schema permits it. */
  mixedProvenance: boolean;
  /** Count of events whose provenance declares `timing-approximated`. */
  approximatedCount: number;
  /** Count of events where the effective instant actually differs from the raw one. */
  clampedCount: number;
  /**
   * The largest absolute clamp applied anywhere in the run, as a signed decimal
   * nanosecond string, or `null` when nothing was clamped. This is the number
   * that answers "how far out is this agent's clock from its tools'?".
   */
  maxAbsSkewNano: string | null;
}

/**
 * Inspects a run's event log and decides what its ordering is entitled to claim.
 *
 * Pure, allocation-light, and safe on an empty array (an empty run is
 * `sequence-native` — there is nothing whose order could be wrong).
 */
export function analyzeRunOrdering(events: readonly Event[]): RunOrdering {
  let derivedCount = 0;
  let nativeCount = 0;
  let keyedCount = 0;
  let approximatedCount = 0;
  let clampedCount = 0;
  let maxAbs = BigInt(0);
  let maxAbsSigned: string | null = null;

  for (const event of events) {
    const provenance = event.provenance;
    if (!isDerivedProvenance(provenance)) {
      nativeCount++;
      continue;
    }
    derivedCount++;
    if (declaresApproximation(provenance)) approximatedCount++;

    const key = readTemporalOrder(event);
    if (key === undefined) continue;
    keyedCount++;

    const delta = BigInt(key.instantUnixNano) - BigInt(key.rawInstantUnixNano);
    if (delta === BigInt(0)) continue;
    clampedCount++;
    const abs = delta < BigInt(0) ? -delta : delta;
    if (abs > maxAbs) {
      maxAbs = abs;
      maxAbsSigned = delta.toString();
    }
  }

  const basis: OrderingBasis =
    derivedCount === 0
      ? "sequence-native"
      : keyedCount === derivedCount
        ? "temporal"
        : "ingest-unverified";

  return {
    basis,
    derivedCount,
    nativeCount,
    keyedCount,
    mixedProvenance: derivedCount > 0 && nativeCount > 0,
    approximatedCount,
    clampedCount,
    maxAbsSkewNano: maxAbsSigned,
  };
}

/**
 * Synthesizes a temporal key for an event that has none, so that a MIXED run
 * (native + derived events, which the schema permits even if no ingest path
 * produces one today) still has a TOTAL order rather than two incomparable ones.
 *
 * The instant is the event's own `timestamp`, in epoch milliseconds, scaled to
 * nanoseconds. That is an honest widening: exact at millisecond resolution and
 * claiming no precision below it. `phase: "open"` and `depth: 0` because a
 * native event is an instant, not a span with an extent. The span id is empty,
 * which sorts before every real span id — and the caller's `sequenceNumber`
 * tiebreak makes the result total regardless.
 */
function synthesizeKey(event: Event): TemporalOrderKey {
  const nanos = BigInt(Math.trunc(event.timestamp)) * NANOS_PER_MS;
  const clamped = nanos < BigInt(0) ? "0" : nanos.toString();
  return {
    instantUnixNano: clamped,
    rawInstantUnixNano: clamped,
    phase: "open",
    depth: 0,
    spanId: "",
  };
}

/**
 * Orders a run's events for replay/diff projection.
 *
 * NATIVE RUNS ARE UNTOUCHED. When `basis` is `sequence-native` — which is every
 * run recorded by the first-party SDK — this returns exactly
 * `[...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber)`, the same
 * expression the projection used before temporal ordering existed. The
 * first-party path is not merely "unregressed by inspection"; it takes a
 * physically different branch.
 *
 * `ingest-unverified` ALSO falls back to the sequence sort — but that is not the
 * same statement, and the difference is the whole point. There, arrival order is
 * all that exists, and the caller is expected to render
 * `analyzeRunOrdering(...).basis` so the user is TOLD the order is unverified
 * rather than shown a timeline that is not one. Splicing the unkeyed events in
 * by arrival while temporally ordering the rest would produce a
 * confident-looking timeline that is wrong in an unmarked place, which is worse
 * than either honest option.
 *
 * Final tiebreak on `sequenceNumber` guarantees totality and determinism even
 * if two events somehow produce equal temporal keys.
 */
export function orderEventsForProjection(events: readonly Event[]): Event[] {
  const bySequence = (a: Event, b: Event): number => a.sequenceNumber - b.sequenceNumber;

  if (analyzeRunOrdering(events).basis !== "temporal") {
    return [...events].sort(bySequence);
  }

  const keys = new Map<string, TemporalOrderKey>();
  for (const event of events) {
    keys.set(event.id, readTemporalOrder(event) ?? synthesizeKey(event));
  }

  return [...events].sort((a, b) => {
    const ka = keys.get(a.id);
    const kb = keys.get(b.id);
    if (ka === undefined || kb === undefined) return bySequence(a, b);
    const byTemporal = compareTemporalOrder(ka, kb);
    return byTemporal !== 0 ? byTemporal : bySequence(a, b);
  });
}
