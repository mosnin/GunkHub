/**
 * fleet/adapt.ts — an INTERIM producer of `FleetHealthReport` from the data
 * that is actually queryable in this tree today.
 *
 * ===========================================================================
 * WHY THIS EXISTS AND WHAT IT PROMISES NOT TO DO
 * ===========================================================================
 *
 * `packages/contracts/src/fleet_health.ts` (Team B) and
 * `convex/helpers/fleet.ts` (Team A) have landed, but NO CONVEX QUERY IS
 * REGISTERED yet — there is no `fleet:getFleetHealth` for the service layer to
 * call, and `GET /api/v1/fleet/health` does not exist (the SDK reader says so
 * itself). So the surface would be wired to nothing, and none of its states
 * would ever have been exercised against real rows.
 *
 * This module fills that gap from `failure_patterns`, which IS registered,
 * org-scoped, and carries the two things a cross-agent correlation needs:
 * `affectedAgentIds` (ADR-006 cycle 2) and, via the detail query,
 * `FailurePatternOccurrence` rows with `agentId` + `runId` + `occurredAt` —
 * real, checkable citations. A failure fingerprint recorded on two or more
 * agents IS a `shared_failure_fingerprint` correlation. Not an approximation
 * of one: the same fact, from a coarser source.
 *
 * ---------------------------------------------------------------------------
 * THE PROMISES
 * ---------------------------------------------------------------------------
 *
 * 1. NOTHING IS FABRICATED. Every `FailureOccurrenceCitation` comes from a
 *    stored occurrence row, so `isCorrelationSelfConsistent` holds by
 *    construction rather than by luck. A pattern whose occurrences could not be
 *    read produces NO correlation — never one with an invented citation.
 *
 * 2. EVERY LIMIT BECOMES AN `UnansweredFleetQuestion`. This is the elegant part
 *    of the contract and the reason this interim path is defensible at all:
 *    the third band exists precisely so a gap can be STATED rather than
 *    silently absorbed. This source cannot see per-agent run counts, cannot
 *    tell a healthy agent from an unobserved one, and cannot measure base
 *    rates — so it emits one honest, remediable question for each, and the
 *    scan is consequently INCOMPLETE, which forces `indeterminate`.
 *
 * 3. IT NEVER CLAIMS A CLEAN FLEET. `agentsSkippedForBudget` covers every agent
 *    with no failure pattern, because this source cannot distinguish "ran and
 *    passed" from "never ran". `isFleetHealthScanComplete` therefore returns
 *    false, and `computeFleetHealthVerdict` can never return `healthy` from
 *    this path. An all-clear derived from a source that cannot see health
 *    would be the exact false-clean the whole feature is built against.
 *
 * 4. THE ROSTER IS EMPTY RATHER THAN GUESSED. `AgentHealthEntry` requires
 *    `runsObserved`/`runsFailed`, which this source does not have. Emitting
 *    zeros would render every agent as `unobserved`, which is a claim about
 *    those agents that nothing supports.
 *
 * TODO(team-a-fleet-engine): when a Convex fleet query is registered and
 * `/api/v1/fleet/health` exists, DELETE this module. The service layer maps
 * the engine's report straight through, and no component changes — they are
 * all written against the contract types already.
 */


import {
  computeFleetHealthVerdict,
  isFleetHealthScanComplete,
  MAX_FLEET_CORRELATION_AGENTS,
} from '@agent-flight-recorder/contracts'

import { formatClockUtc } from './window'

import type { ResolvedFleetWindow } from './window'
import type {
  FailureOccurrenceCitation,
  FailurePattern,
  FailurePatternDetail,
  FleetHealthReport,
  FleetHealthScan,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
} from '@agent-flight-recorder/contracts'

/** Citations carried per correlation. A sample sufficient to check the claim. */
const MAX_CITATIONS = 4

/**
 * The `affectedAgentIds` cap on `FailurePattern` (ADR-006). When a pattern is
 * at the cap, its true cluster may be larger and the scan must say so.
 */
const PATTERN_AGENT_CAP = 20

export interface FleetAdapterInput {
  /** Every pattern the list query returned. */
  patterns: readonly FailurePattern[]
  /** Details for the patterns that were promoted to correlations, by hash. */
  details: ReadonlyMap<string, FailurePatternDetail>
  /** Multi-agent patterns the detail budget did not reach. */
  patternsNotDetailed: number
  window: ResolvedFleetWindow
  burstWindowMs: number
  /** Agents in the org's roster. */
  agentsInRoster: number
  /** True when the pattern list hit its own ceiling. */
  listTruncated: boolean
  listCeiling: number
}

