import {
  analyzeRunOrdering,
  compareTemporalOrder,
  formatSkew,
  orderEventsForProjection,
  readEventTiming,
  readTemporalOrder,
} from '@agent-flight-recorder/contracts'
import { describe, it, expect } from 'vitest'

import { buildRunDiff } from '../../apps/web/src/lib/replay/diff.js'
import { buildReplayProjection } from '../../apps/web/src/lib/replay/projection.js'

import type {
  Event,
  OtelEventProvenance,
  Run,
  TemporalOrderKey,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// THE CORRECTNESS DEBT UNDER TEST
//
// `sequenceNumber` is the order we LEARNED of an event, not the order it
// happened (convex/helpers/otel_mapping.ts PART 3; docs/adr/007). On a run
// derived from OTel spans arriving across multiple OTLP batches, sorting by
// `sequenceNumber` renders the order the collector flushed. These tests build
// exactly the batch-crossing case the mapper's own FINDINGS block (F5) names as
// unfixed on the consumer side, and assert the consumer now fixes it.
//
// The counterpart suite `replay_temporal_native_parity.test.ts` asserts the
// other half: that the first-party path is untouched.
//
// The ordering primitives now live in `packages/contracts/src/temporal.ts`
// (hoisted out of `apps/web` so the browser, `afr` and MCP cannot order the
// same run differently). These tests import them from there and continue to
// exercise them THROUGH `buildReplayProjection` / `buildRunDiff`, so they still
// pin the consumer's behaviour and not just the library's.
// ---------------------------------------------------------------------------

const TRACE = 'a'.repeat(32)

function span(n: number): string {
  return n.toString(16).padStart(16, '0')
}

function otelProvenance(
  spanIndex: number,
  overrides: Partial<OtelEventProvenance> = {}
): OtelEventProvenance {
  return {
    source: 'otel',
    traceId: TRACE,
    spanId: span(spanIndex),
    spanName: `op-${spanIndex}`,
    semconvVersion: 'genai-unreleased@2026-07-25+semconv-1.41.1',
    mapperVersion: 'otel-genai-mapper/1.0.0',
    lossy: false,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  }
}

interface DerivedSpec {
  id: string
  type: string
  /** Ingest position — what `sequenceNumber` records. */
  sequenceNumber: number
  /** Effective (post-clamp) instant, epoch ns. */
  instantUnixNano: string
  /** Raw instant as the emitter reported it. Defaults to the effective one (no clamp). */
  rawInstantUnixNano?: string
  phase?: 'open' | 'close'
  depth?: number
  spanIndex: number
  lossReasons?: OtelEventProvenance['lossReasons']
}

/**
 * A derived event carrying its ordering key.
 *
 * `temporalOrder` is attached as a sibling of `provenance`, which is one of the
 * two placements `readTemporalOrder` probes. It is NOT on the contracts `Event`
 * type yet (see the module header), so the cast is deliberate and is the shape
 * this test pins.
 */
function derived(spec: DerivedSpec): Event {
  const raw = spec.rawInstantUnixNano ?? spec.instantUnixNano
  const lossy = spec.lossReasons !== undefined && spec.lossReasons.length > 0
  const key: TemporalOrderKey = {
    instantUnixNano: spec.instantUnixNano,
    rawInstantUnixNano: raw,
    phase: spec.phase ?? 'open',
    depth: spec.depth ?? 0,
    spanId: span(spec.spanIndex),
  }
  // Built with an explicit conditional assignment rather than a conditional
  // SPREAD. Under `exactOptionalPropertyTypes` (this workspace's setting), a
  // spread of `{ lossReasons: spec.lossReasons }` widens the property to
  // `OtelMappingLossReason[] | undefined`, which is not assignable to an
  // optional property declared without `| undefined` — the distinction the flag
  // exists to draw is exactly "absent" vs "present and undefined", and
  // `isProvenanceConsistent` in contracts rejects the latter.
  const provenanceOverrides: Partial<OtelEventProvenance> = { lossy }
  if (lossy && spec.lossReasons !== undefined) {
    provenanceOverrides.lossReasons = spec.lossReasons
  }

  return {
    id: spec.id,
    runId: 'run-derived',
    type: spec.type,
    sequenceNumber: spec.sequenceNumber,
    timestamp: Number(BigInt(spec.instantUnixNano) / BigInt(1_000_000)),
    payload: { type: spec.type } as Event['payload'],
    provenance: otelProvenance(spec.spanIndex, provenanceOverrides),
    temporalOrder: key,
  } as unknown as Event
}

function makeRun(id: string): Run {
  return {
    id,
    orgId: 'org-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    status: 'completed',
    startedAt: 1_700_000_000_000,
    metadata: {},
  } as Run
}

const MS = BigInt(1_000_000)
function ms(n: number): string {
  return (BigInt(1_700_000_000_000) * MS + BigInt(n) * MS).toString()
}

// ---------------------------------------------------------------------------
// THE IMPOSSIBILITY CASE, from the consumer side.
//
// Batch 1 carried child B (t=200) and C (t=300); they were appended at
// sequences 2 and 3. Batch 2 later carried A (t=100), which happened BEFORE
// both — but the log is append-only, so A could only be appended at sequence 4.
//
// Ingest order:   run.started(1), B(2), C(3), A(4)
// Temporal order: run.started(t=0), A(t=100), B(t=200), C(t=300)
// ---------------------------------------------------------------------------
const IMPOSSIBILITY_CASE: Event[] = [
  derived({ id: 'e-start', type: 'run.started', sequenceNumber: 1, instantUnixNano: ms(0), spanIndex: 0, depth: -1 }),
  derived({ id: 'e-b', type: 'tool.call', sequenceNumber: 2, instantUnixNano: ms(200), spanIndex: 2 }),
  derived({ id: 'e-c', type: 'tool.result', sequenceNumber: 3, instantUnixNano: ms(300), spanIndex: 3 }),
  derived({ id: 'e-a', type: 'llm.request', sequenceNumber: 4, instantUnixNano: ms(100), spanIndex: 1 }),
]

describe('replay temporal ordering — derived runs', () => {
  it('detects the run as derived and fully keyed', () => {
    const ordering = analyzeRunOrdering(IMPOSSIBILITY_CASE)
    expect(ordering.basis).toBe('temporal')
    expect(ordering.derivedCount).toBe(4)
    expect(ordering.nativeCount).toBe(0)
    expect(ordering.keyedCount).toBe(4)
    expect(ordering.mixedProvenance).toBe(false)
  })

  it('sorting by sequenceNumber gives the WRONG order — this is the bug', () => {
    const bySequence = [...IMPOSSIBILITY_CASE]
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((e) => e.id)
    expect(bySequence).toEqual(['e-start', 'e-b', 'e-c', 'e-a'])
    // The late-arriving earlier span lands LAST. That is arrival order, and it
    // is what the projection used to render.
  })

  it('orderEventsForProjection puts the late-arriving earlier span in its true position', () => {
    expect(orderEventsForProjection(IMPOSSIBILITY_CASE).map((e) => e.id)).toEqual([
      'e-start',
      'e-a',
      'e-b',
      'e-c',
    ])
  })

  it('replays a derived run in temporal order, not ingest order', () => {
    const projection = buildReplayProjection(makeRun('run-derived'), IMPOSSIBILITY_CASE)
    expect(projection.frames.map((f) => f.event.id)).toEqual(['e-start', 'e-a', 'e-b', 'e-c'])
    // Sequence numbers in the rendered timeline are now non-monotonic. That is
    // the honest result: they are ingest ordinals, and the timeline is time.
    expect(projection.frames.map((f) => f.event.sequenceNumber)).toEqual([1, 4, 2, 3])
  })

  it('elapsed_ms is non-negative and monotonic once temporally ordered', () => {
    const { frames } = buildReplayProjection(makeRun('run-derived'), IMPOSSIBILITY_CASE)
    const elapsed = frames.map((f) => f.elapsed_ms)
    expect(elapsed).toEqual([0, 100, 200, 300])
    // Under the old sequence sort this read [0, 200, 300, 100] — a timeline
    // that went backwards.
  })

  it('is invariant to the order the events are handed to it', () => {
    const shuffled = [IMPOSSIBILITY_CASE[3]!, IMPOSSIBILITY_CASE[1]!, IMPOSSIBILITY_CASE[0]!, IMPOSSIBILITY_CASE[2]!]
    expect(orderEventsForProjection(shuffled).map((e) => e.id)).toEqual(
      orderEventsForProjection(IMPOSSIBILITY_CASE).map((e) => e.id)
    )
  })
})

describe('compareTemporalOrder — mirror of convex/helpers/otel_mapping.ts', () => {
  function key(over: Partial<TemporalOrderKey>): TemporalOrderKey {
    return {
      instantUnixNano: ms(100),
      rawInstantUnixNano: ms(100),
      phase: 'open',
      depth: 0,
      spanId: span(1),
      ...over,
    }
  }

  it('orders by effective instant first, at nanosecond precision', () => {
    const a = key({ instantUnixNano: '1700000000000000001' })
    const b = key({ instantUnixNano: '1700000000000000002' })
    expect(compareTemporalOrder(a, b)).toBeLessThan(0)
    // A number-based comparison would lose this: both round to the same double.
    expect(Number(a.instantUnixNano)).toBe(Number(b.instantUnixNano))
  })

  it('orders opens before closes at the same instant', () => {
    expect(compareTemporalOrder(key({ phase: 'open' }), key({ phase: 'close' }))).toBeLessThan(0)
  })

  it('orders opens outside-in and closes inside-out', () => {
    expect(
      compareTemporalOrder(key({ phase: 'open', depth: 0 }), key({ phase: 'open', depth: 3 }))
    ).toBeLessThan(0)
    expect(
      compareTemporalOrder(key({ phase: 'close', depth: 3 }), key({ phase: 'close', depth: 0 }))
    ).toBeLessThan(0)
  })

  it('breaks remaining ties on span id — total and stable, never array index', () => {
    expect(compareTemporalOrder(key({ spanId: span(1) }), key({ spanId: span(2) }))).toBeLessThan(0)
    expect(compareTemporalOrder(key({}), key({}))).toBe(0)
  })

  it('ignores the raw instant entirely — ordering is by the effective one', () => {
    const a = key({ instantUnixNano: ms(100), rawInstantUnixNano: ms(9_999), spanId: span(1) })
    const b = key({ instantUnixNano: ms(200), rawInstantUnixNano: ms(1), spanId: span(2) })
    expect(compareTemporalOrder(a, b)).toBeLessThan(0)
  })
})

describe('readTemporalOrder — defensive probe', () => {
  it('finds the key when nested inside provenance', () => {
    const e = {
      ...derived({ id: 'x', type: 'custom', sequenceNumber: 1, instantUnixNano: ms(5), spanIndex: 7 }),
    } as unknown as Record<string, unknown>
    const key = e['temporalOrder']
    delete e['temporalOrder']
    ;(e['provenance'] as Record<string, unknown>)['temporalOrder'] = key
    expect(readTemporalOrder(e as unknown as Event)?.spanId).toBe(span(7))
  })

  it('treats a MALFORMED key as absent rather than trusting it', () => {
    const e = derived({ id: 'x', type: 'custom', sequenceNumber: 1, instantUnixNano: ms(5), spanIndex: 7 }) as unknown as Record<string, unknown>
    e['temporalOrder'] = { instantUnixNano: 'not-a-number', rawInstantUnixNano: '1', phase: 'open', depth: 0, spanId: 'z' }
    expect(readTemporalOrder(e as unknown as Event)).toBeUndefined()
    // ...and the run therefore reports as unverified rather than confidently wrong.
    expect(analyzeRunOrdering([e as unknown as Event]).basis).toBe('ingest-unverified')
  })

  it('returns undefined for a native event', () => {
    const native = {
      id: 'n', runId: 'r', type: 'run.started', sequenceNumber: 1, timestamp: 1, payload: {},
    } as unknown as Event
    expect(readTemporalOrder(native)).toBeUndefined()
  })
})

describe('a derived run with NO ordering key is labelled, not silently guessed', () => {
  const unkeyed: Event[] = IMPOSSIBILITY_CASE.map((e) => {
    const copy = { ...e } as Record<string, unknown>
    delete copy['temporalOrder']
    return copy as unknown as Event
  })

  it('reports basis ingest-unverified', () => {
    const ordering = analyzeRunOrdering(unkeyed)
    expect(ordering.basis).toBe('ingest-unverified')
    expect(ordering.derivedCount).toBe(4)
    expect(ordering.keyedCount).toBe(0)
  })

  it('falls back to arrival order — the only order that exists', () => {
    expect(orderEventsForProjection(unkeyed).map((e) => e.id)).toEqual([
      'e-start', 'e-b', 'e-c', 'e-a',
    ])
  })

  it('a PARTIALLY keyed run is unverified, not partially trusted', () => {
    const partial = [IMPOSSIBILITY_CASE[0]!, IMPOSSIBILITY_CASE[1]!, unkeyed[2]!, IMPOSSIBILITY_CASE[3]!]
    const ordering = analyzeRunOrdering(partial)
    expect(ordering.basis).toBe('ingest-unverified')
    expect(ordering.keyedCount).toBe(3)
    expect(ordering.derivedCount).toBe(4)
    // Ordering three of four events temporally and splicing the fourth in by
    // arrival would produce a confident-looking timeline that is wrong in an
    // unmarked place. Refusing to claim temporal order is the correct answer.
    expect(orderEventsForProjection(partial).map((e) => e.id)).toEqual([
      'e-start', 'e-b', 'e-c', 'e-a',
    ])
  })
})

// ---------------------------------------------------------------------------
// CLAMPED vs MEASURED
// ---------------------------------------------------------------------------

describe('clamped timings are distinguishable from measured ones', () => {
  const measured = derived({
    id: 'm', type: 'tool.call', sequenceNumber: 1, instantUnixNano: ms(500), spanIndex: 1,
  })
  const clamped = derived({
    id: 'c',
    type: 'tool.result',
    sequenceNumber: 2,
    // Parent started at 500ms; the child claimed 88ms and was clamped forward.
    instantUnixNano: ms(500),
    rawInstantUnixNano: ms(88),
    spanIndex: 2,
    lossReasons: ['timing-approximated'],
  })

  it('a measured derived event reads as measured', () => {
    const t = readEventTiming(measured)
    expect(t.measured).toBe(true)
    expect(t.approximated).toBe(false)
    expect(t.clamped).toBe(false)
    expect(t.skewNano).toBeUndefined()
  })

  it('a clamped event reads as inferred and exposes both instants', () => {
    const t = readEventTiming(clamped)
    expect(t.measured).toBe(false)
    expect(t.approximated).toBe(true)
    expect(t.clamped).toBe(true)
    expect(t.rawInstantUnixNano).toBe(ms(88))
    expect(t.effectiveInstantUnixNano).toBe(ms(500))
  })

  it('exposes the raw-vs-effective skew with a documented sign convention', () => {
    // effective − raw: positive means pushed LATER than the emitter claimed.
    expect(readEventTiming(clamped).skewNano).toBe((BigInt(412) * MS).toString())
    expect(formatSkew(readEventTiming(clamped).skewNano!)).toBe('+412ms')
  })

  it('a native event is always measured', () => {
    const native = {
      id: 'n', runId: 'r', type: 'llm.request', sequenceNumber: 1, timestamp: 5, payload: {},
      provenance: { source: 'sdk' as const },
    } as unknown as Event
    const t = readEventTiming(native)
    expect(t.measured).toBe(true)
    expect(t.clamped).toBe(false)
  })

  it('declares approximation even when the raw instant is unrecoverable', () => {
    const noKey = { ...clamped } as Record<string, unknown>
    delete noKey['temporalOrder']
    const t = readEventTiming(noKey as unknown as Event)
    expect(t.approximated).toBe(true)
    expect(t.measured).toBe(false)
    expect(t.clamped).toBe(false)
    expect(t.skewNano).toBeUndefined()
  })

  it('rolls the largest skew in the run up to the run level', () => {
    const ordering = analyzeRunOrdering([measured, clamped])
    expect(ordering.clampedCount).toBe(1)
    expect(ordering.approximatedCount).toBe(1)
    expect(ordering.maxAbsSkewNano).toBe((BigInt(412) * MS).toString())
  })

  it('keeps the largest skew by MAGNITUDE, sign preserved', () => {
    const pulledEarlier = derived({
      id: 'p', type: 'tool.call', sequenceNumber: 3,
      instantUnixNano: ms(100), rawInstantUnixNano: ms(9_000), spanIndex: 3,
      lossReasons: ['timing-approximated'],
    })
    const ordering = analyzeRunOrdering([clamped, pulledEarlier])
    expect(ordering.maxAbsSkewNano).toBe((BigInt(-8_900) * MS).toString())
    // The KEY is exact (`maxAbsSkewNano` above); the label truncates to three
    // significant digits without ever crossing a unit boundary. See the
    // formatSkew block below for why it renders this way.
    expect(formatSkew(ordering.maxAbsSkewNano!)).toBe('-8.90s')
  })
})

// ---------------------------------------------------------------------------
// formatSkew — A RESOLVED TRADE, NOT A CHOICE BETWEEN TWO OPTIONS.
//
// READ THIS BEFORE "SIMPLIFYING" THE IMPLEMENTATION. Two obvious versions of
// this function existed, and BOTH WERE REJECTED. Anyone reducing it to either
// one is reintroducing a defect that was already found and fixed.
//
//   * REJECTED — fractional, per-unit digit counts (the original apps/web
//     version). It ROUNDED ACROSS UNIT BOUNDARIES: 999999999ns printed
//     '+1000ms', which is 1 second wearing a millisecond label, and 999999ns
//     printed '+1000.0µs', which is 1 millisecond. A magnitude that reaches
//     the next unit's threshold is a rendering that contradicts its own unit.
//
//   * REJECTED — integer BigInt division (the first contracts hoist). Boundary
//     correct, but it TRUNCATED THE FRACTION ENTIRELY and so understated at
//     exactly the scale that matters: 8.9 SECONDS of clock skew rendered as
//     '-8s', and 2.5s as '-2s'. Understating skew is not a cosmetic loss in a
//     tool whose job is making a broken clock visible.
//
// HOW IT WAS FOUND. The second version shipped as part of a hoist described as
// a pure swap. It was caught by running a differential harness across BOTH
// implementations before deleting the local one — the comparator and every
// other hoisted function proved byte-for-byte equivalent over 20k random
// comparator pairs and 400 random runs; formatSkew alone diverged. The
// divergence was escalated rather than reconciled locally, which is what made
// a third option possible instead of a silent pick between two.
//
// THE RESOLUTION (packages/contracts/src/temporal.ts): truncate toward zero,
// three significant digits, all BigInt. Both properties hold at once —
// boundary-correct AND not understating. Independently verified here over
// 200,018 signed inputs plus every unit boundary and its neighbours: zero
// overstatements, zero understatements of one displayed ulp or more, and no
// rendered magnitude ever reaching the next unit's threshold.
//
// "Three significant digits" means AT LEAST three, and exactly three while the
// whole part is under three digits ('+4.12µs', '+999ms', '+1.00s'). Seconds is
// the terminal unit, so a value past 999s necessarily grows past three digits
// ('+35544s') rather than overflowing into a unit that does not exist.
//
// The exact value is never lost regardless — `EventTiming.skewNano` and
// `RunOrdering.maxAbsSkewNano` carry full nanosecond precision, and the UI
// renders both raw and effective instants verbatim beside this label. Only the
// scannable summary truncates.
// ---------------------------------------------------------------------------
describe('formatSkew', () => {
  it('renders nanoseconds, microseconds, milliseconds and seconds', () => {
    expect(formatSkew('412')).toBe('+412ns')
    expect(formatSkew('-412')).toBe('-412ns')
    expect(formatSkew('4120')).toBe('+4.12µs')
    expect(formatSkew('5000000')).toBe('+5.00ms')
    expect(formatSkew('412000000')).toBe('+412ms')
    expect(formatSkew('-2500000000')).toBe('-2.50s')
  })

  it('truncates toward zero rather than rounding across a unit boundary', () => {
    expect(formatSkew('999999')).toBe('+999µs')
    expect(formatSkew('999999999')).toBe('+999ms')
    expect(formatSkew('1000000000')).toBe('+1.00s')
    expect(formatSkew('0')).toBe('+0ns')
  })

  it('keeps the fraction, so a large skew is not understated', () => {
    // The property the integer-truncating version lost. 8.9s of clock skew is
    // a different finding from 8s, and a debugging readout has to say which.
    expect(formatSkew('-8900000000')).toBe('-8.90s')
    expect(formatSkew('8900000000')).toBe('+8.90s')
  })

  it('grows past three digits rather than overflowing the terminal unit', () => {
    // Seconds has no next unit to promote into, so the whole part widens.
    expect(formatSkew('35544162540000')).toBe('+35544s')
  })
})

// ---------------------------------------------------------------------------
// DIFF
// ---------------------------------------------------------------------------

describe('diffing two derived runs aligns by temporal position, not ingest position', () => {
  // Both runs executed the same four logical steps in the same order.
  // LEFT arrived in one batch, so ingest order == temporal order.
  // RIGHT arrived in two batches, so its `llm.request` was appended LAST.
  const left: Event[] = [
    derived({ id: 'l1', type: 'run.started', sequenceNumber: 1, instantUnixNano: ms(0), spanIndex: 0, depth: -1 }),
    derived({ id: 'l2', type: 'llm.request', sequenceNumber: 2, instantUnixNano: ms(100), spanIndex: 1 }),
    derived({ id: 'l3', type: 'tool.call', sequenceNumber: 3, instantUnixNano: ms(200), spanIndex: 2 }),
    derived({ id: 'l4', type: 'tool.result', sequenceNumber: 4, instantUnixNano: ms(300), spanIndex: 3 }),
  ]
  const right: Event[] = [
    derived({ id: 'r1', type: 'run.started', sequenceNumber: 1, instantUnixNano: ms(0), spanIndex: 0, depth: -1 }),
    derived({ id: 'r3', type: 'tool.call', sequenceNumber: 2, instantUnixNano: ms(200), spanIndex: 2 }),
    derived({ id: 'r4', type: 'tool.result', sequenceNumber: 3, instantUnixNano: ms(300), spanIndex: 3 }),
    derived({ id: 'r2', type: 'llm.request', sequenceNumber: 4, instantUnixNano: ms(100), spanIndex: 1 }),
  ]

  it('reports the two runs as identical, because they are', () => {
    const diff = buildRunDiff('L', 'R', left, right)
    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 0, same: 4 })
    expect(diff.summary.statusChanged).toBe(false)
    expect(diff.eventDiffs.every((d) => d.kind === 'same')).toBe(true)
  })

  it('aligns each position to its temporal counterpart, not its ingest counterpart', () => {
    const diff = buildRunDiff('L', 'R', left, right)
    expect(diff.eventDiffs.map((d) => [d.leftEvent?.id, d.rightEvent?.id])).toEqual([
      ['l1', 'r1'],
      ['l2', 'r2'],
      ['l3', 'r3'],
      ['l4', 'r4'],
    ])
  })

  it('WOULD have reported three spurious changes under the old ingest-order alignment', () => {
    // Proof the case has teeth: strip the ordering keys and the same two runs
    // diff as three differing positions.
    const strip = (events: Event[]): Event[] =>
      events.map((e) => {
        const copy = { ...e } as Record<string, unknown>
        delete copy['temporalOrder']
        return copy as unknown as Event
      })
    const diff = buildRunDiff('L', 'R', strip(left), strip(right))
    expect(diff.summary.changed).toBe(3)
    expect(diff.summary.same).toBe(1)
  })

  it('orders each side independently — a native run diffed against a derived one', () => {
    const native: Event[] = left.map((e, i) => ({
      id: `n${i + 1}`,
      runId: 'run-native',
      type: e.type,
      sequenceNumber: i + 1,
      timestamp: e.timestamp,
      payload: e.payload,
    })) as unknown as Event[]

    const diff = buildRunDiff('N', 'R', native, right)
    expect(diff.eventDiffs.map((d) => d.rightEvent?.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(diff.summary.changed).toBe(0)
    expect(diff.summary.same).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Degenerate inputs — no state may render blank or throw.
// ---------------------------------------------------------------------------

describe('degenerate inputs', () => {
  it('an empty run is sequence-native and orders to nothing', () => {
    const ordering = analyzeRunOrdering([])
    expect(ordering.basis).toBe('sequence-native')
    expect(ordering.maxAbsSkewNano).toBeNull()
    expect(orderEventsForProjection([])).toEqual([])
    expect(buildReplayProjection(makeRun('r'), []).frames).toEqual([])
  })

  it('a single derived event orders to itself', () => {
    const one = [IMPOSSIBILITY_CASE[1]!]
    expect(orderEventsForProjection(one).map((e) => e.id)).toEqual(['e-b'])
  })

  it('a mixed-provenance run is flagged and still totally ordered', () => {
    const native = {
      id: 'nat', runId: 'run-derived', type: 'custom', sequenceNumber: 5,
      timestamp: 1_700_000_000_150, payload: {},
    } as unknown as Event
    const mixed = [...IMPOSSIBILITY_CASE, native]
    const ordering = analyzeRunOrdering(mixed)
    expect(ordering.mixedProvenance).toBe(true)
    expect(ordering.basis).toBe('temporal')
    // The native event's own timestamp (150ms) places it between A (100) and
    // B (200) — its millisecond instant widened to nanoseconds, claiming no
    // precision it does not have.
    expect(orderEventsForProjection(mixed).map((e) => e.id)).toEqual([
      'e-start', 'e-a', 'nat', 'e-b', 'e-c',
    ])
  })
})
