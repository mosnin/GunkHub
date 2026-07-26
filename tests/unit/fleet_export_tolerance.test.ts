/**
 * EVERY EXPORT OF `fleet_health.ts` SURVIVES MALFORMED CONTENTS — enumerated
 * FROM THE MODULE'S OWN SOURCE, so the list cannot go stale.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, WHICH IS NOT THE SAME AS WHAT IT CHECKS
 * ---------------------------------------------------------------------------
 *
 * The rule — "the ELEMENTS of a required array are as untrusted as a required
 * FIELD" — was identified, written into the contract, and then applied to
 * THREE of the SIX functions that needed it: the three whose call sites
 * happened to be open at the time. One of the three that was missed was
 * `fleetReportUnusableFields`, the function whose entire job is reporting
 * unusable fields, in the same file, in the same sitting.
 *
 * That had already happened once with `NaN`: the lesson was written into the
 * contract in one function and left unapplied in the other half of the same
 * gate. So the recurring failure is not any of these bugs. It is that
 * KNOWING A RULE DOES NOT APPLY IT AT THE FIVE CALL SITES YOU ARE NOT LOOKING
 * AT, and no amount of care at review time changes that.
 *
 * Two things are done about it, and only the second one scales:
 *
 *   1. The contract deletes the raw read. Nothing in `fleet_health.ts` touches
 *      `report.correlations` / `.hypotheses` / `.roster` / `.unanswered` or
 *      `correlation.observedBy` directly any more; they go through accessors
 *      that validate CONTENTS, not just the container. There is no longer a
 *      tempting-but-wrong primitive to reach for — the container-only helper
 *      that made the mistake easy is gone.
 *
 *   2. THIS FILE, which is the part that survives the next person. The subject
 *      list is parsed out of `fleet_health.ts` itself, so:
 *        - a NEW exported function with no probe FAILS this test;
 *        - a STALE probe for a function that no longer exists FAILS it too.
 *      A hand-written list structurally cannot catch this class, because the
 *      thing that goes wrong IS the list being incomplete. (Verified by
 *      appending a function to the module and watching this go red.)
 *
 * SCOPE, deliberately narrow: MALFORMED CONTENTS INSIDE A WELL-FORMED
 * CONTAINER — `{ correlations: [null] }` — which is the shape wire JSON
 * actually produces. Not `f(null)` wholesale: whether a caller may pass
 * garbage as the whole argument is a caller-contract question the SDK gate
 * answers upstream, and grading it here would bury the real finding in noise.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as fleet from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  FleetHealthReport,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
} from '@agent-flight-recorder/contracts'

const MODULE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/contracts/src/fleet_health.ts'
)

/** Every `export function` name, read from the module's own source. */
function exportedFunctionNames(): string[] {
  const src = readFileSync(MODULE_PATH, 'utf8')
  return [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!).sort()
}

const T0 = 1_721_909_400_000

const soundMeasurement: FleetShareMeasurement = {
  affectedSharing: 2,
  affectedTotal: 3,
  unaffectedSharing: 1,
  unaffectedTotal: 140,
  measurementTruncated: false,
}

const soundCorrelation: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1',
  observedFact: '3 agents failed inside 4 minutes',
  agentIds: ['ag_1', 'ag_2', 'ag_3'],
  agentCount: 3,
  firstObservedAt: T0 - 3 * 60_000,
  lastObservedAt: T0,
  observedBy: [
    { cites: 'failure_occurrence', agentId: 'ag_1', runId: 'r1', fingerprintHash: '9f3c', occurredAt: T0 - 60_000 },
    { cites: 'failure_occurrence', agentId: 'ag_2', runId: 'r2', fingerprintHash: '9f3c', occurredAt: T0 },
  ],
}

const soundHypothesis: HypothesisedCause = {
  certainty: 'hypothesis',
  kind: 'shared_model',
  hypothesisKey: 'h1',
  sharedValue: 'm-4',
  restingOn: ['burst:1'],
  notEstablishedBecause: 'recorded data cannot establish a mechanism',
  sharedBy: soundMeasurement,
  wouldBeTestedBy: 'roll ag_3 onto m-3',
}

/**
 * A report whose every collection carries a `null` FIRST element alongside a
 * sound one. Well-formed containers, malformed contents — the shape a server
 * with a mapping bug actually emits.
 */