/**
 * Build citations from stored occurrence rows.
 *
 * Only occurrences whose `agentId` is in the cluster and whose `occurredAt`
 * falls inside the correlation's own window are eligible — the invariant
 * `isCorrelationSelfConsistent` checks. Filtering here rather than trusting the
 * source is what makes that invariant hold by construction.
 */
function citationsFor(
  detail: FailurePatternDetail,
  firstObservedAt: number,
  lastObservedAt: number,
): FailureOccurrenceCitation[] {
  const seenAgents = new Set<string>()
  const out: FailureOccurrenceCitation[] = []
  for (const occ of detail.recentOccurrences) {
    if (occ.occurredAt < firstObservedAt || occ.occurredAt > lastObservedAt) continue
    // Prefer breadth: one citation per agent shows the reader the cluster
    // rather than four runs of the loudest member.
    if (seenAgents.has(occ.agentId)) continue
    seenAgents.add(occ.agentId)
    out.push({
      cites: 'failure_occurrence',
      agentId: occ.agentId,
      runId: occ.runId,
      fingerprintHash: occ.fingerprintHash,
      occurredAt: occ.occurredAt,
    })
    if (out.length >= MAX_CITATIONS) break
  }
  return out
}

function correlationFor(
  p: FailurePattern,
  detail: FailurePatternDetail | undefined,
): ObservedCorrelation | null {
  const agentIds = [...new Set(p.affectedAgentIds ?? [])]
  if (agentIds.length < 2) return null
  if (detail === undefined) return null

  const citations = citationsFor(detail, p.firstSeenAt, p.lastSeenAt)
  // `observedBy` is non-empty BY TYPE. No citation, no correlation — there is
  // no honest way to render the row, so it is not rendered.
  const [c0, ...rest] = citations
  if (c0 === undefined) return null

  const shown = agentIds.slice(0, MAX_FLEET_CORRELATION_AGENTS)
  return {
    certainty: 'observed',
    kind: 'shared_failure_fingerprint',
    correlationKey: `shared_fingerprint:${p.fingerprintHash}`,
    // Past tense, with its counts, about what was RECORDED. Never "model X is
    // failing" — the contract is explicit and this is the sentence a reader
    // acts on.
    observedFact: `${agentIds.length} agents recorded failures matching fingerprint ${p.fingerprintHash.slice(0, 12)} (${p.label}) between ${formatClockUtc(p.firstSeenAt)}Z and ${formatClockUtc(p.lastSeenAt)}Z.`,
    agentIds: shown,
    agentCount: agentIds.length,
    firstObservedAt: p.firstSeenAt,
    lastObservedAt: p.lastSeenAt,
    observedBy: [c0, ...rest],
  }
}

/**
 * The one hypothesis this source can honestly propose: several distinct
 * fingerprints that all began inside one burst window.
 *
 * `coincident_in_time` is the right kind — nothing shared can be NAMED here,
 * because this source cannot read config snapshots. Proposing `shared_model`
 * without having looked at a single model declaration would be inventing the
 * attribute, which is worse than proposing nothing.
 *
 * `sharedBy` carries `null` for the unaffected population, which is what
 * `discriminationOf` reports as `base_rate_unmeasured` — and the UI then says
 * there is no denominator rather than letting the numerator imply one.
 */
