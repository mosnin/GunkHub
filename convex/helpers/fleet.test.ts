/* eslint-disable */
/**
 * FLEET HEALTH & CROSS-AGENT CORRELATION — pure engine verification.
 *
 * Six properties dominate, and each maps to a section below:
 *
 *  (A) CORRELATION IS NEVER REPORTED AS CAUSATION. Structural (the three
 *      contract types are mutually unassignable), textual (no observation
 *      asserts a mechanism), relational (every hypothesis names a correlation
 *      present in the same report — `orphanHypotheses` is empty), and
 *      arithmetic (`null` in a base rate never renders as `0`).
 *
 *  (B) A BURST IS DETECTED AND A COINCIDENCE IS NOT. Including the case that
 *      motivates the design: a baseline the scan could not read must NOT turn
 *      an ordinary concentration into an unprecedented one.
 *
 *  (C) AN EMPTY OR TRUNCATED FLEET NEVER READS AS HEALTHY.
 *
 *  (D) THE COMPLETENESS PREDICATES ARE NOT VACUOUS.
 *
 *  (E) THE CORRELATION PASS RAN OVER THE WHOLE ROSTER, and says so honestly.
 *      A page-local basis can never be complete.
 *
 *  (F) EVERY CORRELATION'S CITATION SAMPLE SPANS DISTINCT AGENTS — the
 *      invariant the contract deliberately cannot check, because `observedBy`
 *      is a bounded sample. This is the difference between "twelve agents are
 *      failing" and "one agent failed twelve times".
 */
import { describe, it, expect } from 'vitest'

import {
  discriminationOf,
  correlationIncoherences,
  isCorrelationSelfConsistent,
  isFleetHealthAnalysisComplete,
  isFleetHealthScanComplete,
  fleetHealthReportVerdict,
  fleetReportIncoherences,
  hypothesisQuestion,
  orphanHypotheses,
  SHARED_ATTRIBUTE_HYPOTHESIS_KINDS,
  computeFleetHealthVerdict,
  type HypothesisedCause,
  type ObservedCorrelation,
  type UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'

import {
  citationsSpanDistinctAgents,
  citationsSpanningAgents,
  computeOnsets,
  declaredValuesAt,
  foldFleetCorrelation,
  isBaselineEstablished,
  isRunPopulationMeasurable,
  measureShare,
  peakConcentration,
  type FleetAgentDeclarationInput,
  type FleetBaselineCoverage,
  type FleetOccurrenceInput,
  type FleetPatternInput,
  type FleetRunInput,
} from './fleet'
import { readConfigSnapshot } from './divergence'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let seq = 0
function occ(agentId: string, hash: string, atMs: number, heuristicClass = 'tool_error'): FleetOccurrenceInput {
  seq += 1
  return { occurrenceId: `occ_${seq}`, runId: `run_${seq}`, agentId, fingerprintHash: hash, heuristicClass, occurredAt: atMs }
}

function run(agentId: string, atMs: number, status = 'completed', agentVersionId?: string): FleetRunInput {
  seq += 1
  return { runId: `r_${seq}`, agentId, startedAt: atMs, status, ...(agentVersionId ? { agentVersionId } : {}) }
}

function pattern(hash: string, extra: Partial<FleetPatternInput> = {}): FleetPatternInput {
  return { fingerprintHash: hash, label: `label ${hash}`, patternClass: 'tool_error', muted: false, status: 'open', ...extra }
}

function decl(agentId: string, model: string, extra: Record<string, unknown> = {}): FleetAgentDeclarationInput {
  return {
    agentId,
    agentVersionId: `ver_${agentId}`,
    configSnapshot: { model, tools: [{ name: 'search_web' }], capabilities: ['vector_store'], ...extra },
  }
}

/** A baseline in which everything is established. Tests degrade it deliberately. */
function baselineCov(over: Partial<FleetBaselineCoverage> = {}): FleetBaselineCoverage {
  return {
    baselineWindowStartAt: T0 - 7 * DAY,
    baselineWindowEndAt: T0,
    baselineOccurrencesExamined: 20,
    baselineScanTruncated: false,
    baselineRunsObserved: 900,
    baselineRollupTruncated: false,
    ...over,
  }
}

const AGENTS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => ({ agentId: id, name: `agent ${id}` }))

function fold(over: Partial<Parameters<typeof foldFleetCorrelation>[0]> = {}) {
  return foldFleetCorrelation({
    analyzedAt: T0 + DAY,
    agents: AGENTS,
    occurrences: [],
    baselineOccurrences: [],
    runs: [],
    patterns: [],
    declarations: [],
    baseline: baselineCov(),
    burstWindowMs: HOUR,
    minDistinctAgents: 3,
    since: T0,
    until: T0 + DAY,
    rosterTruncated: false,
    occurrenceScanTruncated: false,
    declarationScanTruncated: false,
    rosterListingLimit: 200,
    ...over,
  })
}

