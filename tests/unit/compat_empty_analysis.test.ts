/**
 * VACUOUS COMPLETENESS — "nothing went wrong" is not "we checked".
 *
 * Regression tests for `contracts/is-fleet-scan-complete-vacuous-on-empty-window`
 * (found by Team D against the BUILT artifact) and for the identical defect one
 * level down in `isDivergenceCoverageComplete`, which the same sweep had not
 * reached.
 *
 * ---------------------------------------------------------------------------
 * THE CATEGORY ERROR, BECAUSE IT KEEPS COMING BACK
 * ---------------------------------------------------------------------------
 *
 * Both predicates were built entirely from NEGATIVE clauses — nothing
 * truncated, nothing skipped, nothing unassessed, no pages left. Every one of
 * those is satisfied by an analysis that did nothing at all, so both were
 * VACUOUSLY TRUE on empty input, and `computeDivergenceVerdict` turned that
 * into `compatible`: a green light derived from zero evidence.
 *
 * The predicate was answering "was anything truncated?" when the property it
 * must express is "do we have enough evidence to conclude?". Those coincide on
 * every input where something was examined and diverge precisely on the empty
 * one — which is why 16 non-empty window shapes agreed and the bug survived.
 *
 * An empty window is not exotic. It is what ordinary operation produces once a
 * version's runs age out of the retention window (ADR-001) — exactly when
 * someone is asking whether an old version can finally be replaced.
 *
 * The fix is a POSITIVE clause in each predicate (`runsAnalyzed > 0`,
 * `assessed.length > 0 && eventsExamined > 0`). The tests below pin the empty
 * case, the "so far and no further" boundary at one, and — the part that
 * matters for the next iteration — the GENERAL property, so a future predicate
 * that regains vacuity fails here without anyone having to think of the empty
 * case again.
 */
import {
  computeDivergenceVerdict,
  divergenceReportVerdict,
  fleetDivergenceVerdict,
  isDivergenceAnalysisComplete,
  isDivergenceCoverageComplete,
  isFleetDivergenceAnalysisComplete,
  isFleetScanComplete,
  mergeFleetDivergenceReports,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  DivergenceCoverage,
  DivergenceReport,
  DivergenceScanWindow,
  FleetDivergenceReport,
} from '@agent-flight-recorder/contracts'

/** A scan that hit no problems at all, parameterised by how much it actually analysed. */
function window(overrides: Partial<DivergenceScanWindow> = {}): DivergenceScanWindow {
  return {
    runsScanned: 100,
    runsAnalyzed: 100,
    runsUnassessable: 0,
    runsSkippedForBudget: 0,
    scanTruncated: false,
    ...overrides,
  }
}

function fleet(w: DivergenceScanWindow): FleetDivergenceReport {
  return {
    agentId: 'ag_1',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'indeterminate',
    provenReasons: [],
    speculativeReasons: [],
    indeterminateReasons: [],
    runsWithProvenDivergence: 0,
    window: w,
  }
}

function coverage(overrides: Partial<DivergenceCoverage> = {}): DivergenceCoverage {
  return {
    assessed: ['tools', 'model', 'budgets', 'capabilities', 'system_prompt', 'decoding_params'],
    unassessed: [],
    eventsExamined: 120,
    eventHistoryComplete: true,
    ...overrides,
  }
}

function report(c: DivergenceCoverage): DivergenceReport {
  return {
    runId: 'run_1',
    baselineVersionId: 'ver_old',
    targetVersionId: 'ver_new',
    analyzedAt: 1_700_000_000_000,
    verdict: 'indeterminate',
    proven: [],
    speculative: [],
    indeterminate: [],
    coverage: c,
  }
}

// ---------------------------------------------------------------------------
// The reported defect
// ---------------------------------------------------------------------------

describe('an EMPTY fleet scan is never compatible', () => {
  const empty = window({ runsScanned: 0, runsAnalyzed: 0 })

  it('is not complete — nothing went wrong, and nothing was examined', () => {
    expect(isFleetScanComplete(empty)).toBe(false)
    expect(isFleetDivergenceAnalysisComplete(fleet(empty))).toBe(false)
  })

  it('yields INDETERMINATE, not a fleet-wide green light from zero runs', () => {
    expect(fleetDivergenceVerdict(fleet(empty))).toBe('indeterminate')
  })

  it('agrees with the server, which had to override this helper to be right here', () => {
    // The engine (convex/helpers/) carried a local `runsAnalyzed > 0` because
    // this helper was vacuous. That override is what made a client re-deriving
    // the verdict compute `compatible` while the server said `indeterminate` —
    // a contract helper disagreeing with the server about the same facts is
    // the exact seam this feature exists to remove.
    expect(fleetDivergenceVerdict(fleet(empty))).toBe('indeterminate')
    expect(isFleetScanComplete(empty)).toBe(isFleetScanComplete({ ...empty, runsAnalyzed: 0 }))
  })

  it('is reachable in ordinary operation — a version whose runs aged out of retention', () => {
    // Nothing about this window is malformed. It is the honest report of a
    // scan over an agent whose recorded history has been purged (ADR-001),
    // which is precisely when someone asks "can I retire this version?".
    const agedOut = window({ runsScanned: 0, runsAnalyzed: 0 })
    expect(fleetDivergenceVerdict(fleet(agedOut))).toBe('indeterminate')
  })

  it('a scan that visited runs but analysed none of them is also not complete', () => {
    expect(isFleetScanComplete(window({ runsScanned: 100, runsAnalyzed: 0, runsUnassessable: 100 }))).toBe(false)
  })

  it('one analysed run is enough to be complete — the fix does not over-reach', () => {
    // The boundary matters as much as the empty case. Requiring more than one
    // run would make a low-traffic agent permanently indeterminate, which is
    // the "always inconclusive" disease in the other direction.
    expect(isFleetScanComplete(window({ runsScanned: 1, runsAnalyzed: 1 }))).toBe(true)
    expect(fleetDivergenceVerdict(fleet(window({ runsScanned: 1, runsAnalyzed: 1 })))).toBe('compatible')
  })

  it('merging empty pages does not launder them into a pass', () => {
    const merged = mergeFleetDivergenceReports([fleet(window({ runsScanned: 0, runsAnalyzed: 0 }))])
    expect(merged.window.runsAnalyzed).toBe(0)
    expect(merged.verdict).toBe('indeterminate')
  })
})

