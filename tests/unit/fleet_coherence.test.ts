/**
 * CROSS-FIELD COHERENCE — "do the report's own numbers agree WITH EACH OTHER?"
 *
 * This file exists because of a class of defect, not four separate bugs. The
 * fleet gate had checks that every field was PRESENT and internally
 * well-formed, and no check that the NUMBERS THOSE FIELDS CARRY are consistent
 * with the other numbers in the same report. Four holes came out of that one
 * blind spot, and all four are exercised below:
 *
 *   - a `temporal_burst` echoing `burstWindowMs: 4 minutes` while declaring a
 *     TWENTY-FOUR HOUR span. The gate checked the ECHO (did the server honour
 *     the parameter?) and never the SPAN (does the burst it returned actually
 *     fit that width?). Same wrong answer as a dropped parameter — a day of
 *     ordinary background failure rendered as a four-minute incident, at the
 *     moment someone wants permission to roll something back — arriving by the
 *     other route.
 *
 *   - `restingOn: ['real-key', 'fabricated-key']` passing as grounded, because
 *     the orphan check asked whether ANY key resolved rather than whether ALL
 *     of them did. A partially-grounded explanation is MORE persuasive than a
 *     wholly invented one: the half that resolves lends its credibility to the
 *     half that does not.
 *
 *   - `agentCount: 500` backed by one listed agent, deciding what an operator
 *     reads first during an incident.
 *
 *   - twelve citations that all name ONE agent, under a twelve-agent claim.
 *     Coverage of the CLAIM is not checkable from a bounded sample; coverage
 *     of the SAMPLE is — and it is the difference between an outage and one
 *     agent retrying.
 *
 * Every check here is decidable from the report's own contents, at no extra
 * request. The house posture is that servers lie by omission; these are the
 * lies that survive an honest-looking response.
 */
import {
  MAX_FLEET_CORRELATION_AGENTS,
  SHARED_ATTRIBUTE_HYPOTHESIS_KINDS,
  hypothesisQuestion,
  citedAgentCount,
  correlationIncoherences,
  fleetReportIncoherences,
  isCorrelationSelfConsistent,
  orphanHypotheses,
  rankFleetCorrelations,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  CorrelationIncoherence,
  FailureOccurrenceCitation,
  FleetHealthReport,
  HypothesisedCause,
  ObservedCorrelation,
} from '@agent-flight-recorder/contracts'

const T0 = 1_721_909_400_000
const MIN = 60_000
const HOUR = 60 * MIN
const BURST_WINDOW = 4 * MIN

function citation(agentId: string, runId: string, occurredAt: number): FailureOccurrenceCitation {
  return { cites: 'failure_occurrence', agentId, runId, fingerprintHash: '9f3c', occurredAt }
}

function burst(overrides: Partial<ObservedCorrelation> = {}): ObservedCorrelation {
  return {
    certainty: 'observed',
    kind: 'temporal_burst',
    correlationKey: 'burst:1',
    observedFact: '3 agents recorded their first failure inside 4 minutes',
    agentIds: ['ag_1', 'ag_2', 'ag_3'],
    agentCount: 3,
    firstObservedAt: T0 - 3 * MIN,
    lastObservedAt: T0,
    observedBy: [citation('ag_1', 'r_1', T0 - 3 * MIN), citation('ag_2', 'r_2', T0 - MIN)],
    ...overrides,
  }
}