/** Five agents adopt fingerprint FP1 within 20 minutes. The canonical burst. */
function burstOccurrences(): FleetOccurrenceInput[] {
  return [
    occ('a1', 'FP1', T0 + 10 * HOUR),
    occ('a2', 'FP1', T0 + 10 * HOUR + 4 * MIN),
    occ('a3', 'FP1', T0 + 10 * HOUR + 9 * MIN),
    occ('a4', 'FP1', T0 + 10 * HOUR + 14 * MIN),
    occ('a5', 'FP1', T0 + 10 * HOUR + 19 * MIN),
  ]
}

/** Everyone ran; a1..a5 declare gpt-4o, a6 declares claude-x. */
function runsAndDeclarations() {
  const runs = AGENTS.map((a, i) => run(a.agentId, T0 + 9 * HOUR, i < 5 ? 'failed' : 'completed', `ver_${a.agentId}`))
  const declarations = AGENTS.map((a, i) => decl(a.agentId, i < 5 ? 'gpt-4o' : 'claude-x'))
  return { runs, declarations }
}

function burstFold(over: Partial<Parameters<typeof foldFleetCorrelation>[0]> = {}) {
  const { runs, declarations } = runsAndDeclarations()
  return fold({ occurrences: burstOccurrences(), runs, declarations, patterns: [pattern('FP1')], ...over })
}

// ===========================================================================
// (A) CORRELATION IS NEVER REPORTED AS CAUSATION
// ===========================================================================

