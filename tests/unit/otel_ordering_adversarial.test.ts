/**
 * ADVERSARIAL CONFORMANCE SUITE — OpenTelemetry span -> event-log ordering.
 *
 * WHAT THIS FILE IS
 * A pure, implementation-independent set of cases that attack the single
 * load-bearing claim of any OTel ingest path in this repo: that a CONTIGUOUS,
 * deterministic `sequenceNumber` (Event Log Rule 4 — monotonic integers from 1,
 * contiguous and non-repeating, validated by the backend) can be synthesised
 * from OTel data, which guarantees none of those properties.
 *
 * WHY IT WAS WRITTEN BEFORE THE IMPLEMENTATION
 * Cases derived from an existing implementation encode that implementation's
 * assumptions and pass by construction. Every case below is derived from what
 * the OTLP spec and real exporters actually PERMIT, not from what any mapper
 * happens to do. The suite therefore runs against an injected mapper and is
 * exercised here against two deliberately-naive reference mappers (see
 * `naiveTimeSortMapper` / `lexicographicMapper`) to prove each case has teeth
 * before any real mapper exists.
 *
 * WHY IT MATTERS MORE THAN AN ORDINARY TEST
 * The event log is append-only and immutable (Event Log Rule 1). A mapper bug
 * that emits a duplicate event, or that assigns a DIFFERENT sequence number to
 * the same span on a retry, does not produce a transient wrong answer — it
 * writes permanent corruption into a log that has no update or delete mutation.
 * That asymmetry is the whole reason these cases belong in front of the
 * endpoint rather than behind it.
 *
 * ── INVARIANT CATALOGUE ────────────────────────────────────────────────────
 * Every case declares exactly one primary invariant. A case that does not say
 * which invariant it defends is a case that gets deleted the first time it is
 * inconvenient, so the linkage is structural here (`invariant` field), not
 * prose.
 *
 *   CONTIGUITY    Sequence numbers of a run are exactly 1..N — no gap, no
 *                 repeat. Directly Event Log Rule 4; the backend rejects
 *                 violations, so a breach is an ingest outage.
 *   COMPLETENESS  Every input span is represented. A dropped span is silent
 *                 data loss — the log looks well-formed and is wrong.
 *   DETERMINISM   The same span SET produces byte-identical output regardless
 *                 of arrival order. OTLP makes no ordering promise; the
 *                 exporter flushes in whatever order it flushed.
 *   STABILITY     A given span gets the SAME sequence number on every ingest
 *                 that contains it, including retries and supersets. Distinct
 *                 from DETERMINISM: determinism is about permuting a fixed
 *                 set, stability is about the set changing underneath.
 *   DEDUP         A span delivered twice produces its events once.
 *   CAUSALITY     A parent's opening event precedes its child's opening event,
 *                 and a parent's closing event follows every descendant's —
 *                 regardless of what the wall clocks claim.
 *   APPEND_ONLY   A later batch of the same trace extends the numbering; it
 *                 never renumbers or collides with what is already written.
 *   TERMINAL      `run.started` first, `run.completed`/`run.failed` last
 *                 (Event Log Rule 5).
 *   TENANCY       Spans belonging to another trace are not numbered into this
 *                 run's sequence.
 *   TOTALITY      Adversarial input yields a defined result or a typed error —
 *                 never a throw from deep inside, never a hang, never a stack
 *                 overflow. This is the availability class.
 *
 * ── SEVERITY ───────────────────────────────────────────────────────────────
 *   correctness-fatal   Writes a wrong log. Unrecoverable under immutability.
 *   availability-fatal  Crashes or hangs ingest. Recoverable — data is not yet
 *                       written — but the endpoint is down.
 *   cosmetic            Untidy ordering with no data-integrity consequence.
 */

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Domain model — OTLP as the wire actually delivers it
// ---------------------------------------------------------------------------

/**
 * OTLP/JSON encodes uint64 fixed timestamps as DECIMAL STRINGS, because a
 * nanosecond Unix timestamp in 2026 (~1.75e18) is two orders of magnitude
 * larger than Number.MAX_SAFE_INTEGER (~9.0e15). Modelling it as a string here
 * is not pedantry: it is the trap. See CASE precision/*.
 */
type NanoTs = string

interface OtelSpan {
  traceId: string
  spanId: string
  /** Absent or empty string means "root span". */
  parentSpanId?: string
  name: string
  startTimeUnixNano: NanoTs
  endTimeUnixNano: NanoTs
  attributes?: Record<string, unknown>
  status?: { code: number; message?: string }
}

/**
 * What the mapper must be told about what has ALREADY been written for this
 * run, if it is to extend an append-only log across batches. A mapper that
 * cannot accept this cannot satisfy APPEND_ONLY — see CASE multibatch/*.
 */
interface PriorRunState {
  /** Highest sequenceNumber already durably written for this run. */
  lastSequenceNumber: number
  /** Span ids already mapped into this run, for dedup across batches. */
  knownSpanIds: readonly string[]
}

interface MappedEvent {
  sequenceNumber: number
  type: string
  /** The span this event was derived from, if the mapper reports it. */
  spanId?: string
  /**
   * The event's recorded timestamp, if the mapper reports one. Needed because
   * `apps/web/src/lib/replay/projection.ts` computes
   * `elapsed_ms = event.timestamp - firstTimestamp`, so timestamp order and
   * sequence order are not independent choices downstream.
   */
  timestamp?: number
  /**
   * THE TEMPORAL TRUTH, in epoch nanoseconds. Under the option-(b) ruling
   * `sequenceNumber` is append order and this is when it actually happened, so
   * any case asserting "later in the log but earlier in reality" must read
   * this rather than `timestamp` — `timestamp` is floored to milliseconds and
   * cannot express sub-millisecond ordering at all.
   */
  temporalInstant?: bigint
}

type MapFn = (spans: readonly OtelSpan[], prior?: PriorRunState) => readonly MappedEvent[]

// ---------------------------------------------------------------------------
// Event-kind classification
// ---------------------------------------------------------------------------

/**
 * A span becomes an opening event and (usually) a closing event. Which contract
 * `EventType` a mapper picks is its business — CAUSALITY only cares which side
 * of the span an event represents, so classification is by role, not identity.
 */
const OPENING_TYPES = new Set([
  'run.started',
  'llm.request',
  'tool.call',
  'http.request',
  'retrieval.query',
  'memory.read',
  'memory.write',
  'custom',
  // A span that matched no mapping rule is recorded rather than dropped (see
  // `OtelSpanUnmappedPayload` in contracts). It is a single event standing for
  // the whole span, so it counts as that span's opening and has no closing.
  'otel.span.unmapped',
])

const CLOSING_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'llm.response',
  'llm.error',
  'tool.result',
  'tool.error',
  'http.response',
  'retrieval.result',
])

const TERMINAL_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled'])

// ---------------------------------------------------------------------------
// Span construction
// ---------------------------------------------------------------------------

const TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_TRACE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** Realistic 2026 nanosecond epoch base. Deliberately past MAX_SAFE_INTEGER. */
const BASE_NANOS = 1_750_000_000_000_000_000n

/**
 * One millisecond in nanoseconds. Needed wherever a case asserts on a derived
 * event's `timestamp`, because that field is epoch MILLISECONDS floor-rounded
 * from span nanoseconds — so two spans must be a whole millisecond apart to be
 * distinguishable there at all.
 */
const MS = 1_000_000n

function nanos(offset: bigint | number): NanoTs {
  return String(BASE_NANOS + BigInt(offset))
}

/**
 * W3C requires a span id to be 16 lowercase hex characters, and a mapper is
 * right to reject anything else — so readable labels are encoded to hex rather
 * than used raw. Hex-encoding the label's char codes keeps ids deterministic,
 * collision-free for the labels used here, and still eyeball-decodable in a
 * failure message ('726f6f74…' is 'root').
 */