function hostileReport(): FleetHealthReport {
  return {
    analyzedAt: T0,
    verdict: 'correlated_failures',
    roster: [null as never, { agentId: 'ag_1', state: 'failing', runsObserved: 3, runsFailed: 3, distinctFingerprints: 1, observationTruncated: false }],
    correlations: [null as never, soundCorrelation],
    hypotheses: [null as never, soundHypothesis],
    unanswered: [null as never],
    agentsFailing: 3,
    scan: {
      since: T0 - 86_400_000,
      until: T0,
      burstWindowMs: 4 * 60_000,
      correlationBasis: 'whole_roster',
      agentsInRoster: 3,
      agentsAssessed: 3,
      agentsUnassessable: 0,
      agentsSkippedForBudget: 0,
      occurrencesScanned: 9,
      scanTruncated: false,
      baseRatesMeasured: true,
    },
  }
}

/** A correlation whose citation array carries a `null` element. */
function hostileCorrelation(): ObservedCorrelation {
  return { ...soundCorrelation, observedBy: [null as never, soundCorrelation.observedBy[0]!] }
}

/** A hypothesis whose `restingOn` carries a non-string element. */
function hostileHypothesis(): HypothesisedCause {
  return { ...soundHypothesis, restingOn: [null as never, 'burst:1'] }
}

/**
 * One probe per export. THE KEY IS THE FUNCTION NAME, and the test below
 * cross-checks these keys against the module's real exports in both
 * directions.
 */
const PROBES: Record<string, () => unknown> = {
  // Report-shaped: every collection carries a null element.
  isFleetHealthAnalysisComplete: () => fleet.isFleetHealthAnalysisComplete(hostileReport()),
  fleetHealthReportVerdict: () => fleet.fleetHealthReportVerdict(hostileReport()),
  hypothesesFor: () => fleet.hypothesesFor(hostileReport(), 'burst:1'),
  orphanHypotheses: () => fleet.orphanHypotheses(hostileReport()),
  fleetReportUnusableFields: () => fleet.fleetReportUnusableFields(hostileReport()),
  fleetReportIncoherences: () => fleet.fleetReportIncoherences(hostileReport()),

  // Correlation-shaped: the citation array carries a null element.
  citedAgentCount: () => fleet.citedAgentCount(hostileCorrelation()),
  correlationIncoherences: () => fleet.correlationIncoherences(hostileCorrelation(), { burstWindowMs: 1 }),
  isCorrelationSelfConsistent: () => fleet.isCorrelationSelfConsistent(hostileCorrelation()),
  rankFleetCorrelations: () => fleet.rankFleetCorrelations([null as never, soundCorrelation]),

  // Hypothesis-shaped: `restingOn` carries a non-string element.
  hypothesisQuestion: () => fleet.hypothesisQuestion(hostileHypothesis()),

  // Measurement-shaped: the fields inside are the untrusted part.
  discriminationOf: () => fleet.discriminationOf({ ...soundMeasurement, unaffectedTotal: '140' as never }),
  baseRateUsability: () => fleet.baseRateUsability({ ...soundMeasurement, unaffectedTotal: '140' as never }),

  // Scalar-shaped: no collection to malform, so the probe is the hostile
  // scalar. Listed rather than exempted, so the map stays exhaustive.
  isFleetHealthScanComplete: () => fleet.isFleetHealthScanComplete({ ...hostileReport().scan, agentsAssessed: Number.NaN }),
  computeFleetHealthVerdict: () =>
    fleet.computeFleetHealthVerdict({ correlationCount: Number.NaN, agentsFailing: Number.NaN, complete: true }),
}

describe('the probe map is derived from the module, so it cannot silently go stale', () => {
  it('every exported function has a malformed-contents probe', () => {
    // A NEW export with no probe fails HERE. This is the assertion that makes
    // the rule un-forgettable: it does not depend on anyone remembering to
    // extend a list, because the list is checked against reality.
    const missing = exportedFunctionNames().filter((name) => !(name in PROBES))
    expect(missing, `add a malformed-contents probe to PROBES for: ${missing.join(', ')}`).toEqual([])
  })

  it('has no probe for a function that no longer exists', () => {
    // The other direction. A stale probe is a probe testing nothing, and a
    // suite that quietly tests nothing is worse than one that is absent.
    const exported = new Set(exportedFunctionNames())
    const stale = Object.keys(PROBES).filter((name) => !exported.has(name))
    expect(stale, `PROBES names functions that are no longer exported: ${stale.join(', ')}`).toEqual([])
  })

  it('actually found the exports — a regex that matched nothing would pass both checks above vacuously', () => {
    // The positive clause, which is the same lesson this contract keeps
    // relearning: a predicate built only from "nothing was missing" is
    // vacuously true on nothing at all.
    expect(exportedFunctionNames().length).toBeGreaterThan(10)
    expect(exportedFunctionNames()).toContain('fleetReportUnusableFields')
  })
})