describe('A. correlation is never reported as causation', () => {
  it('STRUCTURAL: the three contract bands are mutually unassignable', () => {
    const observed: ObservedCorrelation = {
      certainty: 'observed',
      kind: 'shared_failure_fingerprint',
      correlationKey: 'shared_fingerprint:FP1',
      observedFact: '3 agents recorded FP1',
      agentIds: ['a1', 'a2', 'a3'],
      agentCount: 3,
      firstObservedAt: T0,
      lastObservedAt: T0 + MIN,
      observedBy: [{ cites: 'failure_occurrence', agentId: 'a1', runId: 'r1', fingerprintHash: 'FP1', occurredAt: T0 }],
    }
    const hypothesis: HypothesisedCause = {
      certainty: 'hypothesis',
      kind: 'shared_model',
      hypothesisKey: 'h',
      sharedValue: 'm-4',
      restingOn: ['shared_fingerprint:FP1'],
      notEstablishedBecause: 'co-occurrence only',
      sharedBy: { affectedSharing: 3, affectedTotal: 3, unaffectedSharing: null, unaffectedTotal: null, measurementTruncated: true },
      wouldBeTestedBy: 'move one agent off m-4',
    }
    const unanswered: UnansweredFleetQuestion = {
      certainty: 'unanswered',
      kind: 'roster_incomplete',
      questionKey: 'q',
      undecidedQuestion: 'whether more agents failed',
      unknownBecause: 'the roster ceiling was reached',
    }

    // @ts-expect-error a hypothesis has no `observedBy` and no `observedFact`
    const bad1: ObservedCorrelation = hypothesis
    // @ts-expect-error an observation has no `restingOn`, `sharedBy` or `wouldBeTestedBy`
    const bad2: HypothesisedCause = observed
    // @ts-expect-error an unanswered question has no `observedBy`
    const bad3: ObservedCorrelation = unanswered
    void bad1; void bad2; void bad3

    // No shared text field to read all three through uniformly.
    // @ts-expect-error
    void observed.message
    // @ts-expect-error
    void hypothesis.message
    // A hypothesis has nowhere to put evidence...
    // @ts-expect-error
    void hypothesis.observedBy
    // ...and no score to be promoted by.
    // @ts-expect-error
    void hypothesis.confidence
  })

  it('a five-agent burst yields observed CORRELATIONS and separately-filed HYPOTHESES', () => {
    const { report } = burstFold()
    expect(report.correlations.length).toBeGreaterThan(0)
    expect(report.hypotheses.length).toBeGreaterThan(0)
    expect(report).not.toHaveProperty('findings')
    for (const c of report.correlations) expect(c.certainty).toBe('observed')
    for (const h of report.hypotheses) expect(h.certainty).toBe('hypothesis')
  })

  it('NO ORPHAN HYPOTHESES: every hypothesis names a correlation present in the same report', () => {
    const { report } = burstFold()
    expect(orphanHypotheses(report)).toEqual([])
    const keys = new Set(report.correlations.map((c) => c.correlationKey))
    for (const h of report.hypotheses) {
      expect(h.restingOn.length).toBeGreaterThan(0)
      for (const key of h.restingOn) expect(keys.has(key)).toBe(true)
    }
  })

  it('no observation asserts a mechanism; every hypothesis is conditional and carries its test', () => {
    const { report } = burstFold()
    const CAUSAL = /\bcaused\b|\bbecause of\b|\bdue to\b|\bled to\b|\bresulted in\b|\bis why\b|\bis degrading\b/i
    for (const c of report.correlations) {
      expect(c.observedFact).not.toMatch(CAUSAL)
      expect(c.observedBy.length).toBeGreaterThan(0)
      expect(isCorrelationSelfConsistent(c)).toBe(true)
    }
    for (const h of report.hypotheses) {
      // The operator-facing line is COMPOSED by the contract and is always a
      // QUESTION. This engine has no field in which to assert a mechanism.
      expect(hypothesisQuestion(h)).toMatch(/\?$/)
      expect(h).not.toHaveProperty('candidateExplanation')
      expect(h.notEstablishedBecause.length).toBeGreaterThan(20)
      expect(h.wouldBeTestedBy.length).toBeGreaterThan(20)
      // Shared-attribute kinds must name the value, or the composed question is
      // "Could the shared model explain this?" — about nothing in particular.
      if (SHARED_ATTRIBUTE_HYPOTHESIS_KINDS.includes(h.kind)) {
        expect(h.sharedValue).toBeTruthy()
      }
    }
  })

  it('THE DENOMINATOR: a fleet-wide attribute is reported as NOT DISCRIMINATING', () => {
    // a1..a5 burst and declare gpt-4o; a6 is fine and declares claude-x.
    // But ALL SIX declare tool `search_web` and capability `vector_store`.
    const { report } = burstFold()

    const model = report.hypotheses.find((h) => h.kind === 'shared_model')!
    expect(model.sharedBy).toEqual({
      affectedSharing: 5,
      affectedTotal: 5,
      unaffectedSharing: 0,
      unaffectedTotal: 1,
      measurementTruncated: false,
    })
    expect(discriminationOf(model.sharedBy)).toBe('discriminating')

    const tool = report.hypotheses.find((h) => h.kind === 'shared_tool')!
    expect(tool.sharedBy.unaffectedSharing).toBe(1)
    expect(tool.sharedBy.unaffectedTotal).toBe(1)
    // "All 5 failing agents use search_web" is equally true and explains nothing.
    expect(discriminationOf(tool.sharedBy)).toBe('not_discriminating')
  })

  it('`null` NEVER RENDERS AS `0`: an unmeasured base rate is unrankable, not strong support', () => {
    // unaffectedSharing: 0 is the STRONGEST support ("we checked the healthy
    // agents and none share it"). null is NO support. They must not collapse.
    const strongest = { affectedSharing: 5, affectedTotal: 5, unaffectedSharing: 0, unaffectedTotal: 40, measurementTruncated: false }
    const nothing = { affectedSharing: 5, affectedTotal: 5, unaffectedSharing: null, unaffectedTotal: null, measurementTruncated: true }
    expect(discriminationOf(strongest)).toBe('discriminating')
    expect(discriminationOf(nothing)).toBe('base_rate_unmeasured')

    const { report } = burstFold({ declarationScanTruncated: true })
    for (const h of report.hypotheses) {
      expect(h.sharedBy.unaffectedSharing).toBeNull()
      expect(h.sharedBy.unaffectedTotal).toBeNull()
      expect(discriminationOf(h.sharedBy)).toBe('base_rate_unmeasured')
    }
    expect(report.unanswered.map((u) => u.questionKey)).toContain('base_rate_unmeasurable')
    expect(report.scan.baseRatesMeasured).toBe(false)
  })

  it('measureShare only counts agents whose declaration was READ as examined', () => {
    const declarations = new Map([
      ['a1', readConfigSnapshot({ model: 'm-4' })],
      ['a2', readConfigSnapshot({ model: 'm-4' })],
      // a3 declares NOTHING. It is not an agent that uses a different model.
      ['a3', readConfigSnapshot(undefined)],
    ])
    const m = measureShare({
      affectedAgentIds: ['a1'],
      unaffectedAgentIds: ['a2', 'a3'],
      declarations,
      path: 'model.models[]',
      value: 'm-4',
      populationMeasurable: true,
    })
    // a3 is excluded from the denominator entirely rather than counted as
    // "does not share", which would understate the base rate.
    expect(m.unaffectedTotal).toBe(1)
    expect(m.unaffectedSharing).toBe(1)
  })

  it('an UNDECLARED attribute yields an unanswered question, never a partial hypothesis', () => {
    // a3 declares no model. "4 of 5 share gpt-4o" is the sentence that gets
    // read as "they all do" during an incident, so it is not emitted.
    const { runs } = runsAndDeclarations()
    const declarations = AGENTS.map((a, i) =>
      a.agentId === 'a3'
        ? { agentId: 'a3', agentVersionId: 'ver_a3', configSnapshot: { tools: [{ name: 'search_web' }], capabilities: ['vector_store'] } }
        : decl(a.agentId, i < 5 ? 'gpt-4o' : 'claude-x'),
    )
    const { report } = fold({ occurrences: burstOccurrences(), runs, declarations, patterns: [pattern('FP1')] })

    expect(report.hypotheses.some((h) => h.kind === 'shared_model')).toBe(false)
    const q = report.unanswered.find((u) => u.kind === 'attribute_undeclared')!
    expect(q.unknownBecause).toMatch(/absent declaration is not evidence of a different value/)
    expect(q.agentIds).toContain('a3')
  })

  it('`unattributed` is sayable: a burst with nothing shared names nothing', () => {
    // Four agents burst; all declare DIFFERENT models, tools and capabilities.
    const occurrences = [
      occ('a1', 'FP_A', T0 + 10 * HOUR),
      occ('a2', 'FP_B', T0 + 10 * HOUR + 6 * MIN),
      occ('a3', 'FP_C', T0 + 10 * HOUR + 12 * MIN),
      occ('a4', 'FP_D', T0 + 10 * HOUR + 18 * MIN),
    ]
    const runs = AGENTS.map((a) => run(a.agentId, T0 + 9 * HOUR, 'failed', `ver_${a.agentId}`))
    const declarations = AGENTS.map((a, i) => ({
      agentId: a.agentId,
      agentVersionId: `ver_${a.agentId}`,
      configSnapshot: { model: `model-${i}`, tools: [{ name: `tool-${i}` }], capabilities: [`cap-${i}`] },
    }))
    const { report } = fold({ occurrences, runs, declarations })

    const un = report.hypotheses.find((h) => h.kind === 'unattributed')!
    expect(un).toBeDefined()
    expect(un.sharedValue).toBeUndefined()
    expect(hypothesisQuestion(un)).toMatch(/nothing shared could be named/)
    expect(un.notEstablishedBecause).toMatch(/absence of one is not evidence that the agents are unrelated/)
    expect(orphanHypotheses(report)).toEqual([])
  })

  it('A HYPOTHESIS CANNOT MOVE THE VERDICT: the verdict fn has no parameter for one', () => {
    const { report } = burstFold()
    expect(report.hypotheses.length).toBeGreaterThan(0)
    // The report's verdict is exactly what the contract derives from its own
    // contents — correlations and failing agents only.
    expect(report.verdict).toBe(fleetHealthReportVerdict(report))
    // @ts-expect-error there is no `hypothesisCount` to pass
    computeFleetHealthVerdict({ correlationCount: 0, agentsFailing: 0, complete: true, hypothesisCount: 5 })
  })
})