function coincidenceHypothesis(
  correlations: readonly ObservedCorrelation[],
  burstWindowMs: number,
): HypothesisedCause | null {
  const sorted = [...correlations].sort((a, b) => a.firstObservedAt - b.firstObservedAt)

  let best: ObservedCorrelation[] = []
  for (const anchor of sorted) {
    const group = sorted.filter(
      (c) =>
        c.firstObservedAt >= anchor.firstObservedAt &&
        c.firstObservedAt - anchor.firstObservedAt <= burstWindowMs,
    )
    if (group.length > best.length) best = group
  }
  if (best.length < 2) return null

  // Read, then check. `best[0]!` asserted what `best.length >= 2` implies —
  // true, but the assertion is exactly the habit that produced this iteration's
  // base-rate crash one layer up, and it costs nothing to not have it here.
  const earliest = best[0]
  const latest = best[best.length - 1]
  if (earliest === undefined || latest === undefined) return null
  const from = earliest.firstObservedAt
  const to = latest.firstObservedAt
  const [k0, ...kRest] = best.map((c) => c.correlationKey)
  if (k0 === undefined) return null

  const affectedAgents = new Set(best.flatMap((c) => c.agentIds)).size

  return {
    certainty: 'hypothesis',
    kind: 'coincident_in_time',
    hypothesisKey: `coincident:${from}`,
    // NO HEADLINE SENTENCE. `hypothesisQuestion` composes it from `kind`, and
    // `coincident_in_time` is about no attribute, so there is no `sharedValue`
    // either — this source reads no config snapshots and must not name an
    // attribute it never looked at.
    restingOn: [k0, ...kRest],
    notEstablishedBecause: `Nothing recorded connects these ${best.length} fingerprints to each other; they merely each began between ${formatClockUtc(from)}Z and ${formatClockUtc(to)}Z. Independent faults cluster in time by chance, and this scan has not measured how often that happens here, so the cluster is not surprising against any known base rate.`,
    sharedBy: {
      affectedSharing: affectedAgents,
      affectedTotal: affectedAgents,
      // NOT MEASURED. Never zero — zero would be the strongest possible
      // support for this hypothesis, and it is the opposite of what is known.
      unaffectedSharing: null,
      unaffectedTotal: null,
      measurementTruncated: false,
    },
    wouldBeTestedBy: `Look for a deploy, provider status incident, or configuration change timestamped between ${formatClockUtc(from)}Z and ${formatClockUtc(to)}Z — and find an agent that was NOT exposed to it and did NOT start failing.`,
  }
}