function spanId(label: string): string {
  let hex = ''
  for (let i = 0; i < label.length && hex.length < 16; i += 1) {
    hex += label.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return hex.padEnd(16, '0').slice(0, 16)
}

function span(init: {
  id: string
  parent?: string
  name?: string
  start: NanoTs
  end: NanoTs
  traceId?: string
}): OtelSpan {
  const base: OtelSpan = {
    traceId: init.traceId ?? TRACE,
    spanId: spanId(init.id),
    name: init.name ?? init.id,
    startTimeUnixNano: init.start,
    endTimeUnixNano: init.end,
  }
  if (init.parent !== undefined) base.parentSpanId = spanId(init.parent)
  return base
}

// ---------------------------------------------------------------------------
// Assertion vocabulary
// ---------------------------------------------------------------------------

/**
 * A stable, order-revealing rendering of a mapper's output. Two runs of a
 * mapper are "byte-identical" iff their fingerprints match. Deliberately
 * includes the sequence number so a shifted-by-one log is not mistaken for an
 * identical one.
 */
function fingerprint(events: readonly MappedEvent[]): string {
  return events
    .map((e) => `${e.sequenceNumber}|${e.type}|${e.spanId ?? '?'}`)
    .join('\n')
}

/** CONTIGUITY: the sequence numbers present are exactly `from`..`from+N-1`. */
function expectContiguous(events: readonly MappedEvent[], from = 1): void {
  const seqs = events.map((e) => e.sequenceNumber)
  const sorted = [...seqs].sort((a, b) => a - b)
  const expected = seqs.map((_, i) => from + i)
  expect(sorted).toEqual(expected)
  expect(new Set(seqs).size).toBe(seqs.length)
  for (const s of seqs) expect(Number.isInteger(s)).toBe(true)
}

function seqsFor(events: readonly MappedEvent[], id: string): number[] {
  return events.filter((e) => e.spanId === spanId(id)).map((e) => e.sequenceNumber)
}

/** Sequence number of a span's opening event, if the mapper emitted one. */
function openingSeq(events: readonly MappedEvent[], id: string): number | undefined {
  const hits = events
    .filter((e) => e.spanId === spanId(id) && OPENING_TYPES.has(e.type))
    .map((e) => e.sequenceNumber)
  return hits.length > 0 ? Math.min(...hits) : undefined
}

/** Sequence number of a span's closing event, if the mapper emitted one. */
function closingSeq(events: readonly MappedEvent[], id: string): number | undefined {
  const hits = events
    .filter((e) => e.spanId === spanId(id) && CLOSING_TYPES.has(e.type))
    .map((e) => e.sequenceNumber)
  return hits.length > 0 ? Math.max(...hits) : undefined
}

/** COMPLETENESS: every listed span produced at least one event. */
function expectRepresented(events: readonly MappedEvent[], ids: readonly string[]): void {
  for (const id of ids) {
    expect(
      seqsFor(events, id).length,
      `span ${id} produced no event — silent data loss`,
    ).toBeGreaterThan(0)
  }
}

/**
 * Deterministic permutations of a batch. For small batches, exhaustive; for
 * larger ones, a fixed family (identity, reverse, rotations, seeded shuffle)
 * that is itself deterministic so a failure reproduces exactly.
 */
function permutationsOf<T>(items: readonly T[]): T[][] {
  if (items.length <= 5) {
    if (items.length <= 1) return [[...items]]
    const out: T[][] = []
    for (let i = 0; i < items.length; i += 1) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)]
      for (const tail of permutationsOf(rest)) out.push([items[i] as T, ...tail])
    }
    return out
  }
  const out: T[][] = [[...items], [...items].reverse()]
  for (let r = 1; r < Math.min(items.length, 5); r += 1) {
    out.push([...items.slice(r), ...items.slice(0, r)])
  }
  // Seeded (LCG) shuffle — reproducible, unlike Math.random.
  const shuffled = [...items]
  let seed = 0x2f6e2b1
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const j = seed % (i + 1)
    const a = shuffled[i] as T
    const b = shuffled[j] as T
    shuffled[i] = b
    shuffled[j] = a
  }
  out.push(shuffled)
  return out
}

/**
 * DETERMINISM: mapping every permutation of `spans` yields identical output.
 * This is the invariant that OTLP most directly threatens — the exporter's
 * flush order is not the trace's order and carries no information.
 */
function expectPermutationInvariant(map: MapFn, spans: readonly OtelSpan[]): void {
  const perms = permutationsOf(spans)
  const first = fingerprint(map(perms[0] as OtelSpan[]))
  for (let i = 1; i < perms.length; i += 1) {
    const got = fingerprint(map(perms[i] as OtelSpan[]))
    expect(
      got,
      `arrival order ${i} produced a different log than arrival order 0 — ` +
        `sequence numbers are not a function of the trace, they are a function ` +
        `of how the exporter happened to flush`,
    ).toBe(first)
  }
}

// ---------------------------------------------------------------------------
// Reference (deliberately naive) mappers — the teeth check
// ---------------------------------------------------------------------------

/**
 * The mapper a competent engineer writes in ten minutes: explode each span into
 * an opening and closing point, sort by numeric timestamp, number 1..N.
 *
 * It is wrong in at least eight distinct ways that this suite must detect. If a
 * case below does NOT detect one of them, the case is decorative.
 */
const naiveTimeSortMapper: MapFn = (spans) => {
  const points: Array<{ ts: number; role: 'open' | 'close'; span: OtelSpan }> = []
  for (const s of spans) {
    points.push({ ts: Number(s.startTimeUnixNano), role: 'open', span: s })
    points.push({ ts: Number(s.endTimeUnixNano), role: 'close', span: s })
  }
  // Array.prototype.sort is stable (ES2019+), so ties silently preserve
  // ARRIVAL order — the exact dependency DETERMINISM forbids.
  points.sort((a, b) => a.ts - b.ts)
  return points.map((p, i) => ({
    sequenceNumber: i + 1,
    type: p.role === 'open' ? 'tool.call' : 'tool.result',
    spanId: p.span.spanId,
    timestamp: p.ts,
    temporalInstant: BigInt(p.role === 'open' ? p.span.startTimeUnixNano : p.span.endTimeUnixNano),
  }))
}

/**
 * The other plausible mistake: "the timestamps are strings, so compare them as
 * strings." Correct for equal-length decimals, catastrophically wrong across
 * lengths — a 1970 timestamp ('999999999') sorts AFTER a 2026 one
 * ('1750000000000000000') because '9' > '1'.
 */
const lexicographicMapper: MapFn = (spans) => {
  const points: Array<{ ts: string; role: 'open' | 'close'; span: OtelSpan }> = []
  for (const s of spans) {
    points.push({ ts: s.startTimeUnixNano, role: 'open', span: s })
    points.push({ ts: s.endTimeUnixNano, role: 'close', span: s })
  }
  points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return points.map((p, i) => ({
    sequenceNumber: i + 1,
    type: p.role === 'open' ? 'tool.call' : 'tool.result',
    spanId: p.span.spanId,
    timestamp: Number(p.ts),
    temporalInstant: BigInt(p.ts),
  }))
}

/**
 * The mapper a GOOD engineer writes once they have seen the clock-skew and
 * tie-determinism failures: build the parent/child forest, walk it depth-first,
 * order siblings by (BigInt start, spanId) so arrival order and float64
 * precision cannot leak in, emit open on entry and close on exit, guard the walk
 * against cycles.
 *
 * This is included NOT as a strawman but as the strongest single-batch design,
 * because the interesting result is what it STILL fails: everything that spans
 * more than one batch, plus the timestamp-monotonicity constraint that fixing
 * causality necessarily breaks. Those failures are properties of the problem,
 * not of the code — which is precisely the finding.
 */