// ===========================================================================
// (B) A BURST IS DETECTED AND A COINCIDENCE IS NOT
// ===========================================================================

describe('B. burst detection vs coincidence', () => {
  it('detects a five-agent burst and states the baseline it beat', () => {
    const baselineOccurrences = [
      occ('a1', 'FP1', T0 - 6 * DAY),
      occ('a2', 'FP1', T0 - 4 * DAY),
      occ('a3', 'FP1', T0 - 2 * DAY),
    ]
    const { report } = burstFold({ baselineOccurrences })

    const burst = report.correlations.find((c) => c.kind === 'temporal_burst')!
    expect(burst.agentCount).toBe(5)
    expect(burst.observedFact).toMatch(/the peak over any equal window was 1/)
    expect(report.verdict).toBe('correlated_failures')

    const shared = report.correlations.find((c) => c.kind === 'shared_failure_fingerprint')!
    expect(shared.agentCount).toBe(5)
  })

  it('THE TRAP: a truncated baseline must NOT manufacture an unprecedented burst', () => {
    // The fleet's real baseline peak is 5, but the baseline scan hit its
    // ceiling and read nothing. The naive engine compares 5 against 0 and
    // shouts. This one must refuse the comparison entirely.
    const { report, baselineEstablished } = burstFold({
      baselineOccurrences: [],
      baseline: baselineCov({ baselineScanTruncated: true, baselineOccurrencesExamined: 0 }),
    })

    expect(baselineEstablished).toBe(false)
    const burst = report.correlations.find((c) => c.kind === 'temporal_burst')!
    // The burst is still reported IN FULL — an existence claim survives
    // truncation — but the "versus normal" sentence is ABSENT, not hedged.
    expect(burst.agentCount).toBe(5)
    expect(burst.observedFact).not.toMatch(/baseline/)
    expect(burst.observedFact).not.toMatch(/peak over any equal window/)

    const q = report.unanswered.find((u) => u.questionKey === 'baseline_not_established')!
    expect(q.undecidedQuestion).toMatch(/abnormal/)
    expect(q.unknownBecause).toMatch(/only a lower bound/)
  })

  it('an IDLE baseline is not a baseline: a switched-off week cannot make today anomalous', () => {
    const { report, baselineEstablished } = burstFold({ baseline: baselineCov({ baselineRunsObserved: 0 }) })
    expect(baselineEstablished).toBe(false)
    expect(report.correlations.find((c) => c.kind === 'temporal_burst')!.observedFact).not.toMatch(/baseline/)
    expect(report.unanswered.find((u) => u.questionKey === 'baseline_not_established')!.unknownBecause).toMatch(
      /recorded no runs during the baseline period/,
    )
  })

  it('ONE loud agent is not a fleet burst: onsets count AGENTS, not occurrences', () => {
    const noisy: FleetOccurrenceInput[] = []
    for (let i = 0; i < 60; i++) noisy.push(occ('a1', 'FP1', T0 + 10 * HOUR + i * MIN))
    expect(computeOnsets(noisy)).toHaveLength(1)

    const { runs, declarations } = runsAndDeclarations()
    const { report } = fold({ occurrences: noisy, runs, declarations, patterns: [pattern('FP1')] })
    expect(report.correlations.some((c) => c.kind === 'temporal_burst')).toBe(false)
    expect(report.correlations.some((c) => c.kind === 'shared_failure_fingerprint')).toBe(false)
    // Still visible as that agent failing.
    expect(report.roster.find((a) => a.agentId === 'a1')!.state).toBe('failing')
  })

  it('agents spread beyond the window W are not a burst, but ARE a shared fingerprint', () => {
    const spread = [occ('a1', 'FP1', T0 + 1 * HOUR), occ('a2', 'FP1', T0 + 5 * HOUR), occ('a3', 'FP1', T0 + 9 * HOUR)]
    const { runs, declarations } = runsAndDeclarations()
    const { report } = fold({ occurrences: spread, runs, declarations, patterns: [pattern('FP1')], burstWindowMs: HOUR })
    expect(report.correlations.some((c) => c.kind === 'temporal_burst')).toBe(false)
    expect(report.correlations.some((c) => c.kind === 'shared_failure_fingerprint')).toBe(true)
  })

  it('catches a HETEROGENEOUS burst: agents failing together with DIFFERENT fingerprints', () => {
    // The realistic provider outage: one upstream fault, four error shapes. No
    // fingerprint-scoped view can see this.
    const occurrences = [
      occ('a1', 'FP_TIMEOUT', T0 + 10 * HOUR, 'timeout'),
      occ('a2', 'FP_SCHEMA', T0 + 10 * HOUR + 6 * MIN, 'schema_error'),
      occ('a3', 'FP_RATELIMIT', T0 + 10 * HOUR + 12 * MIN, 'rate_limit'),
      occ('a4', 'FP_OTHER', T0 + 10 * HOUR + 18 * MIN, 'timeout'),
    ]
    const { runs, declarations } = runsAndDeclarations()
    const { report } = fold({ occurrences, runs, declarations })

    expect(report.correlations.some((c) => c.kind === 'shared_failure_fingerprint')).toBe(false)
    const burst = report.correlations.find((c) => c.kind === 'temporal_burst')!
    expect(burst.agentCount).toBe(4)
    expect(burst.observedFact).toMatch(/across 4 distinct fingerprints and 3 failure class\(es\)/)
  })

  it('peakConcentration sweeps correctly, keeps the earliest peak, and fits windowMs', () => {
    const onsets = computeOnsets([
      occ('a1', 'F', T0),
      occ('a2', 'F', T0 + 10 * MIN),
      occ('a3', 'F', T0 + 20 * MIN),
      occ('a4', 'F', T0 + 5 * HOUR),
      occ('a5', 'F', T0 + 5 * HOUR + 10 * MIN),
      occ('a6', 'F', T0 + 5 * HOUR + 20 * MIN),
    ])
    const peak = peakConcentration(onsets, HOUR)!
    expect(peak.distinctAgentCount).toBe(3)
    expect(peak.startAt).toBe(T0)
    expect(peak.endAt - peak.startAt).toBeLessThanOrEqual(HOUR)
    expect(peakConcentration([], HOUR)).toBeNull()
  })

  it('window bounds are INCLUSIVE: exactly W apart still counts', () => {
    const onsets = computeOnsets([occ('a1', 'F', T0), occ('a2', 'F', T0 + 30 * MIN), occ('a3', 'F', T0 + HOUR)])
    expect(peakConcentration(onsets, HOUR)!.distinctAgentCount).toBe(3)
    expect(peakConcentration(onsets, HOUR - 1)!.distinctAgentCount).toBe(2)
  })

  it('burstWindowMs is echoed EXACTLY into the scan', () => {
    const { report } = burstFold({ burstWindowMs: 4 * MIN })
    expect(report.scan.burstWindowMs).toBe(4 * MIN)
    expect(report.scan.since).toBe(T0)
    expect(report.scan.until).toBe(T0 + DAY)
  })
})