export function buildInterimFleetReport(input: FleetAdapterInput): FleetHealthReport {
  const { window } = input
  const since = window.startedAt
  const until = window.endedAt

  // `lastSeenAt` is the right window test, not `firstSeenAt`: a long-standing
  // fingerprint that fired again five minutes ago is part of today's incident;
  // one that stopped last week is not.
  const inWindow = input.patterns.filter((p) => p.lastSeenAt >= since && p.lastSeenAt <= until)
  const multiAgent = inWindow.filter((p) => (p.affectedAgentIds ?? []).length >= 2)

  const correlations: ObservedCorrelation[] = []
  let uncitable = 0
  for (const p of multiAgent) {
    const c = correlationFor(p, input.details.get(p.fingerprintHash))
    if (c === null) uncitable += 1
    else correlations.push(c)
  }

  const assessedAgents = new Set(inWindow.flatMap((p) => p.affectedAgentIds ?? []))
  const agentsAssessed = assessedAgents.size
  const agentsFailing = agentsAssessed

  // ---------------------------------------------------------------------
  // Every limit of this source, stated as a question rather than absorbed.
  // ---------------------------------------------------------------------
  const unanswered: UnansweredFleetQuestion[] = [
    {
      certainty: 'unanswered',
      kind: 'roster_incomplete',
      questionKey: 'interim:health_of_non_failing_agents',
      undecidedQuestion:
        'whether the agents with no recorded failure fingerprint in this window ran at all, or ran and passed',
      unknownBecause:
        'This view is derived from failure-pattern rollups, which record only failures. An agent absent from them may be healthy or may have stopped running entirely, and those are different incidents.',
      remedy:
        'Register the fleet health engine as a Convex query and serve GET /api/v1/fleet/health, which reads per-agent run counts directly.',
    },
    {
      certainty: 'unanswered',
      kind: 'base_rate_unmeasurable',
      questionKey: 'interim:base_rates',
      undecidedQuestion:
        'how often unaffected agents share whatever the affected agents share',
      unknownBecause:
        'Measuring a base rate means reading the configuration snapshot of every healthy agent. This source cannot enumerate healthy agents at all, so no denominator exists.',
      remedy:
        'The fleet engine measures base rates during its correlation pass; until it is wired up, every hypothesis here is unrankable.',
    },
  ]

  if (uncitable > 0) {
    unanswered.push({
      certainty: 'unanswered',
      kind: 'occurrence_history_truncated',
      questionKey: 'interim:uncitable_clusters',
      undecidedQuestion: `whether the ${uncitable} multi-agent fingerprint${uncitable === 1 ? '' : 's'} with no readable in-window occurrence rows are real clusters`,
      unknownBecause:
        'Their stored occurrence rows fell outside the fingerprint’s own observed window or could not be read, so no citation could be attached. A correlation with no evidence is not rendered.',
      remedy: 'Open the pattern directly from the Patterns page to inspect its occurrences.',
    })
  }

  if (input.patternsNotDetailed > 0) {
    unanswered.push({
      certainty: 'unanswered',
      kind: 'engine_limit',
      questionKey: 'interim:details_budget',
      undecidedQuestion: `whether the ${input.patternsNotDetailed} further multi-agent fingerprint${input.patternsNotDetailed === 1 ? '' : 's'} in this window are also clusters`,
      unknownBecause:
        'Each correlation costs a separate detail query for its citations, and this view stops before issuing more than its budget allows.',
      remedy: 'Narrow the window, or wire up the fleet engine, which correlates in one pass.',
    })
  }

  const cappedClusters = multiAgent.filter(
    (p) => (p.affectedAgentIds ?? []).length >= PATTERN_AGENT_CAP,
  ).length
  if (cappedClusters > 0) {
    unanswered.push({
      certainty: 'unanswered',
      kind: 'engine_limit',
      questionKey: 'interim:agent_cap',
      undecidedQuestion: `whether ${cappedClusters === 1 ? 'one cluster reaches' : `${cappedClusters} clusters reach`} beyond ${PATTERN_AGENT_CAP} agents`,
      unknownBecause: `The failure-pattern rollup caps its affected-agent list at ${PATTERN_AGENT_CAP}, so a cluster at the cap may be wider. Its agent count is a floor.`,
      remedy: 'The fleet engine counts cluster membership directly rather than from a capped list.',
    })
  }

  const hypothesis = coincidenceHypothesis(correlations, input.burstWindowMs)

  const scan: FleetHealthScan = {
    since,
    until,
    burstWindowMs: input.burstWindowMs,
    // WHOLE-ROSTER ONLY WHEN NEITHER BOUND BOUND.
    //
    // This previously hardcoded `whole_roster`, which was wrong and wrong in
    // the dangerous direction. `scanTruncated` and `correlationBasis` answer
    // DIFFERENT questions by the contract's design: the first says "we stopped
    // early", the second says "could a cluster have been cut in half". Pinning
    // the second to `whole_roster` meant the reader's and the CLI's dedicated
    // page-local warning could never fire — suppressed for exactly the largest
    // orgs, where clusters are likeliest to straddle a page.
    //
    // TWO bounds can partition this source's correlation pass, and either one
    // alone is enough to cut a cluster:
    //   - the pattern listing hit its ceiling, so fingerprints exist that were
    //     never seen at all;
    //   - the per-correlation detail budget was reached, so multi-agent
    //     fingerprints were seen but never correlated.
    //
    // When NEITHER bound, the pass genuinely saw every failure pattern in the
    // org and correlated every multi-agent one, and `whole_roster` is the true
    // value. Reporting `page_local` unconditionally would fire the "a cluster
    // may have been cut in half" warning on every quiet org where nothing was
    // cut — which trains operators to ignore the one signal that matters when
    // it is real, and leaves `whole_roster` as a value the code can never
    // produce.
    correlationBasis:
      input.listTruncated || input.patternsNotDetailed > 0 ? 'page_local' : 'whole_roster',
    agentsInRoster: input.agentsInRoster,
    agentsAssessed,
    agentsUnassessable: 0,
    // Every agent with no failure pattern. This source cannot tell a passing
    // agent from an idle one, so it claims neither — and this non-zero value
    // is what keeps `isFleetHealthScanComplete` false and `healthy`
    // unreachable from this path.
    agentsSkippedForBudget: Math.max(0, input.agentsInRoster - agentsAssessed),
    occurrencesScanned: inWindow.reduce((n, p) => n + p.representativeRunIds.length, 0),
    scanTruncated: input.listTruncated,
    ...(input.listTruncated && { scanRowCeiling: input.listCeiling }),
    baseRatesMeasured: false,
  }

  return {
    analyzedAt: Date.now(),
    verdict: computeFleetHealthVerdict({
      correlationCount: correlations.length,
      agentsFailing,
      complete: isFleetHealthScanComplete(scan),
    }),
    // Not guessed. See promise 4 in this module's header.
    roster: [],
    correlations,
    hypotheses: hypothesis === null ? [] : [hypothesis],
    unanswered,
    agentsFailing,
    scan,
  }
}