// ---------------------------------------------------------------------------
// The same defect one level down, which the sweep had not reached
// ---------------------------------------------------------------------------

describe('an EMPTY single-run analysis is never compatible', () => {
  const empty = coverage({ assessed: [], eventsExamined: 0 })

  it('is not complete, though nothing was truncated or unassessed', () => {
    expect(isDivergenceCoverageComplete(empty)).toBe(false)
    expect(isDivergenceAnalysisComplete(report(empty))).toBe(false)
  })

  it('yields INDETERMINATE rather than clearing a run nothing looked at', () => {
    expect(divergenceReportVerdict(report(empty))).toBe('indeterminate')
  })

  it('refuses a report that assessed dimensions but read no events', () => {
    // Event Log Rule 5 guarantees RUN_STARTED is the first event of every run,
    // so `eventsExamined: 0` can never mean "an empty run" — it means nothing
    // was read, and no proof about what a run DID can come from reading none
    // of what it did.
    expect(isDivergenceCoverageComplete(coverage({ eventsExamined: 0 }))).toBe(false)
  })

  it('refuses a report that read events but assessed no dimension', () => {
    expect(isDivergenceCoverageComplete(coverage({ assessed: [] }))).toBe(false)
  })

  it('still passes a genuinely complete analysis', () => {
    expect(isDivergenceCoverageComplete(coverage())).toBe(true)
    expect(divergenceReportVerdict(report(coverage()))).toBe('compatible')
  })

  it('one assessed dimension and one event is enough — partial coverage is handled by `unassessed`, not by this clause', () => {
    expect(isDivergenceCoverageComplete({ assessed: ['tools'], unassessed: [], eventsExamined: 1, eventHistoryComplete: true })).toBe(
      true
    )
  })
})

// ---------------------------------------------------------------------------
// THE GENERAL PROPERTY — so the next regression fails here without anyone
// having to think of the empty case again
// ---------------------------------------------------------------------------

describe('completeness is never vacuous: no zero-evidence input may be complete', () => {
  it('holds across every combination of the negative flags on an empty scan', () => {
    // The defect survived a sweep of 16 non-empty window shapes because the
    // predicates agree everywhere something was examined. So this sweep fixes
    // the evidence at ZERO and varies everything else: no combination of
    // "nothing went wrong" may add up to "we checked".
    const flags = [false, true]
    for (const scanTruncated of flags) {
      for (const hasCursor of flags) {
        for (const unassessable of [0, 3]) {
          for (const skipped of [0, 3]) {
            const w = window({
              runsScanned: 0,
              runsAnalyzed: 0,
              runsUnassessable: unassessable,
              runsSkippedForBudget: skipped,
              scanTruncated,
              ...(hasCursor && { nextCursor: 'c1' }),
            })
            expect(isFleetScanComplete(w)).toBe(false)
            expect(fleetDivergenceVerdict(fleet(w))).toBe('indeterminate')
          }
        }
      }
    }
  })

  it('holds for the single-run predicate the same way', () => {
    for (const eventHistoryComplete of [false, true]) {
      for (const unassessed of [[], [{ dimension: 'tools' as const, reason: 'engine_limit' as const }]]) {
        const c = coverage({ assessed: [], eventsExamined: 0, unassessed, eventHistoryComplete })
        expect(isDivergenceCoverageComplete(c)).toBe(false)
        expect(divergenceReportVerdict(report(c))).toBe('indeterminate')
      }
    }
  })

  it('`compatible` requires evidence, at every entry point that can produce it', () => {
    // Every route to the one verdict that authorises a deploy, checked against
    // a zero-evidence input. `computeDivergenceVerdict` itself is deliberately
    // NOT in this list: it takes `complete` as an argument, so it can only be
    // as honest as its caller — which is why its doc now says, in as many
    // words, to get that boolean from the helpers above and never hand-roll it.
    expect(divergenceReportVerdict(report(coverage({ assessed: [], eventsExamined: 0 })))).not.toBe('compatible')
    expect(fleetDivergenceVerdict(fleet(window({ runsScanned: 0, runsAnalyzed: 0 })))).not.toBe('compatible')
    expect(
      mergeFleetDivergenceReports([fleet(window({ runsScanned: 0, runsAnalyzed: 0 }))]).verdict
    ).not.toBe('compatible')

    // And the one input that legitimately produces it still does, so this
    // whole file is not just asserting that nothing ever passes.
    expect(computeDivergenceVerdict({ provenCount: 0, speculativeCount: 0, complete: true })).toBe('compatible')
  })
})