// ===========================================================================
// (C) AN EMPTY OR TRUNCATED FLEET NEVER READS AS HEALTHY
// ===========================================================================

describe('C. empty and truncated fleets never read as healthy', () => {
  it('a completely empty org is INDETERMINATE, not healthy', () => {
    const { report } = fold({ agents: [] })
    expect(report.verdict).toBe('indeterminate')
    expect(report.roster).toHaveLength(0)
    expect(report.correlations).toHaveLength(0)
    expect(isFleetHealthScanComplete(report.scan)).toBe(false)
  })

  it('a roster of agents that ran NOTHING is unobserved, never healthy', () => {
    const { report } = fold({ runs: [] })
    expect(report.roster.every((a) => a.state === 'unobserved')).toBe(true)
    expect(report.roster.some((a) => a.state === 'healthy')).toBe(false)
    // agentsAssessed > 0, nothing truncated -> the scan is "complete", and the
    // verdict is `healthy` ONLY if nothing is failing. Six unobserved agents
    // are not failing, so this is the case that must NOT read as an all-clear.
    expect(report.agentsFailing).toBe(0)
    // ...which is why `unobserved` is its own state and the CLI/UI must render
    // it as "not tested". The verdict is honest about correlations, and the
    // roster is honest that nothing was tested.
    expect(report.roster.map((a) => a.runsObserved)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('an agent with runs and no failures IS healthy — the engine is not merely pessimistic', () => {
    const { report } = fold({ runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)) })
    expect(report.roster.every((a) => a.state === 'healthy')).toBe(true)
    expect(report.verdict).toBe('healthy')
    expect(isFleetHealthAnalysisComplete(report)).toBe(true)
  })

  it('a TRUNCATED occurrence scan can never be complete, and marks every row truncated', () => {
    const { report } = fold({
      runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)),
      occurrenceScanTruncated: true,
    })
    expect(report.scan.correlationBasis).toBe('page_local')
    expect(report.scan.scanTruncated).toBe(true)
    expect(isFleetHealthScanComplete(report.scan)).toBe(false)
    expect(report.verdict).toBe('indeterminate')
    expect(report.roster.every((a) => a.observationTruncated)).toBe(true)
    expect(report.unanswered.map((u) => u.kind)).toContain('occurrence_history_truncated')
  })

  it('`unobserved` outranks `healthy` in the roster order', () => {
    const { report } = fold({ runs: [run('a1', T0 + HOUR), run('a2', T0 + HOUR)] })
    const states = report.roster.map((a) => a.state)
    expect(states.indexOf('unobserved')).toBeLessThan(states.indexOf('healthy'))
  })

  it('a spiking pattern makes an agent `failing`; the STORED assessment is reused, not recomputed', () => {
    const { report } = fold({
      occurrences: [occ('a1', 'FP1', T0 + HOUR)],
      runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)),
      patterns: [pattern('FP1', { isSpiking: true, spikeAssessedAt: T0 + DAY - MIN })],
    })
    expect(report.roster.find((a) => a.agentId === 'a1')!.state).toBe('failing')
    expect(report.roster[0]!.agentId).toBe('a1')
  })

  it('a STALE spike assessment is flagged rather than trusted silently', () => {
    const { report } = fold({
      occurrences: [occ('a1', 'FP1', T0 + HOUR)],
      runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)),
      patterns: [pattern('FP1', { isSpiking: true, spikeAssessedAt: T0 - 3 * DAY })],
    })
    expect(report.unanswered.map((u) => u.questionKey)).toContain('spike_assessment_stale')
  })

  it('a MUTED pattern is surfaced, never filtered out of the fleet view', () => {
    const { runs, declarations } = runsAndDeclarations()
    const { report } = fold({
      occurrences: burstOccurrences(),
      runs,
      declarations,
      patterns: [pattern('FP1', { muted: true })],
    })
    const shared = report.correlations.find((c) => c.kind === 'shared_failure_fingerprint')!
    expect(shared.agentCount).toBe(5)
    expect(shared.observedFact).toMatch(/alerting for this pattern is MUTED/)
  })

  it('agentsFailing counts over ALL assessed agents, not the truncated listing', () => {
    const { runs, declarations } = runsAndDeclarations()
    const { report } = fold({
      occurrences: burstOccurrences(),
      runs,
      declarations,
      patterns: [pattern('FP1')],
      rosterListingLimit: 2,
    })
    expect(report.roster).toHaveLength(2)
    // Five agents failed; deriving this from the 2-row listing would say 2.
    expect(report.agentsFailing).toBe(5)
    expect(report.scan.agentsAssessed).toBe(6)
    expect(report.scan.nextCursor).toBeDefined()
    expect(isFleetHealthScanComplete(report.scan)).toBe(false)
    // The correlation still saw everyone: the listing limit does not split clusters.
    expect(report.scan.correlationBasis).toBe('whole_roster')
    expect(report.correlations.find((c) => c.kind === 'temporal_burst')!.agentCount).toBe(5)
  })
})

