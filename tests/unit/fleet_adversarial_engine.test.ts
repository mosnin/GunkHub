/**
 * FLEET HEALTH ENGINE — ADVERSARIAL SUITE (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * `packages/contracts/src/fleet_health.ts` and the runtime gate that enforces
 * it, `assertFleetHealthReportTrustworthy` in `packages/sdk/src/reader.ts` —
 * what stands between an operator at 3am and a confidently-worded wrong answer
 * about what to roll back.
 *
 * THE THREAT MODEL IS THE WIRE. The reader file says it outright: "a server is
 * not typechecked by us." `GET /api/v1/fleet/health` does not exist yet, so the
 * engine→contract mapping that will feed this gate is unwritten. TypeScript is
 * not the defence; the runtime refusals are, and this file attacks those.
 *
 * ── LEDGER STATUS: EMPTY, AND THAT IS A RESULT, NOT AN ABSENCE ─────────────
 * The first run of this suite recorded FOUR defects. All four have since been
 * fixed, and each retirement below was verified BY EXECUTION against the
 * current source — never by reading a diff and never by taking a claim:
 *
 *   burst/span-never-checked-against-burstWindowMs
 *     -> `correlationIncoherences(c, scan)` now returns `burst_span_exceeds_window`,
 *        and the SDK gate calls `fleetReportIncoherences`, which has the scan in
 *        hand. RETIRED — see `guards/burst-span is enforced where the scan is`.
 *   burst/evidence-need-not-cover-the-claimed-breadth
 *     -> `evidence_confined_to_one_agent`. This is the B3 case. RETIRED.
 *   rank/unvalidated-breadth-decides-what-is-read-first
 *     -> `agent_count_contradicts_listed_agents` now rejects an inflated count
 *        whose `agentIds` list is below the cap and therefore complete. RETIRED.
 *   hypothesis/partial-orphan-passes-as-grounded
 *     -> `orphanHypotheses` now uses `some(key => !keys.has(key))`. RETIRED.
 *
 * AN EMPTY LEDGER IS THE MOST DANGEROUS STATE THIS FILE CAN BE IN, because
 * `expect(observed).toEqual([])` passes just as happily when every probe has
 * quietly stopped working. So the retirements are NOT expressed as "nothing was
 * recorded". Each is a POSITIVE assertion that the specific check FIRES on the
 * exact adversarial fixture that used to defeat it, and `teeth/every retired
 * defect has a live check behind it` re-derives all four from shipped output
 * and would re-record any that regressed. Delete a check and this suite goes
 * red; it cannot go green by going blind.
 *
 * ── THE FINDING OF THIS ITERATION, ABOVE ANY INDIVIDUAL DEFECT ────────────
 * FOUR INSTANCES OF ONE PATTERN, IN ONE ITERATION. Every time, the rule was
 * KNOWN and the APPLICATION was partial:
 *
 *   1. "NaN is unusable by rule" was written into the contract, and the other
 *      half of the SAME GATE — same file, same author — kept relying on the
 *      comparison pattern that had just been documented as unsafe.
 *   2. The null-element rule was applied to three of six call sites.
 *   3. The reporter/consumer direction was chosen correctly in general and
 *      wrongly at the one call site where it CERTIFIED — dropping an
 *      unreadable element from a completeness-bearing collection.
 *   4. THIS SUITE'S OWN generalized sweep was general in one dimension
 *      (functions) and blind in the other (collections), and therefore missed
 *      3 above.
 *
 * WHAT DID NOT WORK: care, review, and writing the rule down. Each defect was
 * introduced by someone who had just stated the rule correctly elsewhere.
 *
 * WHAT WORKED, BOTH TIMES:
 *   - DELETING THE THING THAT PERMITS THE WRONG CHOICE. `listOf` — the
 *     container-only helper that validated an array and trusted its elements —
 *     was removed, not patched around. The per-call-site direction choice was
 *     replaced by one declared table. You cannot forget to apply a rule at a
 *     call site that no longer makes the decision.
 *   - ENUMERATING SUBJECTS FROM THE SOURCE OR THE DATA, NEVER FROM A LIST. A
 *     hand-maintained list of things to check fails in exactly the way the bug
 *     fails: by being incomplete, silently. Both sweeps in this file derive
 *     their subjects from the module under test, so a new subject is graded
 *     without this file changing — and an unclassified one fails loudly.
 *
 * A GENERALIZED ATTACK IS ONLY AS GENERAL AS ITS DIMENSIONS. When adding a
 * sweep here, the question is not "does it cover every X" but "what is the
 * OTHER axis I am not enumerating".
 *
 * ── RESIDUALS: NAMED, NOT LEDGERED ─────────────────────────────────────────
 * Two evasions still pass, both at documented boundaries of what a BOUNDED
 * report can prove about itself. They are characterised below rather than filed
 * as defects, because closing them from the client is not possible — they need
 * the server-side guarantee that a correlation's citation sample spans distinct
 * agents. If that lands, these tests go red and should be re-read.
 */

import { readFileSync } from 'node:fs'