describe('no export throws on malformed contents in a well-formed container', () => {
  for (const [name, probe] of Object.entries(PROBES)) {
    it(`${name} survives a null element`, () => {
      expect(probe).not.toThrow()
    })
  }
})

describe('the three that were missed, specifically', () => {
  // Named individually as well as covered by the sweep above, so a revert
  // fails with the function's name rather than as one of fifteen.

  it('hypothesesFor returns the sound hypotheses and skips the malformed one', () => {
    const found = fleet.hypothesesFor(hostileReport(), 'burst:1')
    expect(found).toHaveLength(1)
    expect(found[0]!.hypothesisKey).toBe('h1')
  })

  it('orphanHypotheses does not throw, and still flags a genuine orphan', () => {
    expect(fleet.orphanHypotheses(hostileReport())).toHaveLength(0)
    const orphaned = { ...hostileReport(), correlations: [null as never] }
    expect(fleet.orphanHypotheses(orphaned)).toHaveLength(1)
  })

  it('fleetReportUnusableFields REPORTS the malformed element rather than throwing on it', () => {
    // The function whose job is reporting unusable fields had the defect it
    // exists to report. It now names every bad position — in all four
    // collections — rather than dying on the first.
    const paths = fleet.fleetReportUnusableFields(hostileReport()).map((f) => f.path)
    expect(paths).toContain('correlations[0]')
    expect(paths).toContain('hypotheses[0]')
    expect(paths).toContain('roster[0]')
  })
})

// ---------------------------------------------------------------------------
// SECOND DIMENSION — over COLLECTIONS, asking "does it REPORT", not "does it
// throw"
// ---------------------------------------------------------------------------

describe('the reporter is responsible for EVERY collection, not the ones someone remembered', () => {
  // WHY A SECOND DIMENSION WAS NEEDED, and it is the third instance of this
  // pattern in one iteration — the first where the TOOL had the gap:
  //
  // The sweep above enumerates FUNCTIONS and asks "does it throw?".
  // `fleetReportUnusableFields` did not throw on a malformed `unanswered`
  // element — IT IGNORED IT. So the most serious defect of the iteration was
  // invisible to a sweep that was otherwise general: a completeness predicate
  // took the CONSUMER direction on the one completeness-bearing collection,
  // three unreadable questions produced an org-wide `healthy`, and nothing
  // named it because the reporter covered three collections of four and the
  // missing one was exactly that.
  //
  // A generalized attack is only as general as its dimensions. This is the
  // other dimension, enumerated the same way — from the data's own shape, not
  // from a list someone maintains.

  /** Every array-valued collection on a report, read off the report itself. */
  const collectionsOf = (report: FleetHealthReport): string[] =>
    Object.entries(report)
      .filter(([, value]) => Array.isArray(value))
      .map(([key]) => key)
      .sort()

  it('found the collections at all — a filter matching nothing would pass the sweep vacuously', () => {
    // The positive clause. Named anchors rather than a count, so a rename
    // fails loudly instead of sliding under a `length > 3`.
    const collections = collectionsOf(hostileReport())
    expect(collections).toEqual(['correlations', 'hypotheses', 'roster', 'unanswered'])
  })

  for (const collection of ['correlations', 'hypotheses', 'roster', 'unanswered']) {
    it(`names a malformed element in \`${collection}\``, () => {
      const findings = fleet.fleetReportUnusableFields(hostileReport())
      expect(findings.map((f) => f.path)).toContain(`${collection}[0]`)
    })
  }

  it('covers every collection the report actually has, so a NEW collection cannot be silently exempt', () => {
    // Derived rather than listed: if a fifth collection is added to the report
    // type and the reporter does not walk it, this fails without anyone
    // remembering to extend the loop above.
    const named = new Set(fleet.fleetReportUnusableFields(hostileReport()).map((f) => f.path.split('[')[0]))
    for (const collection of collectionsOf(hostileReport())) {
      expect(named, `fleetReportUnusableFields never names a malformed element in \`${collection}\``).toContain(
        collection
      )
    }
  })
})

