import { analyzeRunOrdering, orderEventsForProjection, readEventTiming } from '@agent-flight-recorder/contracts'
import { describe, it, expect } from 'vitest'

import { buildRunDiff } from '../../apps/web/src/lib/replay/diff.js'
import { buildReplayProjection } from '../../apps/web/src/lib/replay/projection.js'
import {
  successfulRun,
  successfulRunEvents,
  failedToolRun,
  failedToolRunEvents,
  partialRun,
  partialRunEvents,
  nestedRun,
  nestedRunEvents,
} from '../fixtures/events.js'

import type { Event, Run } from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// THE NON-REGRESSION HALF OF THE TEMPORAL-ORDERING WORK.
//
// Temporal ordering exists for runs DERIVED from OpenTelemetry spans. The
// first-party SDK path must be untouched by it — not "probably fine", but
// provably identical. On that path `sequenceNumber` IS temporal order, because
// the SDK assigns it at the moment the event happens.
//
// The strategy is to pin the OLD behaviour as a literal expression and assert
// the new code produces exactly it, structurally, on every shipped fixture. The
// reference below is a verbatim copy of the sort line that `projection.ts` and
// `diff.ts` used before this change:
//
//     [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
//
// If `orderEventsForProjection` ever stops taking that branch for a native run,
// these fail.
// ---------------------------------------------------------------------------

/** The pre-change sort, kept verbatim as the oracle. Do not "improve" it. */
function legacySortBySequenceNumber(events: readonly Event[]): Event[] {
  return [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber)
}

const FIXTURES: Array<{ name: string; run: Run; events: Event[] }> = [
  { name: 'successfulRun', run: successfulRun, events: successfulRunEvents },
  { name: 'failedToolRun', run: failedToolRun, events: failedToolRunEvents },
  { name: 'partialRun', run: partialRun, events: partialRunEvents },
  { name: 'nestedRun', run: nestedRun, events: nestedRunEvents },
]

describe('native runs are unaffected by temporal ordering', () => {
  for (const { name, run, events } of FIXTURES) {
    describe(name, () => {
      it('is classified sequence-native', () => {
        const ordering = analyzeRunOrdering(events)
        expect(ordering.basis).toBe('sequence-native')
        expect(ordering.derivedCount).toBe(0)
        expect(ordering.nativeCount).toBe(events.length)
        expect(ordering.keyedCount).toBe(0)
        expect(ordering.clampedCount).toBe(0)
        expect(ordering.approximatedCount).toBe(0)
        expect(ordering.mixedProvenance).toBe(false)
        expect(ordering.maxAbsSkewNano).toBeNull()
      })

      it('orders identically to the pre-change sequenceNumber sort', () => {
        expect(orderEventsForProjection(events)).toEqual(legacySortBySequenceNumber(events))
      })

      it('orders identically even when handed the events shuffled', () => {
        const shuffled = [...events].reverse()
        expect(orderEventsForProjection(shuffled)).toEqual(legacySortBySequenceNumber(shuffled))
      })

      it('every event reads as MEASURED — no inferred marker appears', () => {
        for (const event of events) {
          const timing = readEventTiming(event)
          expect(timing.measured).toBe(true)
          expect(timing.approximated).toBe(false)
          expect(timing.clamped).toBe(false)
          expect(timing.skewNano).toBeUndefined()
        }
      })

      it('produces a projection structurally identical to the pre-change one', () => {
        // Reference projection: what `buildReplayProjection` produced before the
        // change is, for a native run, the projection over the legacy sort. We
        // assert the frame-by-frame output rather than re-implementing the
        // builder, so a change to actor/status/preview derivation would also
        // show up here.
        const projection = buildReplayProjection(run, events)
        const oracle = legacySortBySequenceNumber(events)

        expect(projection.frames.map((f) => f.event.id)).toEqual(oracle.map((e) => e.id))
        expect(projection.frames.map((f) => f.index)).toEqual(oracle.map((_, i) => i))
        expect(projection.frames.map((f) => f.elapsed_ms)).toEqual(
          oracle.map((e) => e.timestamp - (oracle[0]?.timestamp ?? 0))
        )
        expect(projection.totalEvents).toBe(oracle.length)
        expect(projection.duration_ms).toBe(
          oracle.length > 1
            ? (oracle[oracle.length - 1]?.timestamp ?? 0) - (oracle[0]?.timestamp ?? 0)
            : 0
        )
        // Sequence numbers stay strictly increasing down a native timeline.
        const seqs = projection.frames.map((f) => f.event.sequenceNumber)
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
      })

      it('is order-independent: shuffled input yields the same projection', () => {
        const a = buildReplayProjection(run, events)
        const b = buildReplayProjection(run, [...events].reverse())
        expect(b).toEqual(a)
      })
    })
  }

  it('an explicit sdk provenance is still native', () => {
    const withProvenance = successfulRunEvents.map((e) => ({
      ...e,
      provenance: { source: 'sdk' as const, sdkVersion: '0.1.0' },
    })) as Event[]
    const ordering = analyzeRunOrdering(withProvenance)
    expect(ordering.basis).toBe('sequence-native')
    expect(ordering.nativeCount).toBe(withProvenance.length)
    expect(orderEventsForProjection(withProvenance)).toEqual(
      legacySortBySequenceNumber(withProvenance)
    )
  })

  it('diffing two native runs is unchanged', () => {
    const before = buildRunDiff(
      successfulRun.id,
      failedToolRun.id,
      legacySortBySequenceNumber(successfulRunEvents),
      legacySortBySequenceNumber(failedToolRunEvents)
    )
    const after = buildRunDiff(
      successfulRun.id,
      failedToolRun.id,
      successfulRunEvents,
      failedToolRunEvents
    )
    // Feeding the diff pre-sorted input vs. raw input must be indistinguishable,
    // which it can only be if the engine took the legacy sequence sort.
    expect(after).toEqual(before)
  })

  it('diffing a native run against itself yields all-same', () => {
    const diff = buildRunDiff('a', 'b', successfulRunEvents, [...successfulRunEvents].reverse())
    expect(diff.summary.changed).toBe(0)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    expect(diff.summary.same).toBe(successfulRunEvents.length)
  })
})