// ===========================================================================
// (D) THE COMPLETENESS PREDICATES ARE NOT VACUOUS
// ===========================================================================

describe('D. completeness predicates assert something positive', () => {
  it('the contract predicate is FALSE on the all-zeros scan a negative-only one green-lights', () => {
    expect(
      isFleetHealthScanComplete({
        since: T0,
        until: T0 + DAY,
        burstWindowMs: HOUR,
        correlationBasis: 'whole_roster',
        agentsInRoster: 0,
        agentsAssessed: 0,
        agentsUnassessable: 0,
        agentsSkippedForBudget: 0,
        occurrencesScanned: 0,
        scanTruncated: false,
        baseRatesMeasured: false,
      }),
    ).toBe(false)
  })

  it('isBaselineEstablished: each positive clause is INDEPENDENTLY load-bearing', () => {
    const empty: FleetBaselineCoverage = {
      baselineWindowStartAt: T0,
      baselineWindowEndAt: T0,
      baselineOccurrencesExamined: 0,
      baselineScanTruncated: false,
      baselineRunsObserved: 0,
      baselineRollupTruncated: false,
    }
    // Nothing truncated, because nothing was read.
    expect(isBaselineEstablished(empty)).toBe(false)
    expect(isBaselineEstablished({ ...empty, baselineWindowEndAt: T0 + DAY })).toBe(false)
    expect(isBaselineEstablished({ ...empty, baselineRunsObserved: 100 })).toBe(false)
    expect(isBaselineEstablished({ ...empty, baselineWindowEndAt: T0 + DAY, baselineRunsObserved: 100 })).toBe(true)
  })

  it('ZERO BASELINE FAILURES is the STRONGEST baseline, not a missing one', () => {
    expect(isBaselineEstablished(baselineCov({ baselineOccurrencesExamined: 0 }))).toBe(true)
  })

  it('isRunPopulationMeasurable requires declarations to have been READ', () => {
    expect(isRunPopulationMeasurable({ declarationsRead: 0, rosterTruncated: false, declarationScanTruncated: false })).toBe(false)
    expect(isRunPopulationMeasurable({ declarationsRead: 5, rosterTruncated: true, declarationScanTruncated: false })).toBe(false)
    expect(isRunPopulationMeasurable({ declarationsRead: 5, rosterTruncated: false, declarationScanTruncated: false })).toBe(true)
  })

  it('declaredValuesAt returns null for an ABSENT declaration and a set for an empty one', () => {
    expect(declaredValuesAt(readConfigSnapshot(undefined), 'model.models[]')).toBeNull()
    expect(declaredValuesAt(readConfigSnapshot({ notAModel: 1 }), 'model.models[]')).toBeNull()
    // Present and genuinely empty is READABLE and different from absent.
    const emptyTools = declaredValuesAt(readConfigSnapshot({ tools: [] }), 'tools[].name')
    expect(emptyTools).not.toBeNull()
    expect(emptyTools!.size).toBe(0)
  })

  it('is deterministic: same rows in, identical report out', () => {
    // The SAME rows twice — `occ()` mints fresh ids per call, so building the
    // fixture twice would test the fixture, not the engine.
    const occurrences = burstOccurrences()
    const { runs, declarations } = runsAndDeclarations()
    const args = { occurrences, runs, declarations, patterns: [pattern('FP1')] }
    expect(JSON.stringify(fold(args).report)).toEqual(JSON.stringify(fold(args).report))
  })
})

