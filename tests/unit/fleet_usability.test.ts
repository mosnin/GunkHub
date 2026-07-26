/**
 * USABILITY — "is what arrived something arithmetic can be done with AT ALL?"
 *
 * ---------------------------------------------------------------------------
 * THE CLASS, WHICH HAS NOW BITTEN THIS CONTRACT TWICE
 * ---------------------------------------------------------------------------
 *
 *   A gate that verifies a field is PRESENT has not verified that its CONTENTS
 *   ARE USABLE.
 *
 * The first bite was cross-field arithmetic (a burst echoing four minutes and
 * spanning a day; see `fleet_coherence.test.ts`). This is the second, one
 * level lower: those coherence checks presume the fields ARE numbers.
 *
 * The base-rate guard was the clearest case. `null` was airtight — it was the
 * case the design was built for. Its NEIGHBOURS were not, because the guard
 * asked "did they SAY they measured it?" (`=== null`) when what the verdict
 * needs is "CAN I DIVIDE THESE?". For every input nobody thought about, a
 * guard written as a comparison does not reject the value, it takes the other
 * branch — and whether that branch is safe is luck:
 *
 *   fields ABSENT               -> `undefined === null` is false; divided
 *                                  anyway; `not_discriminating` — A MEASURED
 *                                  VERDICT FROM NO MEASUREMENT.
 *   counts as STRINGS           -> `'0'/'188'` is 0 by JS coercion ->
 *                                  DISCRIMINATING. A guess promoted to "read
 *                                  this first" from unvalidated wire data.
 *   truncation flag DROPPED     -> `undefined` is falsy, so the guard FAILED
 *                                  OPEN and floors were compared as totals ->
 *                                  DISCRIMINATING.
 *   NaN                         -> `not_discriminating`, and THIS ONE IS THE
 *                                  WARNING, NOT THE REASSURANCE: it was safe
 *                                  only because every IEEE comparison with NaN
 *                                  is false. Correct-by-coincidence is
 *                                  wrong-and-lucky with better outcomes so far.
 *
 * Every case below is written as a POSITIVE assertion that the guard FIRES on
 * the fixture that used to defeat it. `toEqual([])` passes just as happily
 * when a probe has gone blind, and a suite that only knows how to say "no
 * defects" cannot tell "fixed" from "stopped looking".
 */
import {
  baseRateUsability,
  computeFleetHealthVerdict,
  discriminationOf,
  fleetHealthReportVerdict,
  fleetReportIncoherences,
  fleetReportUnusableFields,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  FailureOccurrenceCitation,
  FleetHealthReport,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
} from '@agent-flight-recorder/contracts'

const T0 = 1_721_909_400_000
const MIN = 60_000

/** A measurement that genuinely discriminates: 12/12 sick share it, 2/140 healthy do. */
const sound: FleetShareMeasurement = {
  affectedSharing: 12,
  affectedTotal: 12,
  unaffectedSharing: 2,
  unaffectedTotal: 140,
  measurementTruncated: false,
}

function citation(agentId: string, runId: string, occurredAt: number): FailureOccurrenceCitation {
  return { cites: 'failure_occurrence', agentId, runId, fingerprintHash: '9f3c', occurredAt }
}

const correlation: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1',
  observedFact: '3 agents recorded their first failure inside 4 minutes',
  agentIds: ['ag_1', 'ag_2', 'ag_3'],
  agentCount: 3,
  firstObservedAt: T0 - 3 * MIN,
  lastObservedAt: T0,
  observedBy: [citation('ag_1', 'r_1', T0 - 3 * MIN), citation('ag_2', 'r_2', T0 - MIN)],
}

const hypothesis: HypothesisedCause = {
  certainty: 'hypothesis',
  kind: 'shared_model',
  hypothesisKey: 'h1',
  sharedValue: 'm-4',
  restingOn: ['burst:1'],
  notEstablishedBecause: 'recorded data cannot establish a mechanism',
  sharedBy: sound,
  wouldBeTestedBy: 'roll ag_3 onto m-3',
}

function report(overrides: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    analyzedAt: T0,
    verdict: 'correlated_failures',
    roster: [],
    correlations: [correlation],
    hypotheses: [hypothesis],
    unanswered: [],
    agentsFailing: 3,
    scan: {
      since: T0 - 24 * 60 * MIN,
      until: T0,
      burstWindowMs: 4 * MIN,
      correlationBasis: 'whole_roster',
      agentsInRoster: 152,
      agentsAssessed: 152,
      agentsUnassessable: 0,
      agentsSkippedForBudget: 0,
      occurrencesScanned: 4_120,
      scanTruncated: false,
      baseRatesMeasured: true,
    },
    ...overrides,
  }
}

/** Build a hypothesis whose measurement is whatever malformed thing we are probing. */
function withMeasurement(measurement: unknown): HypothesisedCause {
  return { ...hypothesis, sharedBy: measurement as FleetShareMeasurement }
}