// ---------------------------------------------------------------------------
// orderingBasis must agree with `convex/helpers/replay_projection.ts`.
//
// `ReplayProjection.orderingBasis` is returned by BOTH this projection (the
// browser) and the Convex mirror (`apiGetReplay`, which feeds the `afr` CLI and
// the MCP server). Two independently-computed bases that disagree is worse than
// the unlabelled divergence the field was added to fix, because both sides would
// then claim to be labelled.
//
// The two agree by construction — same contracts function, same input — and the
// input is the part that is easy to get wrong, so it is pinned here.
// ---------------------------------------------------------------------------
describe('orderingBasis', () => {
  it('is sequence-native for every native fixture, and for an empty run', () => {
    for (const { run, events } of FIXTURES) {
      expect(buildReplayProjection(run, events).orderingBasis).toBe('sequence-native')
    }
    expect(buildReplayProjection(successfulRun, []).orderingBasis).toBe('sequence-native')
  })

  it('is computed from the FULL log, not the post-truncation window', () => {
    // A derived run just over MAX_EVENTS_PER_REPLAY whose single UNKEYED event
    // sits beyond the window. `orderEventsForProjection` decides its branch from
    // the full set, so the whole array — including the visible 10,000 — was
    // ordered by ARRIVAL. Labelling that `temporal` because the window happens
    // to contain only keyed events would be a timeline ordered by arrival and
    // presented as ordered by time.
    const provenance = {
      source: 'otel' as const,
      traceId: 'a'.repeat(32),
      spanId: '0'.repeat(16),
      spanName: 's',
      semconvVersion: 'v',
      mapperVersion: 'm',
      lossy: false,
      receivedAt: 1,
    }
    const total = 10_001
    const events = Array.from({ length: total }, (_, i) => {
      const nano = (BigInt(1_700_000_000_000) * BigInt(1_000_000) + BigInt(i) * BigInt(1_000_000))
      const base = {
        id: `e${i}`,
        runId: 'run-big',
        type: 'custom',
        sequenceNumber: i + 1,
        timestamp: 1_700_000_000_000 + i,
        payload: {},
        provenance: { ...provenance, spanId: i.toString(16).padStart(16, '0') },
      }
      // The LAST event by arrival is the one missing its key.
      if (i === total - 1) return base
      return {
        ...base,
        temporalOrder: {
          instantUnixNano: nano.toString(),
          rawInstantUnixNano: nano.toString(),
          phase: 'open',
          depth: 0,
          spanId: i.toString(16).padStart(16, '0'),
        },
      }
    }) as unknown as Event[]

    const projection = buildReplayProjection(successfulRun, events)
    expect(projection.truncated).toBe(true)
    expect(projection.frames.length).toBe(10_000)
    // The unkeyed event is NOT in the window...
    expect(projection.frames.some((f) => f.event.id === `e${total - 1}`)).toBe(false)
    // ...and the label still tells the truth about how the order was produced.
    expect(projection.orderingBasis).toBe('ingest-unverified')
    expect(analyzeRunOrdering(events).basis).toBe('ingest-unverified')
  })
})