// ===========================================================================
// (E) THE CORRELATION PASS RAN OVER THE WHOLE ROSTER
// ===========================================================================

describe('E. correlation basis is declared honestly', () => {
  it('whole_roster only when BOTH the roster and the occurrence scan were exhausted', () => {
    expect(burstFold().report.scan.correlationBasis).toBe('whole_roster')
    expect(burstFold({ rosterTruncated: true }).report.scan.correlationBasis).toBe('page_local')
    expect(burstFold({ occurrenceScanTruncated: true }).report.scan.correlationBasis).toBe('page_local')
  })

  it('a page_local basis can NEVER be complete, even with nothing else wrong', () => {
    const { report } = fold({ runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)), rosterTruncated: true })
    expect(report.scan.correlationBasis).toBe('page_local')
    expect(isFleetHealthScanComplete(report.scan)).toBe(false)
    expect(report.verdict).toBe('indeterminate')
    expect(report.verdict).not.toBe('healthy')
    const q = report.unanswered.find((u) => u.kind === 'roster_incomplete')!
    expect(q.unknownBecause).toMatch(/did not see the whole fleet/)
    expect(q.unknownBecause).toMatch(/FLOOR/)
  })

  it('THE SPLIT-CLUSTER CASE: a 12-agent burst is seen whole, not as two sub-threshold halves', () => {
    const agents = Array.from({ length: 12 }, (_, i) => ({ agentId: `ag${String(i).padStart(2, '0')}`, name: `a${i}` }))
    const occurrences = agents.map((a, i) => occ(a.agentId, 'FP_WIDE', T0 + 10 * HOUR + i * 2 * MIN))
    const runs = agents.map((a) => run(a.agentId, T0 + 9 * HOUR, 'failed', `ver_${a.agentId}`))
    const declarations = agents.map((a) => decl(a.agentId, 'gpt-4o'))

    const { report } = fold({ agents, occurrences, runs, declarations, patterns: [pattern('FP_WIDE')], minDistinctAgents: 6 })
    const burst = report.correlations.find((c) => c.kind === 'temporal_burst')!
    expect(burst.agentCount).toBe(12)
    expect(report.scan.correlationBasis).toBe('whole_roster')
    // Split four-and-eight across pages, a page-local engine with threshold 6
    // would see a 4 and an 8 and report ONE cluster or none. Here it is 12.
    expect(report.verdict).toBe('correlated_failures')
  })
})

// ===========================================================================
// (F) CITATION SAMPLES SPAN DISTINCT AGENTS
// ===========================================================================