const causalTopologicalMapper: MapFn = (spans) => {
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  const children = new Map<string, OtelSpan[]>()
  const roots: OtelSpan[] = []
  for (const s of spans) {
    const parent = s.parentSpanId
    // Self-parent and dangling parents are treated as roots.
    if (parent === undefined || parent === '' || parent === s.spanId || !byId.has(parent)) {
      roots.push(s)
      continue
    }
    const bucket = children.get(parent)
    if (bucket === undefined) children.set(parent, [s])
    else bucket.push(s)
  }
  const order = (a: OtelSpan, b: OtelSpan): number => {
    const ta = BigInt(a.startTimeUnixNano)
    const tb = BigInt(b.startTimeUnixNano)
    if (ta !== tb) return ta < tb ? -1 : 1
    return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0
  }
  const events: MappedEvent[] = []
  const seen = new Set<string>()
  let seq = 0
  // Explicit stack, not recursion — a 10k-deep chain would blow the JS stack.
  const stack: Array<{ span: OtelSpan; entered: boolean }> = [...roots]
    .sort(order)
    .reverse()
    .map((s) => ({ span: s, entered: false }))
  while (stack.length > 0) {
    const frame = stack.pop() as { span: OtelSpan; entered: boolean }
    if (frame.entered) {
      seq += 1
      events.push({
        sequenceNumber: seq,
        type: 'tool.result',
        spanId: frame.span.spanId,
        timestamp: Number(frame.span.endTimeUnixNano),
        temporalInstant: BigInt(frame.span.endTimeUnixNano),
      })
      continue
    }
    if (seen.has(frame.span.spanId)) continue
    seen.add(frame.span.spanId)
    seq += 1
    events.push({
      sequenceNumber: seq,
      type: 'tool.call',
      spanId: frame.span.spanId,
      timestamp: Number(frame.span.startTimeUnixNano),
      temporalInstant: BigInt(frame.span.startTimeUnixNano),
    })
    stack.push({ span: frame.span, entered: true })
    const kids = [...(children.get(frame.span.spanId) ?? [])].sort(order).reverse()
    for (const k of kids) stack.push({ span: k, entered: false })
  }
  return events
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

type Invariant =
  | 'CONTIGUITY'
  | 'COMPLETENESS'
  | 'DETERMINISM'
  | 'STABILITY'
  | 'DEDUP'
  | 'CAUSALITY'
  | 'APPEND_ONLY'
  | 'TERMINAL'
  | 'TENANCY'
  | 'TOTALITY'
  | 'MONOTONIC_TIME'

type Severity = 'correctness-fatal' | 'availability-fatal' | 'cosmetic'

/**
 * Thrown by the adapter when the mapper REFUSES a batch (returns a typed
 * not-ok result rather than events). Refusal is a legitimate outcome for some
 * invariants and a total failure for others, so it is signalled distinctly
 * rather than collapsed into an ordinary assertion failure — see
 * `refusalIsSound`.
 */
class MapperRefusal extends Error {}

interface AdversarialCase {
  id: string
  /** The single invariant this case defends. */
  invariant: Invariant
  severity: Severity
  /**
   * True when "refuse the batch with a typed error" satisfies this case's
   * invariant. TOTALITY is satisfied by a defined refusal by definition, and a
   * batch mixing two traces may legitimately be rejected whole. It is NOT sound
   * for a well-formed trace: refusing valid input is an availability failure
   * wearing a correctness costume.
   */
  refusalIsSound?: true
  /** What OTel permits that makes this case reachable in production. */
  provenance: string
  /**
   * Which reference mappers this case must reject. A case that catches neither
   * is either trivially satisfied or badly written — the teeth check enforces
   * this, so `catches: []` has to be an explicit, justified choice.
   */
  catches: Array<'naive' | 'lexicographic' | 'causal'>
  run: (map: MapFn) => void
}

const CASES: AdversarialCase[] = [
  // ── Baseline ────────────────────────────────────────────────────────────
  {
    id: 'baseline/contiguous-from-one',
    invariant: 'CONTIGUITY',
    severity: 'correctness-fatal',
    provenance: 'The happy path. If this fails nothing else matters.',
    catches: [],
    run: (map) => {
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'a', parent: 'root', start: nanos(1000), end: nanos(2000) }),
        span({ id: 'b', parent: 'root', start: nanos(3000), end: nanos(4000) }),
      ]
      const events = map(spans)
      expectContiguous(events)
      expectRepresented(events, ['root', 'a', 'b'])
    },
  },

  // ── Timestamp ties ──────────────────────────────────────────────────────
  {
    id: 'ties/identical-start-instant',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'Spans dispatched in the same tick share a start instant exactly. Nothing ' +
      'in OTLP forbids it and instrumented fan-out produces it constantly.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const t = nanos(1000)
      const spans = [
        span({ id: 'p1', start: t, end: nanos(5000) }),
        span({ id: 'p2', start: t, end: nanos(5000) }),
        span({ id: 'p3', start: t, end: nanos(5000) }),
        span({ id: 'p4', start: t, end: nanos(5000) }),
      ]
      expectPermutationInvariant(map, spans)
    },
  },
  {
    id: 'ties/millisecond-clock-granularity',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'Many runtimes source span timestamps from a millisecond clock and pad ' +
      'with zeros. Spans genuinely microseconds apart arrive with byte-identical ' +
      'nanosecond fields, so the real order is unrecoverable — the tiebreak must ' +
      'at least be a STABLE fiction.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const ms = nanos(2_000_000) // whole-millisecond boundary
      const spans = [
        span({ id: 'm1', start: ms, end: nanos(9_000_000) }),
        span({ id: 'm2', start: ms, end: nanos(9_000_000) }),
        span({ id: 'm3', start: ms, end: nanos(9_000_000) }),
      ]
      expectPermutationInvariant(map, spans)
    },
  },
  {
    id: 'ties/tiebreak-is-span-identity-not-arrival-index',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'A tiebreak on array index looks deterministic in a single-batch test and ' +
      'is not deterministic at all. The only arrival-independent tiebreak ' +
      'available is the span id.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const t = nanos(4242)
      const forward = [
        span({ id: 'zz', start: t, end: nanos(8000) }),
        span({ id: 'aa', start: t, end: nanos(8000) }),
      ]
      const reverse = [forward[1] as OtelSpan, forward[0] as OtelSpan]
      expect(fingerprint(map(forward))).toBe(fingerprint(map(reverse)))
    },
  },

  // ── Timestamp precision ─────────────────────────────────────────────────
  {
    id: 'precision/nanos-exceed-float64-safe-range',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'A 2026 nanosecond timestamp is ~1.75e18; float64 ULP there is 256ns. ' +
      'Number() therefore COLLAPSES any two spans less than ~128ns apart into ' +
      'the same value — silently manufacturing ties out of ordered input. The ' +
      'assertion below proves the collapse rather than asserting it from memory.',
    catches: ['naive'],
    run: (map) => {
      const early = nanos(0)
      const late = nanos(100) // 100ns later — genuinely, verifiably ordered
      expect(
        Number(early),
        'precondition: float64 must collapse these two distinct instants',
      ).toBe(Number(late))
      expect(BigInt(early) < BigInt(late)).toBe(true)

      const spans = [
        span({ id: 'early', start: early, end: nanos(1_000_000) }),
        span({ id: 'late', start: late, end: nanos(1_000_000) }),
      ]
      // Whatever order the mapper picks, it must pick the SAME one every time.
      expectPermutationInvariant(map, spans)
    },
  },
  {
    id: 'precision/lexicographic-comparison-inverts-order',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'OTLP delivers uint64 nanos as decimal strings of varying length. A span ' +
      "at t=999999999 (1970) sorts AFTER one at t=1.75e18 (2026) under string " +
      'comparison, because "9" > "1". Absurd clocks are real: unsynced ' +
      'containers and test harnesses emit them.',
    catches: ['lexicographic'],
    run: (map) => {
      const spans = [
        span({ id: 'epoch', start: '999999999', end: '1000000000' }),
        span({ id: 'modern', parent: 'epoch', start: nanos(0), end: nanos(1000) }),
      ]
      const events = map(spans)
      const epochOpen = openingSeq(events, 'epoch')
      const modernOpen = openingSeq(events, 'modern')
      expect(epochOpen).toBeDefined()
      expect(modernOpen).toBeDefined()
      expect(
        (epochOpen as number) < (modernOpen as number),
        'a 1970 timestamp was ordered after a 2026 one — string comparison of ' +
          'variable-length decimals',
      ).toBe(true)
    },
  },

  // ── Clock skew ──────────────────────────────────────────────────────────
  {
    id: 'skew/child-starts-before-its-own-parent',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'Parent and child routinely run in different processes with different ' +
      'clocks. A child legitimately reports a start BEFORE its parent. The ' +
      'parent/child edge is ground truth; the timestamps are not.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const spans = [
        span({ id: 'parent', start: nanos(1_000_000), end: nanos(9_000_000) }),
        // Child's host clock is 500µs behind — it claims to start first.
        span({
          id: 'child',
          parent: 'parent',
          start: nanos(500_000),
          end: nanos(2_000_000),
        }),
      ]
      const events = map(spans)
      const p = openingSeq(events, 'parent')
      const c = openingSeq(events, 'child')
      expect(p).toBeDefined()
      expect(c).toBeDefined()
      expect(
        (p as number) < (c as number),
        'child opened before its own parent in the log — the trace reads as an ' +
          'effect preceding its cause',
      ).toBe(true)
    },
  },
  {
    id: 'skew/parent-closes-before-descendant-closes',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'The mirror of the above: a child reports an end AFTER its parent under ' +
      'skew. A log where a tool returns before its own sub-calls finish is ' +
      'unexplainable, which is the one thing v1 exists to prevent.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const spans = [
        span({ id: 'parent', start: nanos(0), end: nanos(2_000_000) }),
        span({
          id: 'child',
          parent: 'parent',
          start: nanos(100_000),
          end: nanos(2_500_000), // skewed past the parent's end
        }),
      ]
      const events = map(spans)
      const p = closingSeq(events, 'parent')
      const c = closingSeq(events, 'child')
      if (p === undefined || c === undefined) return // single-event mappers exempt
      expect(
        c < p,
        'parent closed before its child — replay shows a call returning before ' +
          'the work it awaited',
      ).toBe(true)
    },
  },

  // ── Concurrency ─────────────────────────────────────────────────────────
  {
    id: 'concurrency/overlapping-siblings-are-a-stable-fiction',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'Parallel tool calls overlap and have no true order. Imposing a total ' +
      'order is unavoidable and fine; imposing a DIFFERENT total order on each ' +
      'ingest of the same trace is not.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const shared = nanos(1000)
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'par1', parent: 'root', start: shared, end: nanos(4000) }),
        span({ id: 'par2', parent: 'root', start: shared, end: nanos(3000) }),
        span({ id: 'par3', parent: 'root', start: shared, end: nanos(5000) }),
      ]
      expectPermutationInvariant(map, spans)
    },
  },
  {
    id: 'concurrency/interleaved-intervals-contiguous',
    invariant: 'CONTIGUITY',
    severity: 'correctness-fatal',
    provenance:
      'Overlapping intervals mean opening and closing events interleave across ' +
      'spans. Numbering that assumes call/result adjacency breaks here.',
    catches: [],
    run: (map) => {
      const spans = [
        span({ id: 'x', start: nanos(100), end: nanos(400) }),
        span({ id: 'y', start: nanos(110), end: nanos(300) }),
        span({ id: 'z', start: nanos(120), end: nanos(500) }),
      ]
      const events = map(spans)
      expectContiguous(events)
      expectRepresented(events, ['x', 'y', 'z'])
    },
  },

  // ── Out-of-order arrival ────────────────────────────────────────────────
  {
    id: 'arrival/shuffled-batch-is-byte-identical',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'OTLP delivers spans in whatever order the exporter flushed. A BatchSpanProcessor ' +
      'flushes by completion, so children (which finish first) arrive before parents ' +
      'in the common case.',
    catches: [],
    run: (map) => {
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'k1', parent: 'root', start: nanos(1000), end: nanos(2000) }),
        span({ id: 'k2', parent: 'root', start: nanos(3000), end: nanos(4000) }),
        span({ id: 'k3', parent: 'k2', start: nanos(3100), end: nanos(3900) }),
      ]
      expectPermutationInvariant(map, spans)
    },
  },
  {
    id: 'arrival/children-flushed-before-parent',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'The DEFAULT OTel export order: a parent span cannot be exported until it ' +
      'ends, so its children are almost always already on the wire. Arrival ' +
      'position must carry zero weight.',
    catches: [],
    run: (map) => {
      const parent = span({ id: 'parent', start: nanos(0), end: nanos(9000) })
      const child = span({
        id: 'child',
        parent: 'parent',
        start: nanos(1000),
        end: nanos(2000),
      })
      const childFirst = fingerprint(map([child, parent]))
      const parentFirst = fingerprint(map([parent, child]))
      expect(childFirst).toBe(parentFirst)
      const events = map([child, parent])
      const p = openingSeq(events, 'parent')
      const c = openingSeq(events, 'child')
      if (p === undefined || c === undefined) return
      expect(p < c).toBe(true)
    },
  },

  // ── Missing parents ─────────────────────────────────────────────────────
  {
    id: 'orphan/parent-never-arrives',
    invariant: 'CONTIGUITY',
    severity: 'availability-fatal',
    provenance:
      'The parent may be dropped, sampled out (parent-based sampling drops the ' +
      'parent and keeps children only in mixed-sampler deployments), or still ' +
      'open. An orphan must not produce a gap and must not crash the walk.',
    catches: [],
    run: (map) => {
      const spans = [
        span({ id: 'known', start: nanos(0), end: nanos(9000) }),
        span({
          id: 'orphan',
          parent: 'ghost', // never in the batch
          start: nanos(1000),
          end: nanos(2000),
        }),
      ]
      const events = map(spans)
      expectContiguous(events)
      expectRepresented(events, ['known', 'orphan'])
    },
  },
  {
    id: 'orphan/placement-is-arrival-independent',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'Reparenting an orphan to the root is fine. Reparenting it to "whatever ' +
      'root we saw first" is not — that is arrival order leaking into the log.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const t = nanos(1000)
      const spans = [
        span({ id: 'rootA', start: nanos(0), end: nanos(9000) }),
        span({ id: 'rootB', start: nanos(0), end: nanos(9000) }),
        span({ id: 'orph1', parent: 'ghost1', start: t, end: nanos(2000) }),
        span({ id: 'orph2', parent: 'ghost2', start: t, end: nanos(2000) }),
      ]
      expectPermutationInvariant(map, spans)
    },
  },

  // ── Duplicates and retries ──────────────────────────────────────────────
  {
    id: 'duplicate/identical-span-twice-in-one-batch',
    invariant: 'DEDUP',
    severity: 'correctness-fatal',
    provenance:
      'OTLP exporters retry on timeout and on 5xx. A retry that races a ' +
      'succeeded-but-unacked request delivers the same span twice, and the ' +
      'collector may fan both into one batch.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const s = span({ id: 'dup', start: nanos(1000), end: nanos(2000) })
      const other = span({ id: 'other', start: nanos(3000), end: nanos(4000) })
      const once = map([s, other])
      const twice = map([s, other, { ...s }])
      expect(
        fingerprint(twice),
        'a duplicated span changed the log. Under an append-only log with no ' +
          'delete mutation, this writes permanent phantom events.',
      ).toBe(fingerprint(once))
      expectContiguous(twice)
    },
  },
  {
    id: 'duplicate/same-span-different-payload',
    invariant: 'DEDUP',
    severity: 'correctness-fatal',
    provenance:
      'Some SDKs export a span twice with differing content (e.g. a later export ' +
      'carries the end time or a status the first lacked). Span id is the only ' +
      'identity available; resolution must not depend on which copy arrived first.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const first = span({ id: 'twice', start: nanos(1000), end: nanos(2000) })
      const second: OtelSpan = {
        ...first,
        endTimeUnixNano: nanos(2500),
        status: { code: 2, message: 'boom' },
      }
      const solo = map([first])
      const forward = map([first, second])
      const reverse = map([second, first])
      expect(
        fingerprint(forward),
        'the winner of a duplicate-span conflict depends on arrival order',
      ).toBe(fingerprint(reverse))
      expect(
        seqsFor(forward, 'twice').length,
        'one span delivered twice produced more events than the same span ' +
          'delivered once — the duplicate was numbered as a second, independent span',
      ).toBe(seqsFor(solo, 'twice').length)
      expectContiguous(forward)
    },
  },
  {
    id: 'retry/superset-must-not-renumber-prior-spans',
    invariant: 'STABILITY',
    severity: 'correctness-fatal',
    provenance:
      'THE central hazard. Ingest 1 sees {A,B}. The exporter retries and the ' +
      'collector coalesces, so ingest 2 sees {A,B,C} where C STARTED EARLIEST. ' +
      'Any position-derived numbering gives A and B new sequence numbers — the ' +
      'immutable log would then hold the same span at two positions, forever. ' +
      'Under the option-(b) ruling the requirement is sharp and achievable: a ' +
      'span already written is NOT re-emitted, and only the genuinely new span ' +
      'is appended, numbered from the run\'s existing maximum. C being the ' +
      'earliest span in the trace does not entitle it to an earlier number.',
    catches: ['naive', 'lexicographic', 'causal'],
    run: (map) => {
      const a = span({ id: 'a', start: nanos(5n * MS), end: nanos(6n * MS) })
      const b = span({ id: 'b', start: nanos(7n * MS), end: nanos(8n * MS) })
      const c = span({ id: 'c', start: nanos(1n * MS), end: nanos(9n * MS) })

      const ingest1 = map([a, b])
      expectContiguous(ingest1)
      const last = Math.max(...ingest1.map((e) => e.sequenceNumber))

      // The retry redelivers a and b and adds c.
      const ingest2 = map([a, b, c], {
        lastSequenceNumber: last,
        knownSpanIds: [a.spanId, b.spanId],
      })

      for (const id of ['a', 'b']) {
        expect(
          seqsFor(ingest2, id),
          `span ${id} was already written, but the retry re-emitted it. Under an ` +
            `append-only log that is a permanent duplicate, not an idempotent retry.`,
        ).toEqual([])
      }
      expect(
        seqsFor(ingest2, 'c').length,
        'the genuinely new span was not appended',
      ).toBeGreaterThan(0)
      expectContiguous(ingest2, last + 1)
    },
  },

  // ── Multi-batch arrival (append-only) ───────────────────────────────────
  {
    id: 'multibatch/second-batch-extends-not-restarts',
    invariant: 'APPEND_ONLY',
    severity: 'correctness-fatal',
    provenance:
      'A long trace arrives across several OTLP requests. Batch 2 must continue ' +
      "the run's numbering. A mapper that cannot ACCEPT prior state cannot do " +
      'this — it will emit sequence 1 again, and `sdkCreateEvents` requires ' +
      'exactly `maxSeq + 1`, so the whole tail of every multi-batch trace is ' +
      'rejected with SEQUENCE_CONFLICT. Under the option-(b) ruling this is the ' +
      'decided contract: numbering continues from the run\'s current maximum.',
    catches: ['naive', 'lexicographic', 'causal'],
    run: (map) => {
      const b1 = [
        span({ id: 'r', start: nanos(0), end: nanos(9000) }),
        span({ id: 'q', parent: 'r', start: nanos(1000), end: nanos(2000) }),
      ]
      const first = map(b1)
      expectContiguous(first)
      const last = Math.max(...first.map((e) => e.sequenceNumber))

      const b2 = [span({ id: 's', parent: 'r', start: nanos(3000), end: nanos(4000) })]
      const second = map(b2, {
        lastSequenceNumber: last,
        knownSpanIds: b1.map((s) => s.spanId),
      })
      expect(
        Math.min(...second.map((e) => e.sequenceNumber)),
        'batch 2 restarted numbering — it will collide with already-written events',
      ).toBe(last + 1)
      expectContiguous(second, last + 1)
    },
  },
  {
    id: 'multibatch/late-earlier-span-appends-and-keeps-temporal-truth',
    invariant: 'APPEND_ONLY',
    severity: 'correctness-fatal',
    provenance:
      'THE IMPOSSIBILITY, INVERTED INTO THE CONTRACT IT FORCED. ' +
      'Batch 1 carries child B (t=200ms). Batch 2 carries its parent A ' +
      '(t=100ms), which belongs BEFORE B in every ordering that respects time ' +
      'or causality. B already occupies its sequence number and Rule 1 provides ' +
      'no renumber. PROOF that no implementation escapes this: seq 1 must be ' +
      '`run.started` (Rule 5), so B takes seq 2; A must precede B temporally; A ' +
      'can only be appended at seq 3; therefore sequence order != temporal ' +
      'order. It is a property of the problem, not of any code. ' +
      'The escapes were rejected for reasons worth keeping: refusing late spans ' +
      'discards evidence PRECISELY in the runs that matter, because late and ' +
      'out-of-order export correlates with crashes, backpressure and timeouts — ' +
      'the very failures this product exists to explain; and buffering until a ' +
      'trace is "complete" cannot close the hole at all, since OTel has no ' +
      'completion signal, so a span arriving after materialization is exactly as ' +
      'unplaceable — it only shrinks the window, at the cost of blinding the ' +
      'flight recorder exactly when engineers reach for it. ' +
      'RULING: option (b). `sequenceNumber` means "the order we learned about ' +
      'this", never "the order it happened". The temporal truth lives in the ' +
      "event's `timestamp` (the span clock), which is why both halves are " +
      'asserted below: append-only survived AND the temporal truth was not lost. ' +
      'Reading this case without the proof above, the next person will conclude ' +
      'the ordering is simply wrong.',
    catches: ['naive', 'lexicographic', 'causal'],
    run: (map) => {
      const b = span({ id: 'bLate', start: nanos(200n * MS), end: nanos(300n * MS) })
      const a = span({ id: 'aParent', start: nanos(100n * MS), end: nanos(400n * MS) })

      const first = map([b])
      const written = seqsFor(first, 'bLate')
      const last = Math.max(...first.map((e) => e.sequenceNumber))

      const second = map([a], { lastSequenceNumber: last, knownSpanIds: [b.spanId] })

      // HALF ONE — append-only survived.
      expect(
        seqsFor(second, 'bLate'),
        'the late batch re-emitted or renumbered an already-written span',
      ).toEqual([])
      expect(seqsFor(second, 'aParent').length, 'the late span was dropped').toBeGreaterThan(0)
      for (const e of second) {
        expect(
          e.sequenceNumber,
          'the late batch reused a sequence number that is already written — the ' +
            'backend rejects it, or worse, accepts it and the run is corrupt',
        ).toBeGreaterThan(last)
      }
      expectContiguous(second, last + 1)

      // HALF TWO — the temporal truth was not lost. A is LATER in sequence and
      // must still be EARLIER in recorded time; that is the whole point of
      // option (b), and without this half the ruling would just be data loss
      // with extra steps.
      const aStamps = second
        .filter((e) => e.spanId === spanId('aParent') && typeof e.timestamp === 'number')
        .map((e) => e.timestamp as number)
      const bStamps = [...first, ...written.map(() => undefined)]
        .filter(
          (e): e is MappedEvent =>
            e !== undefined && e.spanId === spanId('bLate') && typeof e.timestamp === 'number',
        )
        .map((e) => e.timestamp as number)
      if (aStamps.length === 0 || bStamps.length === 0) return // no timestamps reported
      expect(
        Math.min(...aStamps) < Math.min(...bStamps),
        'the late span was appended (good) but its recorded timestamp does not ' +
          'place it earlier than the span it followed. Sequence order was ' +
          'sacrificed AND temporal order was lost — the worst of both options.',
      ).toBe(true)
    },
  },
  {
    id: 'multibatch/replayed-batch-is-idempotent',
    invariant: 'DEDUP',
    severity: 'correctness-fatal',
    provenance:
      'The collector redelivers batch 1 after batch 2 was written. Every span in ' +
      'it is already known. Under the option-(b) ruling idempotency is the ' +
      "mapper's responsibility, and the rule is: the same span in the same run " +
      'yields the same event, always. The correct output here is nothing at all.',
    catches: ['naive', 'lexicographic', 'causal'],
    run: (map) => {
      const b1 = [
        span({ id: 'i1', start: nanos(0), end: nanos(1n * MS) }),
        span({ id: 'i2', start: nanos(2n * MS), end: nanos(3n * MS) }),
      ]
      const first = map(b1)
      const last = Math.max(...first.map((e) => e.sequenceNumber))
      const prior = {
        lastSequenceNumber: last,
        knownSpanIds: b1.map((s) => s.spanId),
      }
      const redelivered = map(b1, prior)
      expect(
        redelivered.length,
        'a redelivered batch produced fresh events — every OTLP retry ' +
          'permanently doubles the run',
      ).toBe(0)
      // "Always" means always: redelivering twice more must stay empty, and must
      // not depend on how many times the collector has already tried.
      expect(map(b1, prior).length).toBe(0)
      expect(map([...b1].reverse(), prior).length).toBe(0)
    },
  },

  // ── Terminal events ─────────────────────────────────────────────────────
  {
    id: 'terminal/run-started-first-terminal-last',
    invariant: 'TERMINAL',
    severity: 'correctness-fatal',
    provenance:
      'Event Log Rule 5. OTel has no notion of a run boundary, so the mapper must ' +
      'synthesise one. A trace whose root span is not first, or whose terminal ' +
      'event is not last, is rejected or renders as permanently in-progress.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'w', parent: 'root', start: nanos(1000), end: nanos(2000) }),
      ]
      const events = [...map(spans)].sort((x, y) => x.sequenceNumber - y.sequenceNumber)
      expect(events.length).toBeGreaterThan(0)
      expect(
        events[0]?.type,
        'the first event of the run is not run.started',
      ).toBe('run.started')
      expect(
        TERMINAL_TYPES.has(events[events.length - 1]?.type ?? ''),
        'the last event of the run is not a terminal event — the run reads as ' +
          'in-progress forever',
      ).toBe(true)
    },
  },

  // ── Sequence order vs. recorded time ────────────────────────────────────
  {
    id: 'replay/timestamp-non-decreasing-along-sequence',
    invariant: 'MONOTONIC_TIME',
    severity: 'correctness-fatal',
    provenance:
      'This case exists to make a TENSION executable, not to demand a fix. ' +
      '`apps/web/src/lib/replay/projection.ts` computes ' +
      '`elapsed_ms = event.timestamp - firstTimestamp` and derives run duration ' +
      'from first/last. An event that is later in sequence but earlier in time ' +
      'therefore renders a NEGATIVE elapsed_ms. But under clock skew, ordering ' +
      'a child after its parent (CASE skew/child-starts-before-its-own-parent) ' +
      'GUARANTEES exactly that inversion. Both invariants cannot hold on skewed ' +
      'input. The only escape is clamping a span timestamp to its parent, which ' +
      'falsifies recorded data and must therefore set ' +
      "`provenance.lossy` with the `timing-approximated` reason " +
      '(`packages/contracts/src/provenance.ts`). Whichever way this is resolved, ' +
      'it must be resolved deliberately.',
    catches: ['causal'],
    run: (map) => {
      const spans = [
        span({ id: 'parent', start: nanos(1_000_000), end: nanos(9_000_000) }),
        span({
          id: 'child',
          parent: 'parent',
          start: nanos(500_000), // child's host clock runs behind
          end: nanos(2_000_000),
        }),
      ]
      const events = [...map(spans)].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      const stamped = events.filter((e) => typeof e.timestamp === 'number')
      if (stamped.length < 2) return // mapper reports no timestamps; nothing to check
      for (let i = 1; i < stamped.length; i += 1) {
        expect(
          (stamped[i]?.timestamp as number) >= (stamped[i - 1]?.timestamp as number),
          `event at sequence ${stamped[i]?.sequenceNumber} carries an earlier ` +
            `timestamp than the event before it — replay will render a negative ` +
            `elapsed_ms for it`,
        ).toBe(true)
      }
    },
  },

  // ── Tenancy / batching hygiene ──────────────────────────────────────────
  {
    id: 'tenancy/foreign-trace-not-numbered-into-this-run',
    refusalIsSound: true,
    invariant: 'TENANCY',
    severity: 'correctness-fatal',
    provenance:
      'One OTLP ExportTraceServiceRequest legitimately carries spans from MANY ' +
      'traces — that is the point of a batch processor. Spans of another trace ' +
      "must not consume sequence numbers in this trace's run, nor appear in it.",
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const mine = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'mine1', parent: 'root', start: nanos(1000), end: nanos(2000) }),
      ]
      const foreign = span({
        id: 'foreign',
        traceId: OTHER_TRACE,
        start: nanos(1500),
        end: nanos(1600),
      })
      const clean = map(mine)
      const mixed = map([...mine, foreign])
      expect(
        fingerprint(mixed),
        "a span from another trace was interleaved into this run's sequence",
      ).toBe(fingerprint(clean))
    },
  },

  // ── Adversarial / malformed input ───────────────────────────────────────
  {
    id: 'adversarial/end-before-start',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'Negative duration is produced by NTP step-backs mid-span and by ' +
      'hand-written instrumentation. A span whose closing event precedes its ' +
      'own opening event is not a rendering problem — it is a log that cannot be ' +
      'replayed.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const spans = [
        span({ id: 'sane', start: nanos(0), end: nanos(9000) }),
        span({ id: 'backwards', start: nanos(5000), end: nanos(1000) }),
      ]
      const events = map(spans)
      expectContiguous(events)
      const open = openingSeq(events, 'backwards')
      const close = closingSeq(events, 'backwards')
      if (open === undefined || close === undefined) return
      expect(
        open < close,
        'a span closed before it opened — negative duration was propagated ' +
          'straight into sequence order',
      ).toBe(true)
    },
  },
  {
    id: 'adversarial/unfinished-span-zero-end-time',
    invariant: 'CAUSALITY',
    severity: 'correctness-fatal',
    provenance:
      'endTimeUnixNano = 0 means "unset" on the wire and appears for still-open ' +
      'spans and buggy exporters. Treated as a timestamp it sorts to the very ' +
      'front of the run — a tool result before the run began.',
    catches: ['naive'],
    run: (map) => {
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'open', parent: 'root', start: nanos(1000), end: '0' }),
      ]
      const events = map(spans)
      expectContiguous(events)
      const open = openingSeq(events, 'open')
      const close = closingSeq(events, 'open')
      if (open === undefined || close === undefined) return
      expect(
        open < close,
        'an unset end time (0) sorted the closing event to the front of the run',
      ).toBe(true)
    },
  },
  {
    id: 'adversarial/span-is-its-own-parent',
    refusalIsSound: true,
    invariant: 'TOTALITY',
    severity: 'availability-fatal',
    provenance:
      'Nothing in the OTLP wire format forbids parentSpanId == spanId. A naive ' +
      'ancestor walk loops forever and takes ingest down for every tenant.',
    catches: [],
    run: (map) => {
      const self = span({ id: 'self', start: nanos(1000), end: nanos(2000) })
      self.parentSpanId = self.spanId
      const events = map([span({ id: 'root', start: nanos(0), end: nanos(9000) }), self])
      expectContiguous(events)
      expectRepresented(events, ['self'])
    },
  },
  {
    id: 'adversarial/cycle-in-parent-chain',
    refusalIsSound: true,
    invariant: 'TOTALITY',
    severity: 'availability-fatal',
    provenance:
      'A -> B -> C -> A. Impossible in a well-behaved tracer, trivially ' +
      'constructible by a hostile or broken client posting raw OTLP. ' +
      'The trap this case exists to catch is NOT the infinite loop, which is ' +
      'obvious and which everyone guards. It is what the guard turns into: ' +
      'every span in a cycle has a parent present in the batch, so NO span in ' +
      'the cycle qualifies as a root, and a forest walk never reaches any of ' +
      'them. The spans are then silently DROPPED — an availability defect traded ' +
      'for a correctness one, which is strictly worse under an append-only log ' +
      'because the missing spans can never be added later. `catches: causal` ' +
      'below is load-bearing: the reference mapper has exactly this bug, on ' +
      'purpose, because it is the natural thing to write.',
    catches: ['causal'],
    run: (map) => {
      const spans = [
        span({ id: 'cycA', parent: 'cycC', start: nanos(1000), end: nanos(4000) }),
        span({ id: 'cycB', parent: 'cycA', start: nanos(2000), end: nanos(3000) }),
        span({ id: 'cycC', parent: 'cycB', start: nanos(1500), end: nanos(3500) }),
      ]
      const events = map(spans)
      expectContiguous(events)
      expectRepresented(events, ['cycA', 'cycB', 'cycC'])
    },
  },
  {
    id: 'adversarial/deep-parent-chain-10k',
    refusalIsSound: true,
    invariant: 'TOTALITY',
    severity: 'availability-fatal',
    provenance:
      'A 10,000-deep chain is reachable from a recursive agent. Any recursive ' +
      'tree walk blows the JS stack — RangeError inside a Convex mutation, and ' +
      'the whole batch is lost.',
    catches: [],
    run: (map) => {
      const spans: OtelSpan[] = []
      for (let i = 0; i < 10_000; i += 1) {
        spans.push(
          span({
            id: `d${i}`,
            ...(i > 0 ? { parent: `d${i - 1}` } : {}),
            start: nanos(i),
            end: nanos(20_000 - i),
          }),
        )
      }
      const events = map(spans)
      expectContiguous(events)
      expect(events.length).toBeGreaterThanOrEqual(spans.length)
    },
  },
  {
    id: 'scale/10k-spans-with-heavy-ties',
    invariant: 'CONTIGUITY',
    severity: 'correctness-fatal',
    provenance:
      'A realistic large trace: 10k spans across 100 distinct instants, so ~100 ' +
      'spans share every timestamp. Ties at scale are where an O(n^2) tiebreak ' +
      'or an unstable sort shows up.',
    catches: [],
    run: (map) => {
      const spans: OtelSpan[] = [span({ id: 'root', start: nanos(0), end: nanos(999_999) })]
      for (let i = 0; i < 10_000; i += 1) {
        spans.push(
          span({
            id: `w${i}`,
            parent: 'root',
            start: nanos(1000 + (i % 100)),
            end: nanos(2000 + (i % 100)),
          }),
        )
      }
      const events = map(spans)
      expectContiguous(events)
      expect(new Set(events.map((e) => e.sequenceNumber)).size).toBe(events.length)
    },
  },
  {
    id: 'scale/10k-spans-with-ties-is-deterministic',
    invariant: 'DETERMINISM',
    severity: 'correctness-fatal',
    provenance:
      'The same 10k-span trace, reversed. At this scale a tiebreak that is ' +
      'accidentally arrival-dependent produces a completely different log while ' +
      'still looking perfectly contiguous — the failure mode that survives ' +
      'review.',
    catches: ['naive', 'lexicographic'],
    run: (map) => {
      const spans: OtelSpan[] = []
      for (let i = 0; i < 2_000; i += 1) {
        spans.push(
          span({
            id: `t${i}`,
            start: nanos(1000 + (i % 50)),
            end: nanos(2000 + (i % 50)),
          }),
        )
      }
      expect(fingerprint(map(spans))).toBe(fingerprint(map([...spans].reverse())))
    },
  },
  {
    id: 'adversarial/empty-batch',
    refusalIsSound: true,
    invariant: 'TOTALITY',
    severity: 'availability-fatal',
    provenance:
      'An OTLP request with zero spans is legal and collectors send them. ' +
      'Math.max() of an empty list is -Infinity; that lands in a schema field.',
    catches: [],
    run: (map) => {
      const events = map([])
      expect(Array.isArray(events)).toBe(true)
      for (const e of events) expect(Number.isInteger(e.sequenceNumber)).toBe(true)
    },
  },
  {
    id: 'adversarial/absurd-timestamps',
    refusalIsSound: true,
    invariant: 'TOTALITY',
    severity: 'availability-fatal',
    provenance:
      'uint64 max (~year 2554), zero, and a value past float64 range all arrive ' +
      'from broken clients. None may crash the mapper or break contiguity.',
    catches: [],
    run: (map) => {
      const spans = [
        span({ id: 'root', start: nanos(0), end: nanos(9000) }),
        span({ id: 'max', parent: 'root', start: '18446744073709551615', end: '18446744073709551615' }),
        span({ id: 'zero', parent: 'root', start: '0', end: '0' }),
      ]
      const events = map(spans)
      expectContiguous(events)
      expectRepresented(events, ['max', 'zero'])
    },
  },
]