describe('the control: a sound measurement still works, and still discriminates', () => {
  it('does not reject the case the mechanism exists to serve', () => {
    // A guard that rejects everything is a different way of being useless
    // during an incident.
    expect(baseRateUsability(sound)).toBe('usable')
    expect(discriminationOf(sound)).toBe('discriminating')
  })

  it('still calls a shared-by-everyone attribute NOT DISCRIMINATING', () => {
    const useless: FleetShareMeasurement = { ...sound, unaffectedSharing: 186, unaffectedTotal: 188 }
    expect(baseRateUsability(useless)).toBe('usable')
    expect(discriminationOf(useless)).toBe('not_discriminating')
  })

  it('still treats an honest `null` as NOT MEASURED, distinctly from zero', () => {
    // The pair the whole design turns on: `null` is no support at all; `0` is
    // the strongest support a hypothesis can have.
    expect(baseRateUsability({ ...sound, unaffectedSharing: null, unaffectedTotal: null })).toBe('not_measured')
    expect(discriminationOf({ ...sound, unaffectedSharing: null, unaffectedTotal: null })).toBe('base_rate_unmeasured')
    expect(discriminationOf({ ...sound, unaffectedSharing: 0, unaffectedTotal: 140 })).toBe('discriminating')
  })
})

describe("THE NEIGHBOURS OF `null` — each fires the guard that used to let it through", () => {
  // Positive assertions, one per row. If a fix is ever reverted, the specific
  // named row goes red rather than a collection quietly becoming empty.

  it('ABSENT fields are unusable, not a measured `not_discriminating`', () => {
    const absent = { affectedSharing: 12, affectedTotal: 12, measurementTruncated: false }
    expect(baseRateUsability(absent as unknown as FleetShareMeasurement)).toBe('unusable')
    expect(discriminationOf(absent as unknown as FleetShareMeasurement)).toBe('base_rate_unmeasured')
  })

  it('STRING counts are unusable — this row used to return `discriminating`', () => {
    // THE DANGEROUS DIRECTION. `'0'/'188'` is 0 by JS coercion, so 12/12 minus
    // 0 cleared the margin and a hypothesis was promoted to the top of an
    // incident screen on the strength of two strings.
    const strings = { ...sound, unaffectedSharing: '0', unaffectedTotal: '188' }
    expect(baseRateUsability(strings as unknown as FleetShareMeasurement)).toBe('unusable')
    expect(discriminationOf(strings as unknown as FleetShareMeasurement)).toBe('base_rate_unmeasured')
  })

  it('a DROPPED truncation flag is unusable — the guard now fails CLOSED', () => {
    // `undefined` is falsy, so the truncation guard was skipped entirely and
    // floors were compared as though they were totals -> `discriminating`.
    const dropped = { affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 0, unaffectedTotal: 188 }
    expect(baseRateUsability(dropped as unknown as FleetShareMeasurement)).toBe('unusable')
    expect(discriminationOf(dropped as unknown as FleetShareMeasurement)).toBe('base_rate_unmeasured')
  })

  it('NaN is unusable BY RULE, not by IEEE coincidence', () => {
    // It gave the right answer before. That is not the same as being right:
    // it was safe only because every comparison with NaN is false, which is a
    // property of floating point rather than of this code.
    const nan = { ...sound, unaffectedSharing: Number.NaN, unaffectedTotal: 140 }
    expect(baseRateUsability(nan as unknown as FleetShareMeasurement)).toBe('unusable')
    expect(discriminationOf(nan as unknown as FleetShareMeasurement)).toBe('base_rate_unmeasured')
  })

  it('infinities, negatives and non-integers are unusable too — one predicate, not four', () => {
    for (const bad of [Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(baseRateUsability({ ...sound, unaffectedSharing: bad })).toBe('unusable')
    }
    expect(baseRateUsability({ ...sound, affectedSharing: Number.NaN })).toBe('unusable')
  })

  it('more sharers than the population they came from is nonsense, not a measurement', () => {
    // The same "numbers must agree with each other" rule as the coherence
    // sweep, one level down.
    expect(baseRateUsability({ ...sound, affectedSharing: 13, affectedTotal: 12 })).toBe('unusable')
    expect(baseRateUsability({ ...sound, unaffectedSharing: 200, unaffectedTotal: 140 })).toBe('unusable')
  })

  it('a truncated measurement is NOT MEASURED — legal, and says nothing', () => {
    // Distinct from `unusable`: truncation is a statement a producer can
    // legitimately make, so it is accepted and reported, not refused.
    expect(baseRateUsability({ ...sound, measurementTruncated: true })).toBe('not_measured')
    expect(discriminationOf({ ...sound, measurementTruncated: true })).toBe('base_rate_unmeasured')
  })

  it('an empty comparison group is NOT MEASURED, not a perfect score', () => {
    expect(baseRateUsability({ ...sound, unaffectedSharing: 0, unaffectedTotal: 0 })).toBe('not_measured')
  })
})

describe('THE SWEEP — the same shape, everywhere a number feeds a verdict or a gate', () => {
  // Fixing only `discriminationOf` would have left every other
  // comparison-shaped guard in the contract with the identical hole.

  it('catches garbage timestamps — AND the coherence sweep now catches them too, independently', () => {
    // A `lastObservedAt` of `'2024-01-01'` is present and readable, and used to
    // make every comparison in the burst-span rule evaluate to `false` — so a
    // burst with garbage timestamps reported NO incoherence and sailed
    // through. BOTH halves of the gate now catch it, and the redundancy is
    // deliberate: `correlationIncoherences` is exported and reached directly by
    // the web, so it cannot depend on the usability sweep having run first.
    const garbage = report({
      correlations: [{ ...correlation, lastObservedAt: '2024-01-01' as unknown as number }],
    })
    expect(fleetReportIncoherences(garbage)).toContainEqual({
      correlationKey: 'burst:1',
      incoherence: 'unusable_numbers',
    })
    expect(fleetReportUnusableFields(garbage)).toContainEqual({
      path: 'correlations[burst:1].lastObservedAt',
      reason: 'not_a_finite_number',
    })
  })

  it('catches an `agentsFailing` that turns a failing fleet into `healthy`', () => {
    // `NaN > 0` is false, so the verdict rule read "no agents failing" and,
    // over a complete scan with no correlations, returned `healthy`.
    const nanFailing = report({ correlations: [], hypotheses: [], agentsFailing: Number.NaN })
    expect(fleetHealthReportVerdict(nanFailing)).toBe('healthy')
    expect(fleetReportUnusableFields(nanFailing)).toContainEqual({
      path: 'agentsFailing',
      reason: 'not_a_count',
    })
  })

  it('catches a dropped scan flag, which would read as "not truncated"', () => {
    const scan = { ...report().scan } as Record<string, unknown>
    delete scan['scanTruncated']
    expect(
      fleetReportUnusableFields(report({ scan: scan as unknown as FleetHealthReport['scan'] }))
    ).toContainEqual({ path: 'scan.scanTruncated', reason: 'not_a_boolean' })
  })

  it('catches an unrecognised correlationBasis rather than guessing which it meant', () => {
    const typo = report({ scan: { ...report().scan, correlationBasis: 'whole-roster' as never } })
    expect(fleetReportUnusableFields(typo)).toContainEqual({
      path: 'scan.correlationBasis',
      reason: 'not_a_known_value',
    })
  })

  it('catches an unusable base rate through the report-level sweep, addressed by path', () => {
    const strings = report({
      hypotheses: [withMeasurement({ ...sound, unaffectedSharing: '0', unaffectedTotal: '188' })],
    })
    expect(fleetReportUnusableFields(strings)).toContainEqual({
      path: 'hypotheses[h1].sharedBy',
      reason: 'unusable_measurement',
    })
  })

  it('catches unusable scan counts, citation timestamps and roster counts', () => {
    const broken = report({
      scan: { ...report().scan, agentsAssessed: '152' as unknown as number },
      correlations: [
        { ...correlation, observedBy: [citation('ag_1', 'r_1', Number.NaN), citation('ag_2', 'r_2', T0 - MIN)] },
      ],
      roster: [
        {
          agentId: 'ag_1',
          state: 'failing',
          runsObserved: 40,
          runsFailed: -3,
          distinctFingerprints: 2,
          observationTruncated: false,
        },
      ],
    })
    const paths = fleetReportUnusableFields(broken).map((f) => f.path)
    expect(paths).toContain('scan.agentsAssessed')
    expect(paths).toContain('correlations[burst:1].observedBy[0].occurredAt')
    expect(paths).toContain('roster[ag_1].runsFailed')
  })

  it('an honest report reports NOTHING unusable — the sweep is not a filter that rejects everything', () => {
    expect(fleetReportUnusableFields(report())).toEqual([])
  })

  it('is not a schema validator: a malformed agentName cannot authorise a rollback, so it is not checked', () => {
    // Scope discipline. A check that flags everything is a check that gets
    // disabled, and the fields that matter are exactly those that feed a
    // verdict, a gate, or the ranking.
    const oddName = report({
      roster: [
        {
          agentId: 'ag_1',
          agentName: 42 as unknown as string,
          state: 'failing',
          runsObserved: 40,
          runsFailed: 3,
          distinctFingerprints: 2,
          observationTruncated: false,
        },
      ],
    })
    expect(fleetReportUnusableFields(oddName)).toEqual([])
  })
})

describe('the verdict rule itself is unchanged — this is a boundary fix, not a semantics change', () => {
  it('still says what it said for every well-formed input', () => {
    expect(computeFleetHealthVerdict({ correlationCount: 1, agentsFailing: 12, complete: false })).toBe(
      'correlated_failures'
    )
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 0, complete: false })).toBe('indeterminate')
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 7, complete: true })).toBe(
      'isolated_failures'
    )
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 0, complete: true })).toBe('healthy')
  })
})