describe('F. citation samples span distinct agents', () => {
  it('THE CONTRACT ITSELF finds no incoherence in any report this engine produces', () => {
    // `fleetReportIncoherences` is the contract's own whole-report validator —
    // inverted windows, citations outside the claimed span, a burst wider than
    // the declared `burstWindowMs`, an agentCount contradicting the listed
    // agents, and evidence confined to one agent. Asserted across every shape
    // this engine can emit, not just the happy one.
    const shapes = [
      burstFold(),
      burstFold({ baselineOccurrences: [], baseline: baselineCov({ baselineScanTruncated: true }) }),
      burstFold({ rosterTruncated: true }),
      burstFold({ occurrenceScanTruncated: true }),
      burstFold({ burstWindowMs: 20 * MIN }),
      burstFold({ declarationScanTruncated: true }),
      fold({ runs: AGENTS.map((a) => run(a.agentId, T0 + HOUR)) }),
      fold({ agents: [] }),
    ]
    for (const { report } of shapes) {
      expect(fleetReportIncoherences(report)).toEqual([])
      expect(orphanHypotheses(report)).toEqual([])
      // The server must never disagree with the verdict its own contents imply.
      expect(report.verdict).toBe(fleetHealthReportVerdict(report))
    }
  })

  it('EVERY correlation this engine emits cites distinct agents', () => {
    const { report } = burstFold()
    expect(report.correlations.length).toBeGreaterThan(0)
    for (const c of report.correlations) {
      expect(citationsSpanDistinctAgents(c)).toBe(true)
      const occCitations = c.observedBy.filter((x) => x.cites === 'failure_occurrence')
      if (occCitations.length > 0) {
        expect(new Set(occCitations.map((x) => x.agentId)).size).toBe(occCitations.length)
      }
    }
  })

  it('THE HOLE THE CONTRACT CANNOT CLOSE: one agent failing 12 times must not cite as 12 agents', () => {
    // A correlation claiming 12 agents whose 12 citations are all `ag_1`
    // passes every contract check — self-consistent window, non-empty
    // evidence, agentCount >= agentIds.length. It describes one agent's bug
    // and reads as a fleet incident.
    const forged: ObservedCorrelation = {
      certainty: 'observed',
      kind: 'temporal_burst',
      correlationKey: 'burst:forged',
      observedFact: '12 agents recorded their first in-window failure',
      agentIds: ['ag_1'],
      agentCount: 12,
      firstObservedAt: T0,
      // Wide enough to contain every citation below — so the forgery passes the
      // contract's window check and the ONLY thing that catches it is the
      // distinct-agent guarantee.
      lastObservedAt: T0 + 11 * MIN,
      observedBy: Array.from({ length: 12 }, (_, i) => ({
        cites: 'failure_occurrence' as const,
        agentId: 'ag_1',
        runId: `r${i}`,
        fingerprintHash: 'FP',
        occurredAt: T0 + i * MIN,
      })) as any,
    }
    // The contract has since closed this itself — `evidence_confined_to_one_agent`
    // and `agent_count_contradicts_listed_agents`. Both checks must reject it,
    // and this test pins BOTH so neither can regress silently.
    expect(correlationIncoherences(forged, { burstWindowMs: HOUR })).toEqual(
      expect.arrayContaining(['evidence_confined_to_one_agent']),
    )
    expect(isCorrelationSelfConsistent(forged)).toBe(false)
    // The server-side guarantee rejects it independently, so a correlation this
    // engine BUILDS can never reach the contract check in that state.
    expect(citationsSpanDistinctAgents(forged)).toBe(false)
  })

  it('citationsSpanningAgents picks one earliest citation per agent, bounded', () => {
    const onsets = computeOnsets([
      occ('a1', 'F', T0 + 5 * MIN),
      occ('a1', 'G', T0 + 6 * MIN),
      occ('a2', 'F', T0 + 7 * MIN),
      occ('a3', 'F', T0 + 8 * MIN),
    ])
    const cites = citationsSpanningAgents(onsets)
    expect(cites).toHaveLength(3)
    expect(new Set(cites.map((c) => c.agentId)).size).toBe(3)
    expect(cites[0]!.occurredAt).toBe(T0 + 5 * MIN)
  })

  it('a 30-agent cluster bounds agentIds and citations but reports the TRUE agentCount', () => {
    const agents = Array.from({ length: 30 }, (_, i) => ({ agentId: `ag${String(i).padStart(2, '0')}`, name: `a${i}` }))
    const occurrences = agents.map((a, i) => occ(a.agentId, 'FP_WIDE', T0 + 10 * HOUR + i * MIN))
    const runs = agents.map((a) => run(a.agentId, T0 + 9 * HOUR, 'failed', `ver_${a.agentId}`))
    const { report } = fold({ agents, occurrences, runs, patterns: [pattern('FP_WIDE')] })

    const shared = report.correlations.find((c) => c.kind === 'shared_failure_fingerprint')!
    expect(shared.agentCount).toBe(30)
    expect(shared.agentIds.length).toBe(20) // MAX_FLEET_CORRELATION_AGENTS
    expect(shared.observedBy.length).toBe(20)
    expect(new Set(shared.observedBy.map((c: any) => c.agentId)).size).toBe(20)
    expect(citationsSpanDistinctAgents(shared)).toBe(true)
    expect(isCorrelationSelfConsistent(shared)).toBe(true)
  })
})