describe('DIRECTION IS A PROPERTY OF THE COLLECTION — a malformed question cannot license `healthy`', () => {
  // The most serious defect of the iteration, pinned as the executed table.
  // The scan is genuinely complete in every row, so `unanswered` is the only
  // thing standing between the report and a certification.

  const certifiable = (): FleetHealthReport => ({
    ...hostileReport(),
    verdict: 'healthy',
    roster: [],
    correlations: [],
    hypotheses: [],
    unanswered: [],
    agentsFailing: 0,
  })

  const realQuestion = {
    certainty: 'unanswered' as const,
    kind: 'roster_incomplete' as const,
    questionKey: 'k',
    undecidedQuestion: 'whether the agents past the ceiling also failed',
    unknownBecause: 'the roster ceiling was reached',
  }

  it('an empty `unanswered` still certifies — the fix does not make everything indeterminate', () => {
    expect(fleet.isFleetHealthAnalysisComplete(certifiable())).toBe(true)
    expect(fleet.fleetHealthReportVerdict(certifiable())).toBe('healthy')
  })

  it('ONE unreadable question blocks certification, exactly as a readable one does', () => {
    // It used to be the reverse: a readable question blocked, an UNREADABLE
    // one was dropped and licensed the opposite verdict. An unreadable
    // question is the strongest ground for `indeterminate` there is.
    for (const unanswered of [[realQuestion], [null], [null, null, null], [null, realQuestion]]) {
      const report = { ...certifiable(), unanswered: unanswered as never }
      expect(fleet.isFleetHealthAnalysisComplete(report)).toBe(false)
      expect(fleet.fleetHealthReportVerdict(report)).toBe('indeterminate')
    }
  })

  it('and every unreadable question is NAMED, not merely counted', () => {
    const report = { ...certifiable(), unanswered: [null, null, null] as never }
    expect(fleet.fleetReportUnusableFields(report).map((f) => f.path)).toEqual([
      'unanswered[0]',
      'unanswered[1]',
      'unanswered[2]',
    ])
  })

  it('the sibling: an unreadable CORRELATION is not "no correlation" either', () => {
    // Found while fixing the above. `correlations` also gates the verdict, so
    // dropping a malformed element there turned an unreadable claim about the
    // fleet into an absence of claims — `healthy` again.
    const report = { ...certifiable(), correlations: [null] as never }
    expect(fleet.fleetHealthReportVerdict(report)).toBe('indeterminate')
  })

  it('a malformed element in a DISPLAY collection does not block certification', () => {
    // The counterweight. If every collection gated, the fix would be "declare
    // everything indeterminate", which is a different way of being useless.
    // `hypotheses` cannot move a verdict by design; `roster` is a bounded view
    // collection with `agentsFailing` carried separately.
    for (const key of ['hypotheses', 'roster']) {
      const report = { ...certifiable(), [key]: [null] } as unknown as FleetHealthReport
      expect(fleet.isFleetHealthAnalysisComplete(report)).toBe(true)
      // Still NAMED, though — withheld from the verdict is not withheld from
      // the operator.
      expect(fleet.fleetReportUnusableFields(report).map((f) => f.path)).toContain(`${key}[0]`)
    }
  })
})

describe('reporters KEEP malformed elements; consumers DROP them', () => {
  // The one place the two accessors must not be collapsed into one.

  it('a reporter names the bad position, so a malformed cluster never becomes an absent one', () => {
    expect(fleet.fleetReportIncoherences(hostileReport())).toContainEqual({
      correlationKey: '(correlations[0])',
      incoherence: 'malformed_correlation',
    })
  })

  it('a consumer computes over the sound elements only, rather than crashing the view', () => {
    expect(fleet.fleetHealthReportVerdict(hostileReport())).toBe('correlated_failures')
    expect(fleet.citedAgentCount(hostileCorrelation())).toBe(1)
  })

  it('ranking keeps the malformed entry and sorts it last — never silently shorter', () => {
    const ranked = fleet.rankFleetCorrelations([null as never, soundCorrelation])
    expect(ranked).toHaveLength(2)
    expect(ranked[1]).toBeNull()
  })
})
