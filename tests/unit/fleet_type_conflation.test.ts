/**
 * THE TYPE SYSTEM IS THE FEATURE — this file is the proof, one altitude up
 * from `compat_type_conflation.test.ts`.
 *
 * `packages/contracts/src/fleet_health.ts` claims it is IMPOSSIBLE to render
 * an OBSERVED CO-OCCURRENCE ("twelve agents recorded failures inside four
 * minutes" — checkable against stored rows) as a HYPOTHESISED SHARED CAUSE
 * ("model m-4 is degrading" — a claim about a mechanism, which a recorder of
 * what happened can never establish). That claim is worth exactly as much as
 * the evidence behind it, and the only honest evidence for a compile-time
 * guarantee is code that DOES NOT COMPILE.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ THIS FILE — `@ts-expect-error` IS THE ASSERTION
 * ---------------------------------------------------------------------------
 *
 * A test file that simply failed to compile would take the whole repo's
 * `pnpm typecheck` down with it, so the negative cases are written under
 * `@ts-expect-error`, which inverts the check and is SELF-VERIFYING IN BOTH
 * DIRECTIONS:
 *
 *   - if the line below it errors (the conflation is illegal), the directive
 *     is satisfied and typecheck passes — the guarantee holds;
 *   - if the line below it ever STOPS erroring (someone adds a shared
 *     `message` field, relaxes a discriminant, makes `sharedBy` optional,
 *     loosens `observedBy` or `restingOn`), TypeScript reports "Unused
 *     '@ts-expect-error' directive" AS AN ERROR ON THIS FILE, and
 *     `pnpm typecheck` goes red.
 *
 * So the guarantee cannot be weakened without this file failing. That is a
 * stronger property than any runtime assertion could give: no test needs to
 * remember to run, and no consumer needs to remember to check a confidence
 * field.
 *
 * WHY THE STAKES ARE HIGHER HERE THAN FOR DIVERGENCE. A divergence report
 * gates a deploy — read at leisure, and a wrong answer blocks or permits a
 * change. A fleet report is read DURING AN INCIDENT by someone deciding what
 * to roll back, at speed, looking for permission to act. A confidently-worded
 * wrong hypothesis is therefore MORE dangerous at this altitude, not less: it
 * is the artifact that gets a healthy model rolled back while the real cause —
 * a shared tool that changed shape an hour earlier — keeps burning.
 */