import {
  baseRateUsability,
  citedAgentCount,
  computeFleetHealthVerdict,
  correlationIncoherences,
  discriminationOf,
  fleetHealthReportVerdict,
  fleetReportIncoherences,
  fleetReportUnusableFields,
  hypothesesFor,
  hypothesisQuestion,
  isCorrelationSelfConsistent,
  isFleetHealthAnalysisComplete,
  isFleetHealthScanComplete,
  MAX_FLEET_CORRELATION_AGENTS,
  orphanHypotheses,
  rankFleetCorrelations,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  AgentHealthEntry,
  CorrelationIncoherence,
  FleetHealthReport,
  FleetHealthScan,
  FleetObservationEvidence,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'

import { usableArray } from '@/lib/fleet/safe'

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

const observedDefects = new Set<string>()
const record = (id: string): void => void observedDefects.add(id)

/**
 * The four original entries are RETIRED (see header). These two are NEW this
 * cycle, found by attacking the coherence gate that closed them.
 */
/**
 * `coherence/non-finite-numbers-fail-open` is RETIRED — `correlationIncoherences`
 * now validates its inputs first and returns `unusable_numbers`, and it does so
 * UNCONDITIONALLY rather than relying on a documented ordering. Verified by
 * execution in `guards/`, including the NaN-versus-infinity boundary in both
 * directions.
 *
 * `coherence/null-array-element-throws-in-report-helpers` is NOT retired. It is
 * RE-SCOPED, because the fix landed on three functions and the same file has
 * three more with the same defect — see the sweep below, which is what found
 * them and what will find the next one.
 */
/**
 * EMPTY BY ACHIEVEMENT. Every entry this suite ever held has been fixed, and
 * each retirement was verified by EXECUTION against current source. The
 * mechanism that keeps an empty ledger honest is `teeth/every retired defect
 * has a live check behind it`, which re-derives each retirement from shipped
 * output and RE-RECORDS any that regresses — an empty ledger asserted by
 * `toEqual([])` alone would pass just as happily with every probe blinded.
 *
 * Last retirement: `completeness/malformed-unanswered-question-licenses-healthy`,
 * which surfaced a live sibling in `correlations` — an unreadable CLAIM about
 * the fleet read as an ABSENCE of claims. Both now gate; both are named.
 */
const KNOWN_DEFECTS: readonly string[] = []

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_760_000_000_000
const DECLARED_BURST_WINDOW_MS = 4 * MIN

function srcOf(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function citation(agentId: string, runId: string, occurredAt: number): FleetObservationEvidence {
  return { cites: 'failure_occurrence', agentId, runId, fingerprintHash: '9f3c', occurredAt }
}

function scanOf(over: Partial<FleetHealthScan> = {}): FleetHealthScan {
  return {
    since: T0 - HOUR,
    until: T0 + HOUR,
    burstWindowMs: DECLARED_BURST_WINDOW_MS,
    correlationBasis: 'whole_roster',
    agentsInRoster: 200,
    agentsAssessed: 200,
    agentsUnassessable: 0,
    agentsSkippedForBudget: 0,
    occurrencesScanned: 4_000,
    scanTruncated: false,
    baseRatesMeasured: true,
    ...over,
  }
}

function correlationOf(over: Partial<ObservedCorrelation> = {}): ObservedCorrelation {
  return {
    certainty: 'observed',
    kind: 'temporal_burst',
    correlationKey: 'burst:base',
    observedFact: '2 agents recorded failures inside the window',
    agentIds: ['ag_1', 'ag_2'],
    agentCount: 2,
    firstObservedAt: T0,
    lastObservedAt: T0 + 3 * MIN,
    observedBy: [citation('ag_1', 'r_1', T0), citation('ag_2', 'r_2', T0 + MIN)],
    ...over,
  }
}

function measurementOf(over: Partial<FleetShareMeasurement> = {}): FleetShareMeasurement {
  return {
    affectedSharing: 12,
    affectedTotal: 12,
    unaffectedSharing: 0,
    unaffectedTotal: 188,
    measurementTruncated: false,
    ...over,
  }
}

function hypothesisOf(over: Partial<HypothesisedCause> = {}): HypothesisedCause {
  return {
    certainty: 'hypothesis',
    kind: 'shared_model',
    hypothesisKey: 'hyp:m-4',
    // NOTE: `candidateExplanation` was REMOVED from this interface mid-cycle.
    // `HypothesisedCause` now carries NO free-text explanation at all — only
    // `kind` plus an optional `sharedValue` — so a surface must compose its own
    // sentence from structured fields rather than render server prose. That is
    // a hardening, and this fixture tracks it.
    sharedValue: 'm-4',
    restingOn: ['burst:base'],
    notEstablishedBecause: 'recorded data contains no counterfactual, so a mechanism cannot be established',
    sharedBy: measurementOf(),
    wouldBeTestedBy: 'roll ag_3 onto m-3 and watch whether its failures stop',
    ...over,
  }
}

function reportOf(over: Partial<FleetHealthReport> = {}): FleetHealthReport {
  return {
    analyzedAt: T0,
    verdict: 'correlated_failures',
    roster: [],
    correlations: [correlationOf()],
    hypotheses: [],
    unanswered: [],
    agentsFailing: 12,
    scan: scanOf(),
    ...over,
  }
}

/** The adversarial fixtures that used to defeat the gate, kept as named subjects. */
const DAY_LONG_BURST = correlationOf({
  correlationKey: 'burst:day-long',
  lastObservedAt: T0 + 24 * HOUR,
  observedBy: [citation('ag_1', 'r_1', T0), citation('ag_2', 'r_2', T0 + 23 * HOUR)],
})

const TWELVE_CITATIONS_ONE_AGENT = correlationOf({
  correlationKey: 'burst:one-sick-agent',
  agentCount: 12,
  agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i}`),
  observedBy: [
    citation('ag_1', 'r_0', T0),
    ...Array.from({ length: 11 }, (_, i) => citation('ag_1', `r_${i + 1}`, T0 + (i + 1) * 1_000)),
  ],
})

const INFLATED_SHORT_LIST = correlationOf({
  correlationKey: 'burst:inflated',
  agentCount: 500,
  agentIds: ['ag_9'],
  observedBy: [citation('ag_9', 'r_1', T0)],
})

/**
 * The report collections and their declared direction, PARSED FROM THE
 * CONTRACT'S OWN `REPORT_COLLECTIONS` table rather than listed here. A
 * collection added or re-pointed there is graded here without this file
 * changing — which is the only way a coverage check can outlive its author.
 */
function declaredCollections(): { name: string; direction: string }[] {
  const src = srcOf('../../packages/contracts/src/fleet_health.ts')
  const table = /const REPORT_COLLECTIONS = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? ''
  return [...table.matchAll(/^\s*(\w+):\s*"(gates|displays)"/gm)].map((m) => ({
    name: m[1] as string,
    direction: m[2] as string,
  }))
}

function gatingCollections(): string[] {
  return declaredCollections().filter((c) => c.direction === 'gates').map((c) => c.name)
}

function displayCollections(): string[] {
  return declaredCollections().filter((c) => c.direction === 'displays').map((c) => c.name)
}

/** A WELL-FORMED report whose required arrays each carry a null element — the shape wire JSON produces. */
function reportWithNullElements(): FleetHealthReport {
  return reportOf({
    correlations: [null as unknown as ObservedCorrelation],
    hypotheses: [null as unknown as HypothesisedCause],
    roster: [null as unknown as AgentHealthEntry],
    unanswered: [null as unknown as UnansweredFleetQuestion],
  })
}

/**
 * One or more wire-hostile invocations per EXPORTED helper. The keys are
 * checked against the module's own export list, so this cannot silently fall
 * behind the code it grades — that incompleteness is the exact failure mode
 * the sweep exists to catch.
 *
 * Every probe passes a WELL-FORMED container with malformed CONTENTS. Passing
 * `null` as the whole argument is a different question (a caller-contract one,
 * which the SDK gate answers upstream) and is deliberately not graded here.
 */
const WIRE_HOSTILE: Record<string, Array<() => unknown>> = {
  discriminationOf: [() => discriminationOf(measurementOf({ unaffectedSharing: Number.NaN }))],
  baseRateUsability: [() => baseRateUsability(measurementOf({ unaffectedSharing: Number.NaN }))],
  hypothesisQuestion: [() => hypothesisQuestion(hypothesisOf({ sharedBy: null as unknown as FleetShareMeasurement }))],
  isFleetHealthScanComplete: [() => isFleetHealthScanComplete(scanOf({ agentsAssessed: Number.NaN }))],
  computeFleetHealthVerdict: [
    () => computeFleetHealthVerdict({ correlationCount: Number.NaN, agentsFailing: Number.NaN, complete: true }),
  ],
  isFleetHealthAnalysisComplete: [() => isFleetHealthAnalysisComplete(reportWithNullElements())],
  fleetHealthReportVerdict: [() => fleetHealthReportVerdict(reportWithNullElements())],
  rankFleetCorrelations: [() => rankFleetCorrelations([null as unknown as ObservedCorrelation, correlationOf()])],
  hypothesesFor: [() => hypothesesFor(reportWithNullElements(), 'burst:base')],
  orphanHypotheses: [() => orphanHypotheses(reportWithNullElements())],
  citedAgentCount: [() => citedAgentCount(null as unknown as ObservedCorrelation)],
  correlationIncoherences: [() => correlationIncoherences(null as unknown as ObservedCorrelation, scanOf())],
  isCorrelationSelfConsistent: [() => isCorrelationSelfConsistent(correlationOf({ agentCount: Number.NaN }))],
  fleetReportUnusableFields: [() => fleetReportUnusableFields(reportWithNullElements())],
  fleetReportIncoherences: [() => fleetReportIncoherences(reportWithNullElements())],
}

function codes(c: ObservedCorrelation, scan: FleetHealthScan = scanOf()): CorrelationIncoherence[] {
  return correlationIncoherences(c, scan)
}

// ---------------------------------------------------------------------------
// GUARDS — each retirement, expressed as the check FIRING
// ---------------------------------------------------------------------------

describe('guards', () => {
  it('burst-span is enforced where the scan is in hand', () => {
    // FIXTURE AUDIT: genuinely a burst, genuinely wider than the declared
    // width, and its citations genuinely sit inside its own claimed span — so
    // the span is the ONLY thing wrong with it.
    expect(DAY_LONG_BURST.kind).toBe('temporal_burst')
    expect(DAY_LONG_BURST.lastObservedAt - DAY_LONG_BURST.firstObservedAt).toBeGreaterThan(DECLARED_BURST_WINDOW_MS)
    expect(
      DAY_LONG_BURST.observedBy.every(
        (c) =>
          c.cites !== 'failure_occurrence' ||
          (c.occurredAt >= DAY_LONG_BURST.firstObservedAt && c.occurredAt <= DAY_LONG_BURST.lastObservedAt)
      )
    ).toBe(true)

    // POSITIVE: the check fires. Delete it and this fails.
    expect(codes(DAY_LONG_BURST)).toContain('burst_span_exceeds_window')

    // It is scan-relative, not a fixed threshold: widen the declared window and
    // the same correlation becomes coherent. A check that fired regardless
    // would be a different bug wearing this one's clothes.
    expect(codes(DAY_LONG_BURST, scanOf({ burstWindowMs: 48 * HOUR }))).not.toContain('burst_span_exceeds_window')

    // Applies to `temporal_burst` alone — a shared-fingerprint cluster may
    // legitimately span the whole observation window.
    expect(codes({ ...DAY_LONG_BURST, kind: 'shared_failure_fingerprint' })).not.toContain('burst_span_exceeds_window')

    // A coherent burst is not flagged, or the check rejects everything.
    expect(codes(correlationOf())).toEqual([])
  })

  it('the gate calls the entry point that has the scan', () => {
    // `isCorrelationSelfConsistent` STILL passes the day-long burst, and that
    // is now documented rather than accidental — it takes no scan. The
    // retirement therefore rests on the GATE calling the other entry point.
    expect(isCorrelationSelfConsistent(DAY_LONG_BURST)).toBe(true)

    const readerSrc = srcOf('../../packages/sdk/src/reader.ts')
    const gate = /function assertFleetHealthReportTrustworthy[\s\S]*?\n\}/.exec(readerSrc)?.[0] ?? ''
    expect(gate.length).toBeGreaterThan(0)
    expect(gate).toMatch(/fleetReportIncoherences\(report\)/)

    // EXECUTED end-to-end: the whole report, checked against its own scan.
    const findings = fleetReportIncoherences(reportOf({ correlations: [DAY_LONG_BURST] }))
    expect(findings.map((f) => f.incoherence)).toContain('burst_span_exceeds_window')
    expect(findings.map((f) => f.correlationKey)).toContain('burst:day-long')

    // And a clean report yields nothing, so "empty" is meaningful.
    expect(fleetReportIncoherences(reportOf())).toEqual([])

    // The contract warns against using the scan-blind predicate as a gate.
    expect(srcOf('../../packages/contracts/src/fleet_health.ts')).toMatch(/must not be used as a gate/)
  })

  it('evidence confined to one agent is rejected — the B3 case', () => {
    // FIXTURE AUDIT: twelve citations, one agent, twelve agents claimed.
    expect(TWELVE_CITATIONS_ONE_AGENT.observedBy.length).toBe(12)
    expect(new Set(TWELVE_CITATIONS_ONE_AGENT.observedBy.map((c) => c.agentId)).size).toBe(1)
    expect(TWELVE_CITATIONS_ONE_AGENT.agentCount).toBe(12)

    expect(codes(TWELVE_CITATIONS_ONE_AGENT)).toContain('evidence_confined_to_one_agent')
    expect(isCorrelationSelfConsistent(TWELVE_CITATIONS_ONE_AGENT)).toBe(false)

    // The honest counterpart — same breadth, evidence spanning two agents — is
    // NOT rejected, so the check discriminates rather than blanket-refusing.
    const honest = correlationOf({
      agentCount: 12,
      agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i}`),
      observedBy: [citation('ag_1', 'r_1', T0), citation('ag_2', 'r_2', T0 + MIN)],
    })
    expect(codes(honest)).toEqual([])
  })

  it('an inflated agent count over a complete list is rejected', () => {
    // `agentIds` below the cap means the list is COMPLETE, so `agentCount` must
    // equal it. 500 claimed against one listed is a contradiction the report
    // makes with itself.
    expect(INFLATED_SHORT_LIST.agentIds.length).toBeLessThan(MAX_FLEET_CORRELATION_AGENTS)
    expect(codes(INFLATED_SHORT_LIST)).toContain('agent_count_contradicts_listed_agents')

    // The older, weaker invariant still holds too.
    expect(codes(correlationOf({ agentCount: 1, agentIds: ['a', 'b', 'c'] }))).toContain(
      'agent_count_contradicts_listed_agents'
    )
  })

  it('a partially orphaned hypothesis is rejected', () => {
    const report = reportOf({ hypotheses: [hypothesisOf({ restingOn: ['burst:base', 'burst:does-not-exist'] })] })

    // FIXTURE AUDIT: exactly one of the two keys is present.
    const keys = new Set(report.correlations.map((c) => c.correlationKey))
    expect(keys.has('burst:base')).toBe(true)
    expect(keys.has('burst:does-not-exist')).toBe(false)

    expect(orphanHypotheses(report).length).toBe(1)
    // Fully grounded still passes, so the check is not blanket-refusing.
    expect(orphanHypotheses(reportOf({ hypotheses: [hypothesisOf()] })).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// NEW ATTACKS — the coherence gate's own edges
// ---------------------------------------------------------------------------

describe('coherence-gate integrity', () => {
  it('RETIRED: non-finite numbers now fail closed, unconditionally', () => {
    // POSITIVE assertions. Each hostile shape returns the dedicated code, so
    // removing the guard fails this rather than silently ceasing to record.
    const scan = scanOf()
    expect(codes(correlationOf({ agentCount: Number.NaN }), scan)).toEqual(['unusable_numbers'])
    expect(codes(correlationOf({ lastObservedAt: Number.NaN }), scan)).toEqual(['unusable_numbers'])
    expect(codes(correlationOf({ firstObservedAt: Number.NaN }), scan)).toEqual(['unusable_numbers'])
    expect(codes(correlationOf({ observedBy: [citation('a', 'r', Number.NaN)] }), scan)).toEqual(['unusable_numbers'])
    // An INFINITE count is not a count either — infinity is legal for exactly
    // one field, and this is not it.
    expect(codes(correlationOf({ agentCount: Number.POSITIVE_INFINITY }), scan)).toEqual(['unusable_numbers'])
    // A null correlation is named rather than crashed on.
    expect(codes(null as unknown as ObservedCorrelation, scan)).toEqual(['malformed_correlation'])

    // It returns EARLY: a correlation that is ALSO span-violating reports only
    // the usability code, because the other rules could not be evaluated and
    // reporting them would imply checks that did not happen.
    expect(codes(correlationOf({ agentCount: Number.NaN, lastObservedAt: T0 + 24 * HOUR }), scan)).toEqual([
      'unusable_numbers',
    ])

    // And a clean correlation is still clean, or "fails closed" would just mean
    // "refuses everything".
    expect(codes(correlationOf())).toEqual([])
  })

  it('the NaN-versus-infinity boundary holds in BOTH directions', () => {
    // THE DISTINCTION A BLANKET `isFinite` WOULD HAVE DESTROYED.
    //
    // An INFINITE `burstWindowMs` is legal and load-bearing: it is how
    // `isCorrelationSelfConsistent` says "I cannot see the scan, so the span
    // rule cannot apply". Validating it as finite would make the scan-blind
    // predicate report EVERY correlation as unusable — turning a deliberate
    // limitation into a total refusal.
    const infinite = { burstWindowMs: Number.POSITIVE_INFINITY }
    expect(codes(correlationOf(), infinite as FleetHealthScan)).toEqual([])
    // Even a day-long burst is coherent under an infinite width, because the
    // span rule is exactly what the infinity switches off.
    expect(codes(DAY_LONG_BURST, infinite as FleetHealthScan)).toEqual([])

    // A NaN width, by contrast, SILENTLY DISABLES the same rule — same
    // observable effect, no declaration of intent — and is refused.
    expect(codes(correlationOf(), { burstWindowMs: Number.NaN } as FleetHealthScan)).toEqual(['unusable_numbers'])

    // The consumer that depends on the legal direction still works...
    expect(isCorrelationSelfConsistent(correlationOf())).toBe(true)
    expect(isCorrelationSelfConsistent(DAY_LONG_BURST)).toBe(true)
    // ...and still rejects what it CAN see.
    expect(isCorrelationSelfConsistent(correlationOf({ agentCount: Number.NaN }))).toBe(false)
    expect(isCorrelationSelfConsistent(TWELVE_CITATIONS_ONE_AGENT)).toBe(false)

    // FIXTURE AUDIT: the two widths are genuinely different kinds of value, so
    // this is a real boundary and not two spellings of the same thing.
    expect(Number.isFinite(Number.POSITIVE_INFINITY)).toBe(false)
    expect(Number.isNaN(Number.POSITIVE_INFINITY)).toBe(false)
    expect(Number.isNaN(Number.NaN)).toBe(true)
  })

  it('RETIRED: a malformed entry is named by position and ranked last, never dropped', () => {
    const report = reportOf({
      correlations: [correlationOf({ correlationKey: 'good' }), null as unknown as ObservedCorrelation],
    })
    const findings = fleetReportIncoherences(report)

    // Named by POSITION, because a malformed entry has no key to be named by.
    expect(findings).toEqual([{ correlationKey: '(correlations[1])', incoherence: 'malformed_correlation' }])

    // Ranked LAST and NOT DROPPED — shortening the list would turn a malformed
    // cluster into an absent one, which is the same false-clean in miniature.
    const ranked = rankFleetCorrelations([null as unknown as ObservedCorrelation, correlationOf({ correlationKey: 'good' })])
    expect(ranked.length).toBe(2)
    expect(ranked[0]?.correlationKey).toBe('good')
    expect(ranked[1]).toBeNull()
  })

  // -------------------------------------------------------------------------
  // THE SHAPE, ATTACKED DIRECTLY
  // -------------------------------------------------------------------------

  it('EVERY exported helper survives the wire shapes the rule was written for', () => {
    // THIS IS THE GENERALISED ATTACK, and it exists because of a pattern this
    // codebase keeps producing: a rule gets STATED in one place and APPLIED in
    // some of the places it should hold. `boundValueDepth` guarded one call
    // site out of five. A vacuity rule was fixed in one layer and left in
    // three. And the null-element rule below was fixed in three functions
    // while three more in the SAME FILE kept the defect.
    //
    // A hand-written list of probes cannot catch that class, because the thing
    // that goes wrong is the list being incomplete. So the subjects are
    // ENUMERATED FROM THE MODULE'S OWN SOURCE, and an export that is not
    // classified fails this test. A new helper cannot be added without someone
    // deciding whether the rule applies to it.
    const src = srcOf('../../packages/contracts/src/fleet_health.ts')
    const exported = [...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1] as string)

    // POSITIVE CLAUSE FIRST, and it is load-bearing: a regex that matched
    // NOTHING would satisfy both directional checks below vacuously — zero
    // unclassified and zero stale, over zero subjects. This is the same
    // negative-clause vacuity this suite exists to hunt, aimed at itself.
    expect(exported.length).toBeGreaterThan(10)
    // Named anchors too, so a formatting change that silently breaks the
    // pattern fails here rather than quietly shrinking the subject list.
    for (const anchor of ['correlationIncoherences', 'fleetReportIncoherences', 'orphanHypotheses']) {
      expect(exported, `enumeration lost ${anchor}`).toContain(anchor)
    }

    // EXHAUSTIVENESS, both directions: nothing unclassified, nothing stale.
    expect(exported.filter((name) => !(name in WIRE_HOSTILE))).toEqual([])
    expect(Object.keys(WIRE_HOSTILE).filter((name) => !exported.includes(name))).toEqual([])

    // THE RULE: a well-formed report carrying a NULL ARRAY ELEMENT — the exact
    // shape wire JSON produces — must never throw. Degrade, name it, rank it
    // last; do not take down the caller.
    const throwers: string[] = []
    for (const name of exported) {
      for (const probe of WIRE_HOSTILE[name] ?? []) {
        try {
          probe()
        } catch {
          throwers.push(name)
          break
        }
      }
    }

    // RETIRED: nothing throws. Every exported helper survives a well-formed
    // report carrying null elements in all four collections.
    expect(throwers).toEqual([])

    // AND THE FIX WAS STRUCTURAL, which is the part worth pinning. `listOf` —
    // the container-only helper that validated an array and trusted its
    // elements — was DELETED, so the primitive that made the mistake easy is
    // no longer available to reach for. Three more hand-patches would have
    // left it sitting there for the next helper.
    expect(src).not.toMatch(/^function listOf/m)
    expect(src).toMatch(/^function indexedElements/m)
    expect(src).toMatch(/^function soundElements/m)

    // TEETH on those three greps: prove each can fire.
    expect(/^function listOf/m.test('function listOf<T>(v: unknown): T[] {')).toBe(true)
    expect(/^function indexedElements/m.test('function indexedElements<T>(value: unknown) {')).toBe(true)

    // AND THE WEB DOES NOT COMPENSATE. `usableArray` validates the CONTAINER,
    // not its contents, so a wire array of nulls passes through the incident
    // view's normalisation intact and straight into the helpers above. That is
    // what makes the three throwers reachable rather than theoretical.
    expect(usableArray([null]).length).toBe(1)

    // And the three that DO hold, asserted positively so a regression in them
    // is distinguishable from the three that never held.
    expect(() => fleetReportIncoherences(reportWithNullElements())).not.toThrow()
    expect(() => rankFleetCorrelations([null as unknown as ObservedCorrelation, correlationOf()])).not.toThrow()
    expect(() => citedAgentCount(null as unknown as ObservedCorrelation)).not.toThrow()
  })

  it('RETIRED: an unreadable element in a GATING collection forces indeterminate', () => {
    // Both gating collections, each on its own. `correlations` was the live
    // sibling this finding surfaced: an unreadable CLAIM about the fleet is
    // neither an observation nor the absence of one, and reading it as absence
    // was `healthy` by the same mechanism as the unanswered case.
    const clean = reportOf({ correlations: [], hypotheses: [], agentsFailing: 0 })

    // FIXTURE AUDIT: the scan is genuinely complete, so the collection under
    // test is the ONLY thing standing between this report and `healthy`.
    expect(isFleetHealthScanComplete(clean.scan)).toBe(true)
    expect(fleetHealthReportVerdict(clean)).toBe('healthy')

    for (const collection of gatingCollections()) {
      const report = { ...clean, [collection]: [null] } as unknown as FleetHealthReport
      expect(isFleetHealthAnalysisComplete(report), collection).toBe(false)
      expect(fleetHealthReportVerdict(report), collection).toBe('indeterminate')
      // Named, not merely blocked — an operator must be able to see WHY.
      expect(
        fleetReportUnusableFields(report).map((f) => f.path),
        collection
      ).toContain(`${collection}[0]`)
    }
  })

  it('THE COUNTERWEIGHT: a malformed DISPLAY element is named but does not block', () => {
    // This is what stops the fix becoming a different uselessness. Withheld
    // from the VERDICT and withheld from the OPERATOR are different things, and
    // "declare everything indeterminate" is its own failure mode — a gate that
    // never certifies is a gate nobody reads.
    const clean = reportOf({ correlations: [], hypotheses: [], agentsFailing: 0 })

    for (const collection of displayCollections()) {
      const report = { ...clean, [collection]: [null] } as unknown as FleetHealthReport
      // NAMED...
      expect(
        fleetReportUnusableFields(report).map((f) => f.path),
        collection
      ).toContain(`${collection}[0]`)
      // ...but NOT blocking.
      expect(isFleetHealthAnalysisComplete(report), collection).toBe(true)
      expect(fleetHealthReportVerdict(report), collection).toBe('healthy')
    }

    // Both display collections malformed at once still certifies, and still
    // names both — the counterweight is not a single-element accident.
    const both = { ...clean, hypotheses: [null], roster: [null] } as unknown as FleetHealthReport
    expect(fleetHealthReportVerdict(both)).toBe('healthy')
    expect(fleetReportUnusableFields(both).length).toBe(2)

    // And sound data still certifies, or "gates correctly" would be satisfied
    // by a function that never returns `healthy` at all.
    expect(fleetHealthReportVerdict(clean)).toBe('healthy')
  })

  it('the REPORTER covers four of four, and the split is DECLARED not maintained', () => {
    // MY OWN SWEEP MISSED THE ORIGINAL DEFECT, and the reason is the lesson:
    // it enumerated FUNCTIONS and asked only "does it throw".
    // `fleetReportUnusableFields` did not throw on a malformed `unanswered`
    // element — it ignored it. A generalized attack is only as general as its
    // dimensions, so this is the second dimension: over the COLLECTIONS a
    // reporter is responsible for, asking "does it REPORT".
    //
    // The subjects are read from the contract's own `REPORT_COLLECTIONS` table
    // rather than from a list maintained here — the same "enumerate from the
    // source, not from a list" rule this file applies to functions, applied to
    // itself. A collection added there is automatically graded here.
    const collections = declaredCollections()

    // POSITIVE CLAUSE: a parse that found nothing would satisfy every check
    // below vacuously.
    expect(collections.length).toBe(4)
    for (const anchor of ['correlations', 'unanswered', 'hypotheses', 'roster']) {
      expect(collections.map((c) => c.name), `table lost ${anchor}`).toContain(anchor)
    }

    const reported = collections
      .map((c) => c.name)
      .filter((name) => {
        const report = {
          ...reportOf({ correlations: [], hypotheses: [], roster: [], unanswered: [] }),
          [name]: [null],
        } as unknown as FleetHealthReport
        return fleetReportUnusableFields(report).some((f) => f.path.startsWith(`${name}[`))
      })

    // FOUR OF FOUR, and by construction rather than by three more patches: the
    // same table drives the gate and the reporter, so they cannot disagree
    // about which collections exist. The original defect was exactly that
    // disagreement — two hand-maintained lists, and the collection missing from
    // one was precisely the completeness-bearing one.
    expect(reported.sort()).toEqual(collections.map((c) => c.name).sort())

    // The rename that followed from covering all four.
    const src = srcOf('../../packages/contracts/src/fleet_health.ts')
    expect(src).toMatch(/"malformed_element"/)
    expect(src).not.toMatch(/not_a_correlation/)
  })

  it('the sweep has teeth: it fails when a subject regresses', () => {
    // Anti-vacuity for the sweep itself. Prove the probe mechanism detects a
    // throwing subject, so "three throwers" is a measurement rather than an
    // artefact of probes that never ran.
    const brokenProbe = () => {
      (null as unknown as { x: number }).x
    }
    let caught = false
    try {
      brokenProbe()
    } catch {
      caught = true
    }
    expect(caught).toBe(true)

    // And prove each classified entry actually invokes something: an empty
    // probe list would make a subject trivially "safe".
    for (const [name, probes] of Object.entries(WIRE_HOSTILE)) {
      expect(probes.length, `${name} has no wire probe`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// RESIDUALS — evasions that still pass, at documented boundaries
// ---------------------------------------------------------------------------

describe('residuals', () => {
  it('RESIDUAL: a wide claim listed to the cap, cited by two agents, is unfalsifiable', () => {
    // The strongest evasion left. Fill `agentIds` to the cap so the list is no
    // longer known-complete, and supply the two distinct citations
    // `wide_claim_uncorroborated` asks for. `agentCount: 500` then rests on the
    // server's word alone.
    const evasion = correlationOf({
      correlationKey: 'burst:unfalsifiable',
      agentCount: 500,
      agentIds: Array.from({ length: MAX_FLEET_CORRELATION_AGENTS }, (_, i) => `ag_${i}`),
      observedBy: [citation('ag_0', 'r_1', T0), citation('ag_1', 'r_2', T0 + MIN)],
    })

    // FIXTURE AUDIT: exactly at the cap, exactly two distinct cited agents.
    expect(evasion.agentIds.length).toBe(MAX_FLEET_CORRELATION_AGENTS)
    expect(new Set(evasion.observedBy.map((c) => c.agentId)).size).toBe(2)

    // Passes — and this is a BOUND, not an oversight: `agentCount` beyond the
    // cap is not verifiable from a bounded report by any client-side rule.
    expect(codes(evasion)).toEqual([])

    // It still ranks first, so the residual has real consequence: breadth
    // decides what an operator reads first.
    const honest = correlationOf({ correlationKey: 'burst:honest', agentCount: 9, agentIds: ['a', 'b', 'c'] })
    expect(rankFleetCorrelations([honest, evasion])[0]!.correlationKey).toBe('burst:unfalsifiable')

    // NOT ledgered as a defect: closing it needs the server-side guarantee that
    // a citation sample spans distinct agents. If that lands and tightens this,
    // this test goes red and should be retired.
  })

  it('RESIDUAL: a single-citation sample is exempt from the coverage rule', () => {
    // With one citation the sample has no room to show more than one agent, so
    // the contract exempts it deliberately. A 12-agent claim listing 12 agents
    // and citing one occurrence therefore passes.
    const single = correlationOf({
      agentCount: 12,
      agentIds: Array.from({ length: 12 }, (_, i) => `ag_${i}`),
      observedBy: [citation('ag_1', 'r_1', T0)],
    })
    expect(single.observedBy.length).toBe(1)
    expect(codes(single)).toEqual([])

    // Add one more citation from the SAME agent and it is caught immediately —
    // which is what makes the exemption narrow rather than a hole.
    expect(
      codes({ ...single, observedBy: [citation('ag_1', 'r_1', T0), citation('ag_1', 'r_2', T0 + 1_000)] })
    ).toContain('evidence_confined_to_one_agent')
  })
})

// ---------------------------------------------------------------------------
// STANDING ATTACKS — found nothing on the first pass, and still do not
// ---------------------------------------------------------------------------

describe('false-clean', () => {
  it('an empty scan cannot produce an all-clear', () => {
    const emptyScan = scanOf({ agentsInRoster: 0, agentsAssessed: 0, occurrencesScanned: 0 })

    // FIXTURE AUDIT: every NEGATIVE clause is satisfied, so a predicate built
    // only from negatives would return true here.
    expect(emptyScan.scanTruncated).toBe(false)
    expect(emptyScan.agentsUnassessable).toBe(0)
    expect(emptyScan.agentsSkippedForBudget).toBe(0)
    expect(emptyScan.nextCursor).toBeUndefined()

    expect(isFleetHealthScanComplete(emptyScan)).toBe(false)
    expect(
      computeFleetHealthVerdict({
        correlationCount: 0,
        agentsFailing: 0,
        complete: isFleetHealthScanComplete(emptyScan),
      })
    ).toBe('indeterminate')
  })

  it('every individual way of not having looked defeats completeness', () => {
    const cases: Array<[string, FleetHealthScan]> = [
      ['nothing assessed', scanOf({ agentsAssessed: 0 })],
      ['page-local correlation', scanOf({ correlationBasis: 'page_local' })],
      ['row ceiling hit', scanOf({ scanTruncated: true })],
      ['an agent unassessable', scanOf({ agentsUnassessable: 1 })],
      ['an agent skipped for budget', scanOf({ agentsSkippedForBudget: 1 })],
      ['a page still outstanding', scanOf({ nextCursor: 'more' })],
    ]
    for (const [label, scan] of cases) {
      expect(isFleetHealthScanComplete(scan), label).toBe(false)
    }
    // The all-good scan must be complete, or the sweep above is vacuous.
    expect(isFleetHealthScanComplete(scanOf())).toBe(true)

    const withQuestion = reportOf({
      correlations: [],
      agentsFailing: 0,
      unanswered: [
        {
          certainty: 'unanswered',
          kind: 'roster_incomplete',
          questionKey: 'q1',
          undecidedQuestion: 'whether the 40 agents past the ceiling also failed inside this window',
          unknownBecause: 'the roster ceiling (200) was reached',
        },
      ],
    })
    expect(isFleetHealthAnalysisComplete(withQuestion)).toBe(false)
    expect(fleetHealthReportVerdict(withQuestion)).toBe('indeterminate')
  })

  it('a truncated scan cannot HIDE an observed correlation', () => {
    const truncatedButCorrelated = reportOf({ scan: scanOf({ scanTruncated: true, agentsSkippedForBudget: 40 }) })
    expect(isFleetHealthAnalysisComplete(truncatedButCorrelated)).toBe(false)
    expect(fleetHealthReportVerdict(truncatedButCorrelated)).toBe('correlated_failures')
  })

  it('agents that were never run are not counted as passing', () => {
    const contractSrc = srcOf('../../packages/contracts/src/fleet_health.ts')
    const stateUnion = /export type AgentHealthState =[\s\S]*?;/.exec(contractSrc)?.[0] ?? ''
    expect(stateUnion.length).toBeGreaterThan(0)
    expect(stateUnion).toMatch(/"unobserved"/)
    expect(stateUnion).toMatch(/"healthy"/)
  })
})

describe('hypothesis-quarantine', () => {
  it('a hypothesis cannot reach the verdict, at any count', () => {
    const flooded = reportOf({
      correlations: [],
      agentsFailing: 0,
      hypotheses: Array.from({ length: 50 }, (_, i) =>
        hypothesisOf({ hypothesisKey: `h${i}`, restingOn: ['burst:base'] })
      ),
    })
    expect(
      computeFleetHealthVerdict({
        correlationCount: flooded.correlations.length,
        agentsFailing: flooded.agentsFailing,
        complete: isFleetHealthAnalysisComplete(flooded),
      })
    ).toBe('healthy')

    const contractSrc = srcOf('../../packages/contracts/src/fleet_health.ts')
    const verdictInput = /export interface FleetHealthVerdictInput \{[\s\S]*?\n\}/.exec(contractSrc)?.[0] ?? ''
    expect(verdictInput.length).toBeGreaterThan(0)
    expect(verdictInput).not.toMatch(/hypothes/i)

    const cliSrc = srcOf('../../packages/cli/src/commands/fleet.ts')
    const exitFn = /export function exitCodeForFleet[\s\S]*?\n\}/.exec(cliSrc)?.[0] ?? ''
    expect(exitFn.length).toBeGreaterThan(0)
    expect(exitFn).not.toMatch(/hypothes/i)
  })

  it('the base rate that makes a shared attribute worthless is reported as such', () => {
    expect(
      discriminationOf(
        measurementOf({ affectedSharing: 12, affectedTotal: 12, unaffectedSharing: 186, unaffectedTotal: 188 })
      )
    ).toBe('not_discriminating')
    expect(
      discriminationOf(
        measurementOf({ affectedSharing: 9, affectedTotal: 9, unaffectedSharing: 0, unaffectedTotal: 191 })
      )
    ).toBe('discriminating')
    expect(discriminationOf(measurementOf({ unaffectedSharing: null, unaffectedTotal: null }))).toBe(
      'base_rate_unmeasured'
    )
    expect(discriminationOf(measurementOf({ measurementTruncated: true }))).toBe('base_rate_unmeasured')
    expect(discriminationOf(measurementOf({ unaffectedSharing: 0, unaffectedTotal: 0 }))).toBe('base_rate_unmeasured')
  })
})

describe('wire-gate', () => {
  it('the HTTP surface these reports arrive over still does not exist', () => {
    // STANDING GUARD: when the route lands, this fails, and the residuals above
    // become reachable through a component this repo DOES compile.
    expect(srcOf('../../packages/sdk/src/reader.ts')).toMatch(/GET \/api\/v1\/fleet\/health` does not exist yet/)
    expect(() => srcOf('../../convex/helpers/fleet.ts')).not.toThrow()
  })

  it('the gate refuses each conflation it claims to refuse', () => {
    const gate =
      /function assertFleetHealthReportTrustworthy[\s\S]*?\n\}/.exec(srcOf('../../packages/sdk/src/reader.ts'))?.[0] ??
      ''
    expect(gate.length).toBeGreaterThan(0)
    expect(gate).toMatch(/certainty !== 'observed'/)
    expect(gate).toMatch(/certainty !== 'hypothesis'/)
    expect(gate).toMatch(/observedBy\.length === 0/)
    expect(gate).toMatch(/sharedBy/)
    expect(gate).toMatch(/agentsAssessed/)
    expect(gate).toMatch(/assertVerdictConsistent\(report\.verdict, fleetHealthReportVerdict\(report\)/)

    // TEETH: prove these greps can fail against a gate that lost the property.
    expect(/certainty !== 'observed'/.test('// we used to check certainty here')).toBe(false)
  })

  it('a verdict string that disagrees with its own contents is detectable', () => {
    const lying = reportOf({ verdict: 'healthy' })
    expect(fleetHealthReportVerdict(lying)).toBe('correlated_failures')

    const lyingClean = reportOf({
      verdict: 'healthy',
      correlations: [],
      agentsFailing: 0,
      scan: scanOf({ agentsAssessed: 0 }),
    })
    expect(fleetHealthReportVerdict(lyingClean)).toBe('indeterminate')
  })
})

// ---------------------------------------------------------------------------
// TEETH
// ---------------------------------------------------------------------------

describe('teeth', () => {
  it('every retired defect has a live check behind it, not merely a silent probe', () => {
    // THE anti-vacuity assertion for an empty ledger. Each retirement is
    // re-derived here from the shipped function's OUTPUT — never from a
    // constant, never from "nothing was recorded". If any of these checks is
    // removed, the entry is RE-RECORDED and the ledger goes red, rather than
    // the suite going quietly green.
    const retirements: Array<[string, () => boolean]> = [
      [
        'burst/span-never-checked-against-burstWindowMs',
        () => codes(DAY_LONG_BURST).includes('burst_span_exceeds_window'),
      ],
      [
        'burst/evidence-need-not-cover-the-claimed-breadth',
        () => codes(TWELVE_CITATIONS_ONE_AGENT).includes('evidence_confined_to_one_agent'),
      ],
      [
        'rank/unvalidated-breadth-decides-what-is-read-first',
        () => codes(INFLATED_SHORT_LIST).includes('agent_count_contradicts_listed_agents'),
      ],
      [
        'hypothesis/partial-orphan-passes-as-grounded',
        () =>
          orphanHypotheses(reportOf({ hypotheses: [hypothesisOf({ restingOn: ['burst:base', 'gone'] })] })).length === 1,
      ],
    ]
    const regressed: string[] = []
    for (const [id, stillFixed] of retirements) {
      if (!stillFixed()) {
        record(id)
        regressed.push(id)
      }
    }
    // Executed, not asserted by hand: every retirement holds right now. Scoped
    // to the RETIRED ids — the ledger also carries live defects found since,
    // so asserting the whole set were empty would be wrong.
    expect(regressed).toEqual([])
  })

  it('the checkers reject a broken subject and pass an intact one', () => {
    expect(codes({ ...correlationOf(), lastObservedAt: T0 - HOUR })).toContain('inverted_window')
    expect(codes({ ...correlationOf(), observedBy: [citation('ag_1', 'r', T0 - HOUR)] })).toContain(
      'citation_outside_window'
    )
    // ...and an intact one is clean, so they are not simply always-on.
    expect(codes(correlationOf())).toEqual([])
  })

  it('the source-read probes fail against a source that lost the property', () => {
    const gateCall = /fleetReportIncoherences\(report\)/
    expect(gateCall.test('const incoherences = fleetReportIncoherences(report)')).toBe(true)
    expect(gateCall.test('// we used to call the incoherence enumerator')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

describe('defect ledger', () => {
  it('observed defects are EXACTLY the known set', () => {
    expect([...observedDefects].sort()).toEqual([...KNOWN_DEFECTS].sort())
  })

  it('an empty ledger is backed by live checks, not by absent probes', () => {
    // The ledger being empty is only meaningful because the teeth test above
    // re-derives all four retirements from shipped behaviour and re-records any
    // that regress. Assert that mechanism still exists in this file.
    const self = srcOf('./fleet_adversarial_engine.test.ts')
    expect(self).toContain('every retired defect has a live check behind it')
    expect(self).toContain('record(id)')
  })
})