// ---------------------------------------------------------------------------
// Teeth check — every case must reject the naive references it claims to
// ---------------------------------------------------------------------------

const REFERENCES: Record<'naive' | 'lexicographic' | 'causal', MapFn> = {
  naive: naiveTimeSortMapper,
  lexicographic: lexicographicMapper,
  causal: causalTopologicalMapper,
}

describe('otel ordering — the cases have teeth', () => {
  it('every case declares an invariant and a provenance', () => {
    for (const c of CASES) {
      expect(c.invariant, `${c.id} has no invariant`).toBeTruthy()
      expect(c.provenance.length, `${c.id} has no provenance`).toBeGreaterThan(20)
    }
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length)
  })

  /**
   * THE HEADLINE RESULT, pinned as an assertion.
   *
   * `causalTopologicalMapper` is the strongest mapper that can be written
   * against a SINGLE batch: correct parent/child order, BigInt timestamps,
   * span-id tiebreak, cycle-guarded, iterative. It passes every ordering,
   * skew, tie, precision, orphan and scale case in this suite. What it still
   * fails sorts into three groups, and the distinction is the whole point:
   *
   * STRUCTURALLY IMPOSSIBLE — no implementation fixes these while Rules 1+4
   * both hold. They are the reason this suite exists.
   *   - multibatch/late-earlier-span-appends-and-keeps-temporal-truth
   *   - retry/superset-must-not-renumber-prior-spans
   *   - replay/timestamp-non-decreasing-along-sequence  (fails BECAUSE the
   *     mapper gets causality right; the two cannot both hold under skew)
   *
   * SOLVABLE, BUT ONLY WITH STATE THIS MAPPER IS NOT GIVEN — they need prior
   * run state and a span-keyed dedupe index (ADR-007 C1/C2, neither landed).
   *   - multibatch/second-batch-extends-not-restarts
   *   - multibatch/replayed-batch-is-idempotent
   *
   * PLAIN BUGS the suite caught in a mapper that looked correct:
   *   - adversarial/cycle-in-parent-chain — every span in a cycle has a parent
   *     present in the batch, so NO span in the cycle qualifies as a root and
   *     the forest walk never reaches it. The cycle guard prevents the hang and
   *     the spans are silently DROPPED instead. Availability defect traded for
   *     a correctness one, which is the worse of the two under Rule 1.
   *   - terminal/run-started-first-terminal-last, and
   *     tenancy/foreign-trace-not-numbered-into-this-run — simply not
   *     implemented here; both are ordinary work, listed so the matrix is
   *     complete rather than curated.
   *
   * If this list ever shrinks, someone has solved something real and the
   * finding should be revisited. If it grows, a regression was introduced.
   */
  const CAUSAL_KNOWN_FAILURES: string[] = [
    'adversarial/cycle-in-parent-chain',
    'multibatch/late-earlier-span-appends-and-keeps-temporal-truth',
    'multibatch/replayed-batch-is-idempotent',
    'multibatch/second-batch-extends-not-restarts',
    'replay/timestamp-non-decreasing-along-sequence',
    'retry/superset-must-not-renumber-prior-spans',
    'tenancy/foreign-trace-not-numbered-into-this-run',
    'terminal/run-started-first-terminal-last',
  ]

  it('the strongest single-batch mapper still fails exactly the cross-batch and time-vs-causality cases', () => {
    const failed = CASES.filter((c) => {
      try {
        c.run(causalTopologicalMapper)
        return false
      } catch {
        return true
      }
    }).map((c) => c.id)
    expect(failed.sort()).toEqual([...CAUSAL_KNOWN_FAILURES].sort())
  })

  for (const c of CASES) {
    for (const ref of c.catches) {
      it(`${c.id} rejects the ${ref} reference mapper`, () => {
        let threw = false
        try {
          c.run(REFERENCES[ref])
        } catch {
          threw = true
        }
        expect(
          threw,
          `case ${c.id} claims to catch the ${ref} mapper but passed it. ` +
            `Either the case is decorative or the reference is not naive enough.`,
        ).toBe(true)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Binding to the implementation under attack
// ---------------------------------------------------------------------------

/**
 * The mapper lives in `convex/helpers/otel_mapping.ts` (Team A). It is loaded
 * dynamically, by a NON-LITERAL specifier, on purpose:
 *
 *   - a static import of a module that does not exist yet fails collection for
 *     the whole file, and these cases are meant to be authored and reviewed
 *     BEFORE the implementation lands;
 *   - a non-literal specifier keeps the module out of `tests/tsconfig.json`'s
 *     program, so this file does not need an entry in
 *     `tests/tsconfig.convex-seam.json` (which exists to trade away
 *     `exactOptionalPropertyTypes` for Convex types — a trade this file does
 *     not need to make, since it type-imports nothing from `convex/`).
 *
 * The export name is probed rather than assumed, again because the cases were
 * written first. If the module is absent the suite reports SKIPPED rather than
 * failing — a red suite for "not built yet" trains people to ignore red.
 */
const MODULE_SPECIFIER = '../../convex/helpers/otel_mapping.js'

const CANDIDATE_EXPORTS = [
  'mapOtelSpansToEvents',
  'mapTraceToEvents',
  'mapOtelTraceToEvents',
  'mapSpansToEvents',
  'otelSpansToEvents',
  'buildEventsFromSpans',
  'mapOtelBatch',
  'mapSpans',
]

interface Binding {
  map: MapFn
  exportName: string
}

/**
 * OTLP/proto encodes span status as an enum (0 unset, 1 ok, 2 error) while the
 * mapper's input type takes the string form. Translating wire representation to
 * the callee's input type is the adapter's job; bending the SCENARIOS to suit
 * the implementation is not, and is not done anywhere in this file.
 */
const STATUS_CODES = ['unset', 'ok', 'error'] as const

/** Wire spans, translated to the mapper's input type. */
function toSpanInput(s: OtelSpan): Record<string, unknown> {
  const out: Record<string, unknown> = {
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    startTimeUnixNano: s.startTimeUnixNano,
    endTimeUnixNano: s.endTimeUnixNano,
  }
  if (s.parentSpanId !== undefined) out.parentSpanId = s.parentSpanId
  if (s.attributes !== undefined) out.attributes = s.attributes
  if (s.status !== undefined) {
    out.status = {
      code: STATUS_CODES[s.status.code] ?? 'unset',
      ...(s.status.message !== undefined ? { message: s.status.message } : {}),
    }
  }
  return out
}

/**
 * PRIOR-STATE SEAM. Under the option-(b) ruling the mapper must accept what is
 * already written for the run, so it can number from the run's current maximum
 * and suppress spans it has already emitted. `mapOtelSpansToEvents(spans,
 * options)` takes exactly that as `MapOptions extends PriorRunState`.
 *
 * Both call shapes are supported because the module exports two entry points —
 * the positional one above and `mapTraceToEvents({ spans, ... })` — and which
 * one `CANDIDATE_EXPORTS` resolves to is not something this file should be
 * brittle about. The result is normalized identically either way.
 */
function bindMapper(fn: (...args: unknown[]) => unknown): MapFn {
  return (spans, prior) => {
    const options: Record<string, unknown> = { receivedAt: 1_750_000_000_000 }
    if (prior !== undefined) {
      options.lastSequenceNumber = prior.lastSequenceNumber
      options.knownSpanIds = prior.knownSpanIds
    }
    const spanInputs = spans.map(toSpanInput)

    let raw: Record<string, unknown> | undefined
    try {
      raw = fn(spanInputs, options) as Record<string, unknown> | undefined
    } catch {
      raw = undefined
    }
    if (raw === undefined || !Array.isArray(raw.events)) {
      // Object-input entry point.
      raw = fn({ ...options, spans: spanInputs }) as Record<string, unknown> | undefined
    }

    if (raw !== undefined && raw.ok === false) {
      const diags = Array.isArray(raw.diagnostics) ? raw.diagnostics : []
      throw new MapperRefusal(
        `mapper refused the batch: ${diags
          .map((d) => String((d as { code?: unknown }).code))
          .join(', ')}`,
      )
    }
    return normalize(raw)
  }
}

async function loadTeamAMapper(): Promise<Binding | undefined> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(MODULE_SPECIFIER)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const name =
    CANDIDATE_EXPORTS.find((n) => typeof mod[n] === 'function') ??
    Object.keys(mod).find(
      (n) => typeof mod[n] === 'function' && /span|otel|event/i.test(n) && /map|build|to/i.test(n),
    )
  if (name === undefined) return undefined

  return { map: bindMapper(mod[name] as (...args: unknown[]) => unknown), exportName: name }
}

/**
 * Team A's return shape is theirs to choose. Anything that carries a sequence
 * number and a type is accepted; the span attribution is read from whichever of
 * the plausible field names is present, because CAUSALITY cases need to know
 * which span an event came from and a mapper that reports NO attribution cannot
 * be checked for it at all (those assertions self-exempt above).
 */
function normalize(raw: unknown): MappedEvent[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { events?: unknown }).events)
      ? ((raw as { events: unknown[] }).events)
      : []
  return list.map((item) => {
    const rec = (item ?? {}) as Record<string, unknown>
    const prov = (rec.provenance ?? {}) as Record<string, unknown>
    const attrs = (rec.attributes ?? rec.payload ?? {}) as Record<string, unknown>
    const spanRef =
      rec.spanId ??
      rec.sourceSpanId ??
      rec.otelSpanId ??
      prov.spanId ??
      attrs.spanId ??
      attrs['otel.span_id']
    const event: MappedEvent = {
      sequenceNumber: Number(rec.sequenceNumber ?? rec.sequence_number ?? NaN),
      type: String(rec.type ?? rec.eventType ?? ''),
    }
    if (typeof spanRef === 'string') event.spanId = spanRef
    if (typeof rec.timestamp === 'number') event.timestamp = rec.timestamp
    const temporal = (rec.temporalOrder ?? {}) as Record<string, unknown>
    if (typeof temporal.instantUnixNano === 'string') {
      event.temporalInstant = BigInt(temporal.instantUnixNano)
    }
    return event
  })
}

const binding = await loadTeamAMapper()

describe.skipIf(binding === undefined)(
  'otel ordering — adversarial cases against convex/helpers/otel_mapping',
  () => {
    /**
     * PRIOR-RUN-STATE REGRESSION GUARD.
     *
     * Accepting prior state is the mechanism the whole option-(b) ruling rests
     * on: without it a mapper cannot number from the run's current maximum and
     * cannot suppress spans it has already emitted, so every multi-batch trace
     * either collides with written events or duplicates them. Four cases below
     * depend on it. If it is ever removed those four would fail with confusing,
     * scattered messages; this asserts the capability directly so the cause is
     * named once, here.
     */
    it('the mapper numbers from prior run state (the mechanism option (b) rests on)', () => {
      if (binding === undefined) return
      const events = binding.map([span({ id: 'probe', start: nanos(0), end: nanos(MS) })], {
        lastSequenceNumber: 10,
        knownSpanIds: [],
      })
      expect(events.length).toBeGreaterThan(0)
      expect(
        Math.min(...events.map((e) => e.sequenceNumber)),
        'the mapper ignored prior run state and restarted numbering — every ' +
          'batch after the first will collide with already-written events',
      ).toBe(11)
    })

    /**
     * ANTI-VACUITY GUARD.
     *
     * Several assertions self-exempt when the mapper reports no span
     * attribution or no temporal instant — necessary, because a mapper that
     * does not report them cannot be checked on them. But a self-exempting
     * assertion that silently stops running is precisely how an adversarial
     * suite rots into decoration. In particular, half two of
     * `multibatch/late-earlier-span-appends-and-keeps-temporal-truth` — the
     * half that proves the temporal truth survived option (b) — is vacuous
     * without `temporalOrder`. So the presence of both is asserted directly.
     */
    it('the mapper reports span attribution and a temporal instant, so no case is silently vacuous', () => {
      if (binding === undefined) return
      const events = binding.map([
        span({ id: 'root', start: nanos(0), end: nanos(9n * MS) }),
        span({ id: 'kid', parent: 'root', start: nanos(1n * MS), end: nanos(2n * MS) }),
      ])
      expect(events.length).toBeGreaterThan(0)
      expect(
        events.every((e) => typeof e.spanId === 'string' && e.spanId.length > 0),
        'events carry no span attribution — every CAUSALITY case self-exempts',
      ).toBe(true)
      expect(
        events.every((e) => typeof e.temporalInstant === 'bigint'),
        'events carry no temporalOrder.instantUnixNano — the half of the ' +
          'late-span case that proves temporal truth survived is now vacuous',
      ).toBe(true)
    })

    for (const c of CASES) {
      it(`[${c.invariant}/${c.severity}] ${c.id}`, () => {
        if (binding === undefined) return
        try {
          c.run(binding.map)
        } catch (err) {
          if (err instanceof MapperRefusal && c.refusalIsSound === true) return
          throw err
        }
      })
    }
  },
)

if (binding === undefined) {
  describe('otel ordering — implementation not present', () => {
    it('reports that convex/helpers/otel_mapping is not yet loadable', () => {
      // Not a failure: the cases are deliberately authored ahead of the mapper.
      // When the module lands and exports a recognised mapper, the suite above
      // switches on automatically with no edit here.
      expect(binding).toBeUndefined()
    })
  })
}