import {
  computeFleetHealthVerdict,
  hypothesisQuestion,
  discriminationOf,
  fleetHealthReportVerdict,
  hypothesesFor,
  isCorrelationSelfConsistent,
  isFleetHealthAnalysisComplete,
  isFleetHealthScanComplete,
  orphanHypotheses,
  rankFleetCorrelations,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  FailureOccurrenceCitation,
  FleetHealthReport,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'

// ---------------------------------------------------------------------------
// The three bands, each valid on its own. These compile — the positive control
// that the negative cases below fail for the RIGHT reason (a real
// incompatibility) rather than because the fixtures were malformed.
// ---------------------------------------------------------------------------

const occurrence: FailureOccurrenceCitation = {
  cites: 'failure_occurrence',
  agentId: 'ag_1',
  runId: 'run_a',
  fingerprintHash: '9f3c',
  occurredAt: 1_721_908_931_000,
}

// A SECOND citation, naming a DIFFERENT agent. Not padding: a multi-agent
// claim whose whole citation sample names one agent is now an incoherence
// (twelve citations from `ag_1` is one agent retrying, not an outage), so an
// honest 12-agent fixture has to look like one.
const occurrence2: FailureOccurrenceCitation = {
  cites: 'failure_occurrence',
  agentId: 'ag_2',
  runId: 'run_b',
  fingerprintHash: '9f3c',
  occurredAt: 1_721_909_000_000,
}

const observed: ObservedCorrelation = {
  certainty: 'observed',
  kind: 'temporal_burst',
  correlationKey: 'burst:1721908800000',
  observedFact: '12 agents recorded their first failure between 14:02:11 and 14:06:40',
  // `agentIds` must carry min(agentCount, MAX_FLEET_CORRELATION_AGENTS)
  // entries — a list BELOW the ceiling is a complete list, so a shorter one
  // under a count of 12 is a self-contradiction.
  agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i + 1}`),
  agentCount: 12,
  firstObservedAt: 1_721_908_931_000,
  lastObservedAt: 1_721_909_200_000,
  observedBy: [occurrence, occurrence2],
}

const hypothesis: HypothesisedCause = {
  certainty: 'hypothesis',
  kind: 'shared_model',
  hypothesisKey: 'shared_model:m-4',
  sharedValue: 'm-4',
  restingOn: ['burst:1721908800000'],
  notEstablishedBecause:
    'causation requires a counterfactual, and the event log records only what happened — no run on another model exists to compare against',
  sharedBy: {
    affectedSharing: 12,
    affectedTotal: 12,
    unaffectedSharing: 3,
    unaffectedTotal: 140,
    measurementTruncated: false,
  },
  wouldBeTestedBy: 'roll ag_3 onto model `m-3` and watch whether its failures stop',
  attributeConfigPath: 'model.models[]',
}

const unanswered: UnansweredFleetQuestion = {
  certainty: 'unanswered',
  kind: 'roster_incomplete',
  questionKey: 'roster_incomplete',
  undecidedQuestion: 'whether the 40 agents after the roster ceiling also failed inside this window',
  unknownBecause: 'the roster ceiling (200) was reached before the roster was enumerated',
  remedy: 're-run with --limit 500',
}

// ---------------------------------------------------------------------------
// CASE 1 — the three bands are mutually unassignable, in EVERY direction
// ---------------------------------------------------------------------------

// THE CATASTROPHIC DIRECTION: a guess held as something that demonstrably
// happened. This is how "the prompt says m-4 is shared" becomes "m-4 broke the
// fleet" on a dashboard at 3am.
// @ts-expect-error — HypothesisedCause is not assignable to ObservedCorrelation
const notObserved: ObservedCorrelation = hypothesis

// And the quieter direction: a fact filed among the guesses, where it is
// discounted along with them.
// @ts-expect-error — ObservedCorrelation is not assignable to HypothesisedCause
const notHypothesis: HypothesisedCause = observed

// "We could not check" is neither a weak observation nor a strong guess.
// @ts-expect-error — UnansweredFleetQuestion is not assignable to ObservedCorrelation
const notObserved2: ObservedCorrelation = unanswered
// @ts-expect-error — UnansweredFleetQuestion is not assignable to HypothesisedCause
const notHypothesis2: HypothesisedCause = unanswered

// ---------------------------------------------------------------------------
// CASE 1b — THE DISCRIMINANT IS NOT THE ONLY BARRIER
//
// If `certainty` were the only thing separating them, deleting it (or a server
// omitting it) would open the hole. Each band carries a REQUIRED field the
// others lack, so assignment fails on a missing property even with the
// discriminant made to agree.
// ---------------------------------------------------------------------------

// @ts-expect-error — even wearing the right discriminant, this lacks `observedBy` and `agentIds`
const disguisedHypothesis: ObservedCorrelation = { ...hypothesis, certainty: 'observed' }

// @ts-expect-error — and this lacks `restingOn`, `sharedBy` and `wouldBeTestedBy`
const disguisedObservation: HypothesisedCause = { ...observed, certainty: 'hypothesis' }

// ---------------------------------------------------------------------------
// CASE 2 — a surface that takes observations cannot be handed a hypothesis
//
// This is the realistic shape of the accident: not a variable assignment, but
// an incident renderer or a pager rule written for facts and called with
// whatever the report happened to contain.
// ---------------------------------------------------------------------------

function pageOnCorrelations(findings: readonly ObservedCorrelation[]): boolean {
  return findings.length > 0
}

// @ts-expect-error — a hypothesis cannot reach an observation-only pager rule
const wrongPage = pageOnCorrelations([hypothesis])
// @ts-expect-error — nor can an unanswered question
const wrongPage2 = pageOnCorrelations([unanswered])

// ---------------------------------------------------------------------------
// CASE 3 — there is NO shared text field to render them through
//
// The one-liner that flattens everything (`findings.map(f => f.message)`) is
// the most likely way a guess reaches an incident channel looking like a
// finding. It cannot be written: the three types name their text differently
// on purpose and no shared name exists on the union.
// ---------------------------------------------------------------------------

function flattenNaively(finding: ObservedCorrelation | HypothesisedCause): string {
  // @ts-expect-error — `observedFact` does not exist on the hypothesis half of this union
  return finding.observedFact
}

function flattenNaively2(finding: ObservedCorrelation | HypothesisedCause): string {
  // @ts-expect-error — and there is no shared `message`/`summary`/`title` to fall back to
  return finding.message
}

// The deliberate version is legal, and must stay legal — the point is not to
// forbid handling both, it is to force the handler to SAY which it has.
function flattenDeliberately(finding: ObservedCorrelation | HypothesisedCause): string {
  return finding.certainty === 'observed' ? finding.observedFact : hypothesisQuestion(finding)
}

// ---------------------------------------------------------------------------
// CASE 4 — an observation must carry its evidence
// ---------------------------------------------------------------------------

const evidenceless: ObservedCorrelation = {
  ...observed,
  // @ts-expect-error — observedBy is [FleetObservationEvidence, ...FleetObservationEvidence[]]; empty is not evidence
  observedBy: [],
}

// ---------------------------------------------------------------------------
// CASE 5 — A HYPOTHESIS MUST CARRY ITS DENOMINATOR, AND MUST REST ON A FACT
//
// The invention at THIS altitude. The specific way a fleet view manufactures a
// confidently-worded wrong answer is a MISSING BASE RATE: "all 12 failing
// agents use model m-4" is damning-sounding and worthless when 198 of the
// org's 200 agents use m-4. Making `sharedBy` required means the misleading
// sentence cannot be written without also stating what the HEALTHY agents use.
//
// And `restingOn` being a non-empty tuple means a hypothesis can never float
// free of the observation it is supposed to explain — a free-floating
// explanation renders identically to a backed one, and nothing on the screen
// tells them apart.
// ---------------------------------------------------------------------------

// @ts-expect-error — `sharedBy` is required: a hypothesis with no denominator does not compile
const denominatorless: HypothesisedCause = {
  certainty: 'hypothesis',
  kind: 'shared_model',
  hypothesisKey: 'shared_model:m-4',
  sharedValue: 'm-4',
  restingOn: ['burst:1721908800000'],
  notEstablishedBecause: 'trust me',
  wouldBeTestedBy: 'roll one back',
}

const groundless: HypothesisedCause = {
  ...hypothesis,
  // @ts-expect-error — restingOn is [string, ...string[]]; a hypothesis resting on nothing does not compile
  restingOn: [],
}

// `unaffectedSharing: null` (NOT MEASURED) is deliberately legal and is a
// different statement from `0` (measured, and none of them share it). A type
// that forced a number here would make "we did not measure" unsayable, and an
// engine forced to say something says `0` — the most favourable possible lie.
const unmeasuredBaseRate: FleetShareMeasurement = {
  affectedSharing: 12,
  affectedTotal: 12,
  unaffectedSharing: null,
  unaffectedTotal: null,
  measurementTruncated: false,
}

// ---------------------------------------------------------------------------
// CASE 6 — the report's own arrays cannot be crossed
// ---------------------------------------------------------------------------

const report: FleetHealthReport = {
  analyzedAt: 1_721_909_400_000,
  verdict: 'correlated_failures',
  roster: [
    {
      agentId: 'ag_1',
      state: 'failing',
      runsObserved: 40,
      runsFailed: 31,
      distinctFingerprints: 2,
      firstFailureAt: 1_721_908_931_000,
      lastFailureAt: 1_721_909_200_000,
      observationTruncated: false,
    },
  ],
  correlations: [observed],
  hypotheses: [hypothesis],
  unanswered: [],
  agentsFailing: 12,
  scan: {
    since: 1_721_820_000_000,
    until: 1_721_909_400_000,
    burstWindowMs: 900_000,
    correlationBasis: 'whole_roster',
    agentsInRoster: 152,
    agentsAssessed: 152,
    agentsUnassessable: 0,
    agentsSkippedForBudget: 0,
    occurrencesScanned: 4_120,
    scanTruncated: false,
    baseRatesMeasured: true,
  },
}

// Never invoked — the assertions are the compile errors inside it, and the
// runtime `report` fixture must stay unmutated for the suites below.
function crossTheStreams(): void {
  // @ts-expect-error — a hypothesis cannot be pushed into `correlations`
  report.correlations.push(hypothesis)
  // @ts-expect-error — nor an unanswered question
  report.correlations.push(unanswered)
  // @ts-expect-error — and the reverse crossing is equally illegal
  report.hypotheses.push(observed)
}

// ---------------------------------------------------------------------------
// CASE 7 — A HYPOTHESIS CANNOT REACH THE VERDICT, AND THERE IS NO SLOT FOR ONE
//
// This is the structural version of "a guess never pages anyone". The verdict
// input type has no hypothesis count, so a well-meaning future change that
// wanted hypotheses to raise an alarm cannot be made by passing an extra
// argument — it would have to change the contract, in public, on purpose.
// ---------------------------------------------------------------------------

const verdictFromAGuess = computeFleetHealthVerdict({
  correlationCount: 0,
  agentsFailing: 0,
  // @ts-expect-error — FleetHealthVerdictInput has no `hypothesisCount`, by design
  hypothesisCount: 9,
  complete: true,
})

// ---------------------------------------------------------------------------
// Runtime half: the rules a gate and an incident screen actually read.
// ---------------------------------------------------------------------------

describe('observed/hypothesis conflation is a COMPILE error (see @ts-expect-error cases above)', () => {
  it('documents what this file proves at compile time', () => {
    // These values exist only so the compile-time cases above are not dead
    // code to the linter. The assertion that matters already happened: this
    // file typechecking AT ALL means every `@ts-expect-error` above found a
    // real error, and any weakening of the contract turns each unused
    // directive into a typecheck failure.
    expect([notObserved, notHypothesis, notObserved2, notHypothesis2]).toHaveLength(4)
    expect([disguisedHypothesis, disguisedObservation]).toHaveLength(2)
    expect([wrongPage, wrongPage2]).toHaveLength(2)
    expect([evidenceless, denominatorless, groundless]).toHaveLength(3)
    expect(unmeasuredBaseRate.unaffectedSharing).toBeNull()
    expect(verdictFromAGuess).toBeDefined()
    expect(typeof flattenNaively).toBe('function')
    expect(typeof flattenNaively2).toBe('function')
    expect(typeof crossTheStreams).toBe('function')
    expect(flattenDeliberately(observed)).toContain('recorded')
    expect(flattenDeliberately(hypothesis)).toContain('Could the shared model')
  })

  it('keeps facts and guesses in separate arrays, with no union to flatten them through', () => {
    expect(report.correlations.every((c) => c.certainty === 'observed')).toBe(true)
    expect(report.hypotheses.every((h) => h.certainty === 'hypothesis')).toBe(true)
    // Every observation cites at least one recorded failure. Guaranteed by the
    // tuple type; asserted here because it is the property an operator relies
    // on when they click from a claim through to the runs behind it.
    for (const correlation of report.correlations) {
      expect(correlation.observedBy.length).toBeGreaterThan(0)
    }
    // Every hypothesis names an observation that is actually in the report.
    expect(orphanHypotheses(report)).toHaveLength(0)
    expect(hypothesesFor(report, observed.correlationKey)).toHaveLength(1)
  })

  it('an orphan hypothesis — one resting on an absent observation — is detectable, and is what the SDK refuses', () => {
    const orphaned: FleetHealthReport = { ...report, correlations: [] }
    expect(orphanHypotheses(orphaned)).toHaveLength(1)
  })
})

describe('computeFleetHealthVerdict — the single rule every surface states', () => {
  it('an OBSERVATION outranks an incomplete sweep: it is never downgraded to indeterminate', () => {
    // This precedence matters more here than in `compat`. Data volume spikes
    // during an incident, so the sweep is likeliest to truncate DURING the
    // event this command exists to catch. Demoting the observation would
    // silence the alarm precisely when it is right.
    expect(computeFleetHealthVerdict({ correlationCount: 1, agentsFailing: 12, complete: false })).toBe(
      'correlated_failures'
    )
    expect(computeFleetHealthVerdict({ correlationCount: 1, agentsFailing: 12, complete: true })).toBe(
      'correlated_failures'
    )
  })

  it('an incomplete sweep with nothing correlated is INDETERMINATE, never healthy', () => {
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 0, complete: false })).toBe('indeterminate')
    // Failing agents do not rescue an incomplete sweep into "isolated
    // failures" — that phrasing asserts nothing CONNECTS them, which an
    // unfinished sweep has not established.
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 7, complete: false })).toBe('indeterminate')
  })

  it('only a COMPLETE sweep with nothing correlated can say healthy', () => {
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 0, complete: true })).toBe('healthy')
    expect(computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 7, complete: true })).toBe(
      'isolated_failures'
    )
  })
})

describe('completeness is not vacuously true on an empty sweep', () => {
  const scan = report.scan

  it('a sweep that assessed NOTHING is incomplete, even though nothing went wrong', () => {
    // The category error this codebase has now hit in several layers: a
    // predicate built only from negative clauses ("nothing truncated, nothing
    // skipped, no pages left") is TRUE on the empty input, and an empty input
    // fed to the verdict rule produces an org-wide all-clear derived from zero
    // agents.
    const empty = { ...scan, agentsInRoster: 0, agentsAssessed: 0, occurrencesScanned: 0 }
    expect(isFleetHealthScanComplete(empty)).toBe(false)
    expect(fleetHealthReportVerdict({ ...report, correlations: [], hypotheses: [], agentsFailing: 0, scan: empty })).toBe(
      'indeterminate'
    )
  })

  it('a PAGE-LOCAL correlation basis can never be complete, however clean it looks', () => {
    // The invariant specific to this altitude. A burst of twelve agents split
    // across two roster pages is a cluster of four and a cluster of eight to a
    // page-local engine, both possibly under threshold — so the incident is
    // invisible on every page and in any merge of them, silently.
    const pageLocal = { ...scan, correlationBasis: 'page_local' as const }
    expect(isFleetHealthScanComplete(pageLocal)).toBe(false)
    expect(
      fleetHealthReportVerdict({ ...report, correlations: [], hypotheses: [], agentsFailing: 0, scan: pageLocal })
    ).toBe('indeterminate')
  })

  it('a truncated sweep, skipped agents, unassessable agents, or an outstanding cursor each block completeness', () => {
    for (const broken of [
      { ...scan, scanTruncated: true },
      { ...scan, agentsUnassessable: 3 },
      { ...scan, agentsSkippedForBudget: 40 },
      { ...scan, nextCursor: 'c_2' },
    ]) {
      expect(isFleetHealthScanComplete(broken)).toBe(false)
    }
  })

  it('an UNANSWERED QUESTION makes the analysis incomplete even under a whole, untruncated sweep', () => {
    const withQuestion: FleetHealthReport = {
      ...report,
      correlations: [],
      hypotheses: [],
      agentsFailing: 0,
      unanswered: [unanswered],
    }
    expect(isFleetHealthScanComplete(withQuestion.scan)).toBe(true)
    expect(isFleetHealthAnalysisComplete(withQuestion)).toBe(false)
    expect(fleetHealthReportVerdict(withQuestion)).toBe('indeterminate')
  })

  it('a whole, clean sweep says healthy — the boundary is one assessed agent, not many', () => {
    const clean: FleetHealthReport = {
      ...report,
      correlations: [],
      hypotheses: [],
      agentsFailing: 0,
      roster: [],
      scan: { ...scan, agentsInRoster: 1, agentsAssessed: 1 },
    }
    expect(fleetHealthReportVerdict(clean)).toBe('healthy')
  })
})

describe('discriminationOf — the denominator is three-valued, never a boolean', () => {
  it('an attribute the healthy agents share too is NOT DISCRIMINATING, and says so', () => {
    // The sentence this exists to defuse: "all 12 failing agents use model
    // m-4" — when 198 of 200 agents use m-4.
    expect(
      discriminationOf({
        affectedSharing: 12,
        affectedTotal: 12,
        unaffectedSharing: 186,
        unaffectedTotal: 188,
        measurementTruncated: false,
      })
    ).toBe('not_discriminating')
  })

  it('an attribute concentrated in the failing agents is DISCRIMINATING — still not proof', () => {
    expect(discriminationOf(hypothesis.sharedBy)).toBe('discriminating')
  })

  it('NOT MEASURED is its own answer and is never read as zero', () => {
    expect(discriminationOf(unmeasuredBaseRate)).toBe('base_rate_unmeasured')
    // The critical pair: `null` (not measured — no support at all) vs `0`
    // (measured, and no healthy agent shares it — the strongest support a
    // hypothesis can have). A boolean return type would have to render these
    // identically.
    expect(
      discriminationOf({ ...unmeasuredBaseRate, unaffectedSharing: 0, unaffectedTotal: 140 })
    ).toBe('discriminating')
  })

  it('a truncated measurement is unmeasured, however favourable the numbers look', () => {
    expect(discriminationOf({ ...hypothesis.sharedBy, measurementTruncated: true })).toBe('base_rate_unmeasured')
  })

  it('an empty comparison group is unmeasured, not a perfect score', () => {
    expect(
      discriminationOf({
        affectedSharing: 12,
        affectedTotal: 12,
        unaffectedSharing: 0,
        unaffectedTotal: 0,
        measurementTruncated: false,
      })
    ).toBe('base_rate_unmeasured')
  })
})

describe('rankFleetCorrelations — breadth first, recency only as a tiebreak', () => {
  const wide: ObservedCorrelation = { ...observed, correlationKey: 'wide', agentCount: 12, lastObservedAt: 1_000 }
  const narrowButRecent: ObservedCorrelation = {
    ...observed,
    correlationKey: 'narrow',
    agentCount: 2,
    firstObservedAt: 1,
    lastObservedAt: 9_999_999,
    observedBy: [{ ...occurrence, occurredAt: 500 }],
  }

  it('never lets the most RECENT cluster displace the BROADEST one', () => {
    // During an incident the newest cluster is usually a downstream symptom
    // (retries piling up, a queue draining into a second agent) and the
    // broadest is usually nearest what actually changed. Sorting by recency
    // puts the symptom on screen and the cause below the fold, and the person
    // reading has about ninety seconds.
    expect(rankFleetCorrelations([narrowButRecent, wide]).map((c) => c.correlationKey)).toEqual(['wide', 'narrow'])
  })

  it('orders by recency only WITHIN equal breadth, and is total so the view does not shuffle', () => {
    const older: ObservedCorrelation = { ...observed, correlationKey: 'a', agentCount: 5, lastObservedAt: 100 }
    const newer: ObservedCorrelation = { ...observed, correlationKey: 'b', agentCount: 5, lastObservedAt: 200 }
    expect(rankFleetCorrelations([older, newer]).map((c) => c.correlationKey)).toEqual(['b', 'a'])
    const tied: ObservedCorrelation = { ...newer, correlationKey: 'a2' }
    expect(rankFleetCorrelations([newer, tied]).map((c) => c.correlationKey)).toEqual(['a2', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [narrowButRecent, wide]
    rankFleetCorrelations(input)
    expect(input.map((c) => c.correlationKey)).toEqual(['narrow', 'wide'])
  })
})

describe('isCorrelationSelfConsistent — an observation must agree with its own evidence', () => {
  it('accepts a burst whose citations lie inside the window it claims', () => {
    expect(isCorrelationSelfConsistent(observed)).toBe(true)
  })

  it('rejects a "four minute burst" citing a failure from a day earlier', () => {
    // The fleet-level counterpart of "a proven divergence must cite the event
    // it contradicts". Mislabelling a wide scan as a burst manufactures an
    // incident out of ordinary background failure — at the moment someone is
    // looking for permission to roll something back.
    const mislabelled: ObservedCorrelation = {
      ...observed,
      observedBy: [{ ...occurrence, occurredAt: observed.firstObservedAt - 86_400_000 }],
    }
    expect(isCorrelationSelfConsistent(mislabelled)).toBe(false)
  })

  it('rejects an inverted window, and an agentCount smaller than the agents it lists', () => {
    expect(isCorrelationSelfConsistent({ ...observed, lastObservedAt: observed.firstObservedAt - 1 })).toBe(false)
    expect(isCorrelationSelfConsistent({ ...observed, agentCount: 1 })).toBe(false)
  })

  it('does not check timeless declared-attribute citations against a time window', () => {
    const declared: ObservedCorrelation = {
      ...observed,
      kind: 'shared_declared_attribute',
      observedBy: [
        {
          cites: 'declared_attribute',
          agentId: 'ag_1',
          agentVersionId: 'ver_1',
          declaredConfigPath: 'model.models[]',
          declaredValue: 'm-4',
        },
      ],
    }
    expect(isCorrelationSelfConsistent(declared)).toBe(true)
  })
})