function report(overrides: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    analyzedAt: T0,
    verdict: 'correlated_failures',
    roster: [],
    correlations: [burst()],
    hypotheses: [],
    unanswered: [],
    agentsFailing: 3,
    scan: {
      since: T0 - 24 * HOUR,
      until: T0,
      burstWindowMs: BURST_WINDOW,
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

const scan = { burstWindowMs: BURST_WINDOW }

function incoherences(correlation: ObservedCorrelation): CorrelationIncoherence[] {
  return correlationIncoherences(correlation, scan)
}

describe('the control: an honest correlation reports no incoherence', () => {
  it('accepts a burst that fits its window and is corroborated by two agents', () => {
    expect(incoherences(burst())).toEqual([])
    expect(fleetReportIncoherences(report())).toEqual([])
  })
})

describe('DEFECT 1 — the burst span was never checked against burstWindowMs', () => {
  const dayLong = burst({ firstObservedAt: T0 - 24 * HOUR, lastObservedAt: T0, observedBy: [citation('ag_1', 'r_1', T0 - 12 * HOUR), citation('ag_2', 'r_2', T0 - HOUR)] })

  it('refuses a "four minute burst" that declares a twenty-four hour span', () => {
    // Note what was already passing: the citations DO sit inside the declared
    // window, and the server DID echo the requested burst width. Every check
    // that existed before this one was satisfied. The lie is entirely in the
    // relationship between two numbers that were each fine on their own.
    expect(incoherences(dayLong)).toContain('burst_span_exceeds_window')
    expect(fleetReportIncoherences(report({ correlations: [dayLong] }))).toContainEqual({
      correlationKey: 'burst:1',
      incoherence: 'burst_span_exceeds_window',
    })
  })

  it('a span exactly equal to the window is legal; one millisecond more is not', () => {
    const exact = burst({ firstObservedAt: T0 - BURST_WINDOW, lastObservedAt: T0 })
    expect(incoherences(exact)).toEqual([])
    const over = burst({ firstObservedAt: T0 - BURST_WINDOW - 1, lastObservedAt: T0 })
    expect(incoherences(over)).toContain('burst_span_exceeds_window')
  })

  it('applies to temporal_burst ALONE — a recurring fingerprint may legitimately span the whole window', () => {
    // The rule is about a claim of TIGHTNESS IN TIME. "The same failure has
    // been recurring for a day across nine agents" is a real and useful thing
    // to report, and rejecting it would push an engine into mislabelling it as
    // a burst to get it on screen.
    const recurring = burst({
      kind: 'shared_failure_fingerprint',
      firstObservedAt: T0 - 24 * HOUR,
      lastObservedAt: T0,
      observedBy: [citation('ag_1', 'r_1', T0 - 20 * HOUR), citation('ag_2', 'r_2', T0 - HOUR)],
    })
    expect(incoherences(recurring)).toEqual([])
  })

  it('DOCUMENTS THE SEAM: isCorrelationSelfConsistent cannot catch this, and must not be used to gate', () => {
    // It takes no scan, so it structurally cannot compare the span to a width
    // it has never seen. That is the boundary of what a correlation can say
    // about ITSELF — not a gap to be papered over — and the honest response is
    // to say so in a test rather than to let a caller assume the narrow
    // predicate is the whole rule.
    expect(isCorrelationSelfConsistent(dayLong)).toBe(true)
    expect(fleetReportIncoherences(report({ correlations: [dayLong] }))).not.toHaveLength(0)
  })
})

describe('DEFECT 2 — a partially orphaned hypothesis passed as grounded', () => {
  const partiallyOrphaned: HypothesisedCause = {
    certainty: 'hypothesis',
    kind: 'shared_model',
    hypothesisKey: 'h1',
  sharedValue: 'm-4',
    restingOn: ['burst:1', 'a-cluster-that-was-never-observed'],
    notEstablishedBecause: 'recorded data cannot establish a mechanism',
    sharedBy: { affectedSharing: 3, affectedTotal: 3, unaffectedSharing: 1, unaffectedTotal: 140, measurementTruncated: false },
    wouldBeTestedBy: 'roll ag_3 onto m-3',
  }

  it('flags a hypothesis where ANY named observation is absent, not only where all are', () => {
    // A hypothesis naming two clusters claims to explain BOTH. The fabricated
    // half is exactly the part the reader cannot check, and the half that does
    // resolve lends it credibility.
    expect(orphanHypotheses(report({ hypotheses: [partiallyOrphaned] }))).toHaveLength(1)
  })

  it('still accepts a hypothesis whose every named observation is present', () => {
    const grounded = { ...partiallyOrphaned, restingOn: ['burst:1'] as [string, ...string[]] }
    expect(orphanHypotheses(report({ hypotheses: [grounded] }))).toHaveLength(0)
  })

  it('flags a wholly invented hypothesis, as before', () => {
    const invented = { ...partiallyOrphaned, restingOn: ['nowhere'] as [string, ...string[]] }
    expect(orphanHypotheses(report({ hypotheses: [invented] }))).toHaveLength(1)
  })
})

describe('DEFECT 3 — an unvalidated agentCount decided what is read first', () => {
  it('refuses a claim of 500 agents backed by a list that is not even at its ceiling', () => {
    // The check is sound rather than heuristic: `agentIds` is bounded at a
    // KNOWN ceiling, so a list shorter than the ceiling is a COMPLETE list —
    // the bound did not bind — and `agentCount` must equal it.
    const inflated = burst({ agentCount: 500, agentIds: ['ag_1'] })
    expect(incoherences(inflated)).toContain('agent_count_contradicts_listed_agents')
  })

  it('refuses an agentCount SMALLER than the agents listed', () => {
    expect(incoherences(burst({ agentCount: 1, agentIds: ['a', 'b', 'c'] }))).toContain(
      'agent_count_contradicts_listed_agents'
    )
  })

  it('allows agentCount to exceed the list ONLY once the list is at its ceiling', () => {
    const atCeiling = Array.from({ length: MAX_FLEET_CORRELATION_AGENTS }, (_, i) => `ag_${i}`)
    const wide = burst({
      agentCount: 500,
      agentIds: atCeiling,
      observedBy: [citation('ag_1', 'r_1', T0 - 2 * MIN), citation('ag_2', 'r_2', T0 - MIN)],
    })
    expect(incoherences(wide)).toEqual([])
  })

  it('requires a claim beyond the ceiling to be corroborated by at least two distinct cited agents', () => {
    // This closes the last route to a fabricated breadth: any real wide
    // cluster can produce two citations from different agents, so demanding it
    // costs an honest engine nothing and bounds a dishonest claim to "two".
    const atCeiling = Array.from({ length: MAX_FLEET_CORRELATION_AGENTS }, (_, i) => `ag_${i}`)
    const uncorroborated = burst({
      agentCount: 500,
      agentIds: atCeiling,
      observedBy: [citation('ag_1', 'r_1', T0 - MIN)],
    })
    expect(incoherences(uncorroborated)).toContain('wide_claim_uncorroborated')
  })

  it('the fabricated breadth is refused BEFORE it is ever ranked — the fix is at the source', () => {
    // Demoting breadth in the sort would have been the wrong repair: it trades
    // away a correct product rule (the broadest cluster is usually nearest
    // what changed) to work around an unchecked input.
    const inflated = burst({ correlationKey: 'fake', agentCount: 500, agentIds: ['ag_1'] })
    const real = burst({ correlationKey: 'real', agentCount: 9, agentIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] })
    expect(fleetReportIncoherences(report({ correlations: [inflated, real] })).map((f) => f.correlationKey)).toContain(
      'fake'
    )
  })

  it('among equal claims, the better-evidenced one leads', () => {
    const thin = burst({ correlationKey: 'thin', agentCount: 3, observedBy: [citation('ag_1', 'r', T0 - MIN)] })
    const thick = burst({
      correlationKey: 'thick',
      agentCount: 3,
      observedBy: [citation('ag_1', 'r1', T0 - 2 * MIN), citation('ag_2', 'r2', T0 - MIN), citation('ag_3', 'r3', T0)],
    })
    expect(rankFleetCorrelations([thin, thick]).map((c) => c.correlationKey)).toEqual(['thick', 'thin'])
  })

  it('still leads with breadth over recency — the product rule is intact', () => {
    const wide = burst({ correlationKey: 'wide', agentCount: 12, agentIds: Array.from({ length: 12 }, (_, i) => `w${i}`), lastObservedAt: T0 - HOUR, firstObservedAt: T0 - HOUR - MIN })
    const narrowRecent = burst({ correlationKey: 'narrow', agentCount: 2, agentIds: ['n1', 'n2'], observedBy: [citation('n1', 'r', T0 - MIN), citation('n2', 'r2', T0)] })
    expect(rankFleetCorrelations([narrowRecent, wide])[0]!.correlationKey).toBe('wide')
  })
})

describe('DEFECT 4 — evidence need not have covered the claimed breadth', () => {
  it('refuses twelve citations that all name one agent under a twelve-agent claim', () => {
    // Coverage of the CLAIM is not checkable from a bounded sample, and Team D
    // agreed. But coverage of the SAMPLE is — and it is the difference between
    // an outage and one agent retrying.
    const oneAgent = burst({
      agentCount: 12,
      agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i}`),
      observedBy: [
        citation('ag_1', 'r_0', T0 - 3 * MIN),
        ...Array.from({ length: 11 }, (_, i) => citation('ag_1', `r_${i + 1}`, T0 - 2 * MIN)),
      ] as [FailureOccurrenceCitation, ...FailureOccurrenceCitation[]],
    })
    expect(citedAgentCount(oneAgent)).toBe(1)
    expect(incoherences(oneAgent)).toContain('evidence_confined_to_one_agent')
  })

  it('does NOT punish a single-citation sample — with one citation there is no room to show otherwise', () => {
    // Silence is only evidence when the sample had space to speak. A bounded
    // sample of one says nothing about breadth, and rejecting it would force
    // an honest engine to pad its evidence.
    const minimal = burst({ agentCount: 3, observedBy: [citation('ag_1', 'r_1', T0 - MIN)] })
    expect(incoherences(minimal)).toEqual([])
  })

  it('does not fire on a genuinely single-agent correlation', () => {
    const single = burst({
      agentCount: 1,
      agentIds: ['ag_1'],
      observedBy: [citation('ag_1', 'r_1', T0 - 2 * MIN), citation('ag_1', 'r_2', T0 - MIN)],
    })
    expect(incoherences(single)).toEqual([])
  })
})

describe('the incoherences are enumerated, not collapsed to a boolean', () => {
  it('reports every distinct arithmetic failure in one pass', () => {
    // A gate needs pass/fail; a human debugging a misbehaving engine needs to
    // know WHICH arithmetic broke, and a boolean makes every surface re-derive
    // that from scratch.
    const broken = burst({
      firstObservedAt: T0 - 24 * HOUR,
      lastObservedAt: T0,
      agentCount: 500,
      agentIds: ['ag_1'],
      observedBy: [citation('ag_1', 'r_1', T0 - 12 * HOUR), citation('ag_1', 'r_2', T0 - HOUR)],
    })
    expect(incoherences(broken).sort()).toEqual(
      ['agent_count_contradicts_listed_agents', 'burst_span_exceeds_window', 'evidence_confined_to_one_agent', 'wide_claim_uncorroborated'].sort()
    )
  })

  it('carries the correlationKey, so a multi-cluster report says which one is wrong', () => {
    const good = burst({ correlationKey: 'good' })
    const bad = burst({ correlationKey: 'bad', firstObservedAt: T0 - 24 * HOUR, lastObservedAt: T0, observedBy: [citation('ag_1', 'r1', T0 - HOUR), citation('ag_2', 'r2', T0)] })
    const findings = fleetReportIncoherences(report({ correlations: [good, bad] }))
    expect(findings.every((f) => f.correlationKey === 'bad')).toBe(true)
  })

  it('still catches the original two: an inverted window and a citation outside it', () => {
    expect(incoherences(burst({ firstObservedAt: T0, lastObservedAt: T0 - HOUR }))).toContain('inverted_window')
    expect(
      incoherences(burst({ observedBy: [citation('ag_1', 'r_1', T0 - 24 * HOUR), citation('ag_2', 'r_2', T0)] }))
    ).toContain('citation_outside_window')
  })
})

// ---------------------------------------------------------------------------
// THE MOOD OF THE SENTENCE IS A PROPERTY OF THE TYPE
// ---------------------------------------------------------------------------

describe('a hypothesis has no prose headline, so an ENGINE cannot promote a guess either', () => {
  // Every other barrier in this contract stops a CONSUMER from promoting
  // suspicion to fact by forgetting to check something. The headline field was
  // the one route by which the PRODUCER could do it, in one keystroke, with
  // nothing downstream able to tell: `candidateExplanation: 'model m-4 is
  // failing'` was a compiling, contract-valid hypothesis. During an incident
  // that sentence is what someone acts on, and no surrounding chrome — a
  // HYPOTHESIS label, a separate column, a colour — survives contact with a
  // declarative sentence about a named dependency at 3am.
  //
  // A regex on prose was considered and rejected: strict enough to reject
  // "m-4 is degrading" is strict enough to reject valid English, and loose
  // enough to accept valid English is satisfied by inserting "may" — leaving
  // "m-4 may be the cause", read as an accusation anyway. Composing the
  // sentence removes the writer from it instead of grading their grammar.

  const base: HypothesisedCause = {
    certainty: 'hypothesis',
    kind: 'shared_model',
    hypothesisKey: 'h1',
    sharedValue: 'm-4',
    restingOn: ['burst:1'],
    notEstablishedBecause: 'recorded data cannot establish a mechanism',
    sharedBy: { affectedSharing: 3, affectedTotal: 3, unaffectedSharing: 1, unaffectedTotal: 140, measurementTruncated: false },
    wouldBeTestedBy: 'roll ag_3 onto m-3',
  }

  it('EVERY kind composes to a question — there is no branch that states a claim', () => {
    // The invariant worth pinning, over the whole closed enum rather than the
    // examples an author happened to think of.
    const kinds: HypothesisedCause['kind'][] = [
      'shared_model',
      'shared_tool',
      'shared_capability',
      'shared_version_lineage',
      'coincident_in_time',
      'unattributed',
    ]
    for (const kind of kinds) {
      const question = hypothesisQuestion({ ...base, kind })
      expect(question.endsWith('?')).toBe(true)
      // And no branch asserts a mechanism in the indicative.
      expect(question).not.toMatch(/\b(is|was|caused|because of|due to)\b/)
    }
  })

  it('names the shared value when there is one, so the question is about something specific', () => {
    expect(hypothesisQuestion(base)).toContain('`m-4`')
    expect(hypothesisQuestion({ ...base, kind: 'shared_tool', sharedValue: 'search_web' })).toContain('tool `search_web`')
  })

  it('stays a question even with no shared value — it degrades to vaguer, never to a claim', () => {
    const { sharedValue: _dropped, ...vague } = base
    expect(hypothesisQuestion(vague as HypothesisedCause).endsWith('?')).toBe(true)
  })

  it('the attribute kinds are enumerated, so the reader can require a value for exactly those', () => {
    expect([...SHARED_ATTRIBUTE_HYPOTHESIS_KINDS].sort()).toEqual(
      ['shared_capability', 'shared_model', 'shared_tool', 'shared_version_lineage'].sort()
    )
    expect(SHARED_ATTRIBUTE_HYPOTHESIS_KINDS).not.toContain('unattributed')
    expect(SHARED_ATTRIBUTE_HYPOTHESIS_KINDS).not.toContain('coincident_in_time')
  })

  it('`unattributed` is still sayable, and still a question — the honest answer must have a phrasing', () => {
    // "Twelve agents are failing together and we can name nothing they share"
    // is real and useful. A type that could not say it would pressure an
    // engine into naming something.
    expect(hypothesisQuestion({ ...base, kind: 'unattributed' })).toContain('nothing shared could be named')
  })
})

// ---------------------------------------------------------------------------
// NaN DOES NOT FAIL A COMPARISON — IT SKIPS IT
// ---------------------------------------------------------------------------

describe('non-finite numbers fail CLOSED, independently of any sweep that ran before', () => {
  // The same lesson as `fleetReportUnusableFields`, one layer up, in the file
  // that already wrote the lesson down. Every check in
  // `correlationIncoherences` is a comparison, and every comparison involving
  // NaN is false — so NaN did not FAIL these checks, it SKIPPED them, and a
  // correlation made of NaN returned ZERO codes, counted toward
  // `correlationCount`, produced `correlated_failures`, and paged someone at
  // 3am. A UI correctly rendering `—` for a NaN count is what made it
  // invisible at the one place a human might have caught it.

  const nanBurst = burst({ agentCount: Number.NaN, firstObservedAt: Number.NaN, lastObservedAt: Number.NaN })

  it('reports `unusable_numbers` for a correlation made of NaN, instead of nothing at all', () => {
    expect(incoherences(nanBurst)).toEqual(['unusable_numbers'])
    expect(fleetReportIncoherences(report({ correlations: [nanBurst] }))).toContainEqual({
      correlationKey: 'burst:1',
      incoherence: 'unusable_numbers',
    })
  })

  it('catches NaN in EACH numeric field on its own, not only all of them together', () => {
    for (const field of ['agentCount', 'firstObservedAt', 'lastObservedAt'] as const) {
      expect(incoherences(burst({ [field]: Number.NaN }))).toEqual(['unusable_numbers'])
    }
    // ...and in a citation timestamp, which the window rules read.
    expect(
      incoherences(burst({ observedBy: [citation('ag_1', 'r_1', Number.NaN), citation('ag_2', 'r_2', T0 - MIN)] }))
    ).toEqual(['unusable_numbers'])
  })

  it('catches infinities, strings and absent values in the same place', () => {
    expect(incoherences(burst({ agentCount: Number.POSITIVE_INFINITY }))).toEqual(['unusable_numbers'])
    expect(incoherences(burst({ lastObservedAt: '2024-01-01' as unknown as number }))).toEqual(['unusable_numbers'])
    const { agentCount: _dropped, ...noCount } = burst()
    expect(incoherences(noCount as ObservedCorrelation)).toEqual(['unusable_numbers'])
  })

  it('the SAME fixtures with FINITE hostile values are still caught by their own specific rule', () => {
    // What isolates NaN as the cause rather than the fixture: swap the NaN for
    // a real hostile number and the specific rule fires, as it always did.
    expect(incoherences(burst({ agentCount: 500, agentIds: ['ag_1'] }))).toContain(
      'agent_count_contradicts_listed_agents'
    )
    expect(incoherences(burst({ firstObservedAt: T0, lastObservedAt: T0 - HOUR }))).toContain('inverted_window')
  })

  it('does NOT reject an infinite burst width — that is how the scan-blind predicate says "this rule cannot apply"', () => {
    // `isCorrelationSelfConsistent` passes POSITIVE_INFINITY deliberately.
    // Rejecting it would have made the narrow predicate report every
    // correlation as unusable.
    expect(isCorrelationSelfConsistent(burst())).toBe(true)
    expect(correlationIncoherences(burst(), { burstWindowMs: Number.POSITIVE_INFINITY })).toEqual([])
    // A NaN width, by contrast, silently disables the span rule and IS refused.
    expect(correlationIncoherences(burst(), { burstWindowMs: Number.NaN })).toEqual(['unusable_numbers'])
  })
})

describe('a null ARRAY ELEMENT does not throw — required arrays were still trusted after required fields were not', () => {
  // Latent, not live: the SDK refuses a null element earlier (asserted in
  // fleet_reader_honesty), and the interim web adapter never emits one. It
  // becomes reachable the moment a surface reads server JSON directly.

  it('reports the malformed entry instead of throwing, and addresses it by position', () => {
    const withNull = report({ correlations: [null as unknown as ObservedCorrelation, burst()] })
    expect(() => fleetReportIncoherences(withNull)).not.toThrow()
    expect(fleetReportIncoherences(withNull)).toContainEqual({
      correlationKey: '(correlations[0])',
      incoherence: 'malformed_correlation',
    })
  })

  it('ranks a malformed entry LAST rather than dropping it — a shorter list hides a cluster', () => {
    const ranked = rankFleetCorrelations([null as unknown as ObservedCorrelation, burst({ correlationKey: 'real' })])
    expect(ranked).toHaveLength(2)
    expect(ranked[0]!.correlationKey).toBe('real')
    expect(ranked[1]).toBeNull()
  })

  it('citedAgentCount tolerates a malformed correlation, since a display path reaches it', () => {
    expect(() => citedAgentCount(null as unknown as ObservedCorrelation)).not.toThrow()
    expect(() => citedAgentCount(burst({ observedBy: null as never }))).not.toThrow()
  })
})
