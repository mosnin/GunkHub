// ---------------------------------------------------------------------------
// FLEET HEALTH & CROSS-AGENT CORRELATION ENGINE
//
// "What is wrong across everything, and what is it that is actually wrong?"
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness. Same posture as convex/helpers/{divergence,otel_mapping,
// analytics,evals,failure_summary}.ts. `analyzedAt` is an INPUT for the same
// reason it is in helpers/divergence.ts.
//
// ===========================================================================
// PART 1 — THE CONTRACT VOCABULARY, IMPORTED (not mirrored)
// ===========================================================================
//
// Everything about certainty, coverage and verdict is IMPORTED from
// `packages/contracts/src/fleet_health.ts`, which is canonical. There is no
// copy of it here.
//
// This follows helpers/divergence.ts, which made the same call for the same
// reason and tested rather than inherited the "convex/ has no contracts
// dependency" precedent: `convex/package.json` depends on
// `@agent-flight-recorder/contracts`, so both the TYPES and the RUNTIME
// functions (`computeFleetHealthVerdict`, `isFleetHealthScanComplete`,
// `discriminationOf`) resolve and EXECUTE inside the Convex isolate.
//
// It matters more here than anywhere else in the product. This feature's entire
// credibility is the OBSERVED/HYPOTHESIS boundary, and a mirror is two
// definitions of that boundary that can silently disagree. A drifted comparator
// sorts wrong; a drifted certainty boundary gets a healthy model rolled back at
// 3am. An earlier draft of this file defined the vocabulary locally and
// recorded the debt in a comment; the contract landed and the local copy was
// DELETED rather than kept in sync, which is the only correct resolution.
//
// ===========================================================================
// PART 2 — CORRELATION IS NOT CAUSATION
// ===========================================================================
//
// The contract header states this in full and this engine implements it rather
// than reinterpreting it. The two rules that bind the code below:
//
//   * An `ObservedCorrelation` is a statement about ROWS, in the past tense,
//     carrying `observedBy` citations that can be opened and checked.
//   * A `HypothesisedCause` is a reading of one. It must name the correlations
//     it rests on (`restingOn`), must carry its denominator (`sharedBy`), and
//     CANNOT MOVE THE VERDICT — `computeFleetHealthVerdict` has no parameter
//     for it, so this engine has nowhere to put one even if it wanted to.
//
// ===========================================================================
// PART 3 — WHY THE CORRELATION PASS IS NOT PAGED, AND CANNOT BE
// ===========================================================================
//
// A per-agent analysis composes across pages: counts add. A CROSS-AGENT
// CORRELATION DOES NOT. A burst of twelve agents split four-and-eight across
// two pages is two sub-threshold clusters — invisible on each page, and
// invisible in any merge of them, because by the time the pages are merged the
// twelve onsets have already been discarded by two threshold tests. The failure
// is silent and total: nothing in either page's output says a cluster was cut
// in half.
//
// This is NOT a truncation-honesty problem. Honest reporting recovers a bounded
// answer from a bounded scan; it cannot recover a signal that the partition
// itself destroyed. So there is deliberately NO merge helper here and no page
// cursor over occurrences. The correlation pass runs over the WHOLE window's
// occurrences for the WHOLE roster in ONE execution, and `correlationBasis`
// declares where it ran. `page_local` can never be complete
// (`isFleetHealthScanComplete`).
//
// An earlier draft of this engine spent its single `.paginate()` on
// occurrences, which is exactly the defect above. It was reported honestly —
// `scanTruncated`, roster graded indeterminate — and it was still WRONG, for
// the reason in the paragraph above. The fix was structural: stop paging the
// substrate, page only the roster LISTING.
//
// ===========================================================================
// PART 4 — EXISTENCE CLAIMS SURVIVE TRUNCATION; COMPARISONS DO NOT
// ===========================================================================
//
// "Twelve agents failed together" is an EXISTENCE claim: reading more rows can
// only confirm it, so a bounded scan that saw twelve saw twelve. Report it.
// This is why `computeFleetHealthVerdict` returns `correlated_failures` even on
// an incomplete scan.
//
// "This exceeds normal" is a COMPARISON and needs the baseline period to have
// been read. It fails in the most dangerous direction, so it is gated:
//
//   Occurrence rows are read most-recent-first. A descending scan that hits its
//   row cap loses the OLDEST rows — which is precisely the BASELINE. During a
//   large incident the naive engine reads 5,000 rows all from the last twenty
//   minutes, finds an empty baseline, and reports "12 agents versus a baseline
//   of 0: UNPRECEDENTED". The bigger the incident, the more certain it sounds,
//   and the "unprecedented" was manufactured entirely by the row cap.
//
// THE MITIGATION IS STRUCTURAL, NOT A LARGER CAP. The analysis window and the
// baseline window are separately-budgeted range scans (convex/fleet.ts), and
// {@link isBaselineEstablished} gates the comparison. When it is false the
// baseline sentence is NOT APPENDED to the correlation's `observedFact` and an
// {@link UnansweredFleetQuestion} says so. The correlation itself is still
// reported in full.
//
// ===========================================================================
// PART 5 — THE CITATION INVARIANT THIS ENGINE OWES THE CONTRACT
// ===========================================================================
//
// `isCorrelationSelfConsistent` deliberately cannot catch a twelve-agent
// cluster whose twelve citations all come from ONE agent: `observedBy` is a
// bounded sample, so requiring it to cover `agentIds` would reject honest
// reports. The contract left the hole open and named the server-side guarantee
// that closes it, and this engine is where that guarantee lives:
//
//   EVERY CORRELATION'S CITATION SAMPLE SPANS DISTINCT AGENTS — one citation
//   per agent, up to the bound. See {@link citationsSpanningAgents}, which is
//   the ONLY way a citation list is built here, and
//   {@link citationsSpanDistinctAgents}, which asserts it.
//
// This is the difference between "twelve agents are failing" and "one agent
// failed twelve times", which is the entire point of a fleet view. A sample
// that silently collapses to one agent turns the second into the first.
//
// ===========================================================================
// PART 6 — VACUOUS TRUTH
// ===========================================================================
//
// Every completeness predicate asserts at least one POSITIVE condition — that
// evidence EXISTS — before asserting that nothing went wrong. A predicate built
// only from negative clauses is vacuously true on empty input. The contract's
// `isFleetHealthScanComplete` carries `agentsAssessed > 0` for this reason; the
// two predicates defined locally here ({@link isBaselineEstablished},
// {@link isRunPopulationMeasurable}) each carry their own, documented
// individually below.
// ---------------------------------------------------------------------------

import {
  computeFleetHealthVerdict,
  discriminationOf,
  isFleetHealthScanComplete,
  MAX_FLEET_CORRELATION_AGENTS,
  rankFleetCorrelations,
  type AgentHealthEntry,
  type AgentHealthState,
  type CorrelationBasis,
  type FailureOccurrenceCitation,
  type FleetHealthReport,
  type FleetHealthScan,
  type FleetShareMeasurement,
  type HypothesisedCause,
  type HypothesisedCauseKind,
  type ObservedCorrelation,
  type UnansweredFleetQuestion,
} from "@agent-flight-recorder/contracts";

import { readConfigSnapshot, type ReadConfig } from "./divergence.js";

export type {
  AgentHealthEntry,
  AgentHealthState,
  CorrelationBasis,
  FleetHealthReport,
  FleetHealthScan,
  FleetShareMeasurement,
  HypothesisedCause,
  ObservedCorrelation,
  UnansweredFleetQuestion,
};

// ===========================================================================
// PART A — INPUTS. Plain rows, so the engine is testable with literals.
// ===========================================================================

export interface FleetAgentInput {
  agentId: string;
  name: string;
}

/**
 * One `failure_pattern_occurrences` row.
 *
 * This table is the whole substrate of this feature and it is why the feature
 * costs ZERO event reads: it is already a denormalized, org-scoped,
 * time-indexed (fingerprint x agent x run x time) fact table, written
 * idempotently once per failing run.
 */
export interface FleetOccurrenceInput {
  occurrenceId: string;
  runId: string;
  agentId: string;
  agentVersionId?: string;
  fingerprintHash: string;
  /**
   * Carried because it distinguishes a heterogeneous burst that is plausibly
   * one upstream fault (four fingerprints, all one class) from four agents that
   * broke at once for four unrelated reasons. REPORTED, never used to merge
   * fingerprints: two failures sharing a class are not the same failure.
   */
  heuristicClass: string;
  occurredAt: number;
}

export interface FleetRunInput {
  runId: string;
  agentId: string;
  agentVersionId?: string;
  startedAt: number;
  status: string;
}

export type FleetFixConfidenceState = "unproven" | "proving" | "confirmed" | "regressed";
export type FleetPatternStatus = "open" | "acknowledged" | "resolved";

/**
 * One `failure_patterns` rollup, reduced to what this engine reads.
 *
 * REUSED, NOT REINVENTED. `isSpiking` is the assessment already computed and
 * stored by `assessPatternSpikesCron`; this engine does not define a second,
 * competing notion of spiking. It does treat it as a STORED MEASUREMENT WITH AN
 * AGE — `spikeAssessedAt` is carried so a stale assessment becomes a named
 * unanswered question rather than a silent input, which matters because the
 * assessment cron falling behind is likeliest during the load spike this
 * analysis exists for.
 */
export interface FleetPatternInput {
  fingerprintHash: string;
  label: string;
  patternClass: string;
  /**
   * Carried and SURFACED, never used to filter.
   *
   * Muting suppresses ALERTING for a pattern (it gates `firePatternSpikeAlert`
   * and nothing else). Using it to hide a pattern from a fleet health view
   * would be a different and much worse thing: a pattern muted when it affected
   * one agent is not thereby unimportant when it has spread to twelve, and
   * "alerting is off while this spreads" is information an operator needs
   * rather than a reason to withhold the row.
   */
  muted: boolean;
  status: FleetPatternStatus;
  isSpiking?: boolean;
  spikeAssessedAt?: number;
  regressedAt?: number;
  fixConfidenceState?: FleetFixConfidenceState;
}

/**
 * One agent's DECLARED configuration, for `shared_declared_attribute`.
 *
 * From the immutable `agent_versions.configSnapshot` — deliberately NOT from
 * `runs.modelsSeen`. `modelsSeen` is optional and add-only, so an agent with no
 * recorded models has not been observed to use no model, it has not been
 * observed at all; building a shared-attribute claim on it manufactures a
 * confident finding out of a schema gap. A configSnapshot is what the version
 * DECLARED, is immutable, and `readConfigSnapshot` reports absent and malformed
 * facets explicitly rather than defaulting them.
 */
export interface FleetAgentDeclarationInput {
  agentId: string;
  agentVersionId: string;
  configSnapshot: unknown;
}

// ===========================================================================
// PART B — LOCAL COVERAGE, beyond what FleetHealthScan carries
// ===========================================================================

/**
 * Coverage facts the engine needs that the contract's `FleetHealthScan` does
 * not carry, because they bear on the BASELINE COMPARISON — an enrichment this
 * engine adds — rather than on the correlation itself.
 */
export interface FleetBaselineCoverage {
  baselineWindowStartAt: number;
  baselineWindowEndAt: number;
  baselineOccurrencesExamined: number;
  baselineScanTruncated: boolean;
  /**
   * Runs recorded during the BASELINE period, from `daily_rollups`.
   *
   * A deliberate division of labour: rollups are cron-written, so they are
   * STALE for the recent window and RELIABLE for a days-old baseline — exactly
   * inverted from a live `runs` scan, which is authoritative for the recent
   * window and unaffordable across weeks.
   */
  baselineRunsObserved: number;
  baselineRollupTruncated: boolean;
}

/**
 * MAY A COMPARISON BE ASSERTED? ("this concentration exceeds normal")
 *
 * The gate on PART 4's trap. When false, the baseline sentence is not appended
 * to any correlation at all — the alternative, appending it with a caveat, is
 * how "unprecedented" reaches a human during an outage on the strength of a row
 * cap.
 *
 * TWO POSITIVE CLAUSES, neither redundant:
 *
 *   `baselineWindowEndAt > baselineWindowStartAt`  A baseline PERIOD exists.
 *
 *   `baselineRunsObserved > 0`   The fleet RAN during it. Without this, a
 *                                baseline of zero failures is vacuous: a fleet
 *                                switched off last week did not fail last week,
 *                                and comparing today against an idle period
 *                                manufactures an anomaly out of nothing.
 *
 * `baselineOccurrencesExamined` is deliberately NOT gated: zero failures across
 * a baseline in which the fleet demonstrably ran is the STRONGEST possible
 * baseline, not a missing one.
 */
export function isBaselineEstablished(c: FleetBaselineCoverage): boolean {
  return (
    c.baselineWindowEndAt > c.baselineWindowStartAt &&
    c.baselineRunsObserved > 0 &&
    !c.baselineScanTruncated &&
    !c.baselineRollupTruncated
  );
}

/**
 * MAY BASE RATES BE MEASURED against the unaffected population?
 *
 * POSITIVE CLAUSE: `declarationsRead > 0`. With no declarations read there is
 * no comparison group, and `unaffectedSharing: 0` would then mean "we checked
 * the healthy agents and none share it" — the STRONGEST possible support for a
 * hypothesis — when the truth is that nothing was checked at all. The contract
 * is explicit that `null` and `0` are opposites here; this predicate is what
 * decides which one gets written.
 */
export function isRunPopulationMeasurable(input: {
  declarationsRead: number;
  rosterTruncated: boolean;
  declarationScanTruncated: boolean;
}): boolean {
  return input.declarationsRead > 0 && !input.rosterTruncated && !input.declarationScanTruncated;
}

// ===========================================================================
// PART C — BOUNDS
// ===========================================================================

/** Default burst window. One hour is the resolution at which a provider incident is legible. */
export const FLEET_DEFAULT_BURST_WINDOW_MS = 60 * 60 * 1000;
export const FLEET_MIN_BURST_WINDOW_MS = 60 * 1000;
export const FLEET_MAX_BURST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum DISTINCT agents for a temporal burst. Two is a coincidence often
 * enough to be noise; three is the smallest number worth a human's attention.
 * Distinctness is the point — one agent failing fifty times is a loud agent,
 * not a fleet event, and onset-based counting is what makes the two impossible
 * to confuse.
 */
export const FLEET_MIN_DISTINCT_AGENTS = 3;

/**
 * An agent is `failing` rather than `degrading` at or above this share of its
 * observed runs. A THRESHOLD IS A JUDGEMENT CALL and this one is admitted as
 * such: it splits two roster labels and does nothing else. Both labels count
 * into `agentsFailing`, so the verdict does not depend on where this sits.
 */
export const FLEET_FAILING_SHARE = 0.5;

/** A stored spike assessment older than this is reported as stale, not trusted silently. */
export const FLEET_SPIKE_ASSESSMENT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// ===========================================================================
// PART D — ONSETS AND CONCENTRATION
// ===========================================================================

export interface FleetOnset {
  agentId: string;
  fingerprintHash: string;
  heuristicClass: string;
  occurredAt: number;
  occurrenceId: string;
  runId: string;
}

/**
 * Reduce occurrences to ONSETS: the FIRST time each (agent, fingerprint) pair
 * appears in the scanned rows.
 *
 * WHY ONSETS AND NOT RAW OCCURRENCES. Burst detection asks "how many agents
 * STARTED failing together". Counting raw occurrences answers a different
 * question and answers it wrong in the common case: one high-volume agent
 * emitting 400 occurrences in ten minutes dominates every window and produces a
 * permanent false burst, while twelve agents failing once each — the actual
 * fleet event — is buried under it. De-duplicating to one row per (agent,
 * fingerprint) makes the count a count OF AGENTS, which is the quantity the
 * question is about.
 *
 * CAVEAT, STATED: an "onset" is the first occurrence WITHIN THE SCANNED ROWS,
 * not the first ever. An agent failing for days before the window opens
 * contributes an onset at the window edge. That is what
 * {@link isBaselineEstablished} exists to bound.
 */
export function computeOnsets(occurrences: readonly FleetOccurrenceInput[]): FleetOnset[] {
  const first = new Map<string, FleetOnset>();
  for (const o of occurrences) {
    const key = `${o.agentId} ${o.fingerprintHash}`;
    const prior = first.get(key);
    if (prior === undefined || o.occurredAt < prior.occurredAt) {
      first.set(key, {
        agentId: o.agentId,
        fingerprintHash: o.fingerprintHash,
        heuristicClass: o.heuristicClass,
        occurredAt: o.occurredAt,
        occurrenceId: o.occurrenceId,
        runId: o.runId,
      });
    }
  }
  return [...first.values()].sort(
    (a, b) =>
      a.occurredAt - b.occurredAt ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0) ||
      (a.fingerprintHash < b.fingerprintHash ? -1 : a.fingerprintHash > b.fingerprintHash ? 1 : 0),
  );
}

/** Reduce to one onset per AGENT (earliest failure of any kind), for cross-fingerprint bursts. */
export function computeFleetWideOnsets(onsets: readonly FleetOnset[]): FleetOnset[] {
  const first = new Map<string, FleetOnset>();
  for (const o of onsets) {
    const prior = first.get(o.agentId);
    if (prior === undefined || o.occurredAt < prior.occurredAt) first.set(o.agentId, o);
  }
  return [...first.values()].sort(
    (a, b) => a.occurredAt - b.occurredAt || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
  );
}

export interface FleetConcentration {
  distinctAgentCount: number;
  agentIds: string[];
  startAt: number;
  endAt: number;
  members: FleetOnset[];
}

/**
 * Peak count of DISTINCT agents whose onsets fall inside any window of width
 * `windowMs`. Two-pointer sweep, O(n).
 *
 * The window is INCLUSIVE of both endpoints (`end - start <= windowMs`), so
 * "three agents within one hour" means exactly that at the boundary rather than
 * being silently off by a millisecond. The returned span therefore always fits
 * `windowMs`, which is what makes the emitted `temporal_burst` satisfy the
 * contract's `isCorrelationSelfConsistent` by construction.
 */
export function peakConcentration(onsets: readonly FleetOnset[], windowMs: number): FleetConcentration | null {
  if (onsets.length === 0) return null;
  let best: FleetConcentration | null = null;
  let lo = 0;
  const seen = new Map<string, number>();
  const add = (id: string) => seen.set(id, (seen.get(id) ?? 0) + 1);
  const drop = (id: string) => {
    const n = (seen.get(id) ?? 0) - 1;
    if (n <= 0) seen.delete(id);
    else seen.set(id, n);
  };

  for (let hi = 0; hi < onsets.length; hi++) {
    add(onsets[hi]!.agentId);
    while (onsets[hi]!.occurredAt - onsets[lo]!.occurredAt > windowMs) {
      drop(onsets[lo]!.agentId);
      lo++;
    }
    // Strict `>` keeps the EARLIEST peak on ties — the onset, not a later
    // restatement of it, which is what an operator wants during an incident.
    if (best === null || seen.size > best.distinctAgentCount) {
      const members = onsets.slice(lo, hi + 1);
      best = {
        distinctAgentCount: seen.size,
        agentIds: [...new Set(members.map((m) => m.agentId))].sort(),
        startAt: onsets[lo]!.occurredAt,
        endAt: onsets[hi]!.occurredAt,
        members,
      };
    }
  }
  return best;
}

// ===========================================================================
// PART E — CITATIONS. The invariant from PART 5.
// ===========================================================================

/**
 * Build a citation sample that SPANS DISTINCT AGENTS — one citation per agent,
 * earliest first, up to the contract's bound.
 *
 * THE ONLY WAY A CITATION LIST IS BUILT IN THIS ENGINE, and the reason is the
 * hole the contract left open on purpose: `isCorrelationSelfConsistent` cannot
 * reject a twelve-agent cluster cited entirely by `ag_1`, because `observedBy`
 * is a bounded sample and demanding it cover `agentIds` would reject honest
 * reports. So the guarantee has to be made where the sample is built.
 *
 * Without it, "12 agents recorded fingerprint 9f3c" can ship with twelve
 * citations that are all one agent failing twelve times — a report that passes
 * every contract check, reads as a fleet incident, and describes a single
 * agent's bug. That is the exact confusion a fleet view exists to remove.
 */
export function citationsSpanningAgents(
  onsets: readonly FleetOnset[],
): [FailureOccurrenceCitation, ...FailureOccurrenceCitation[]] {
  const byAgent = new Map<string, FleetOnset>();
  for (const o of onsets) {
    const prior = byAgent.get(o.agentId);
    if (prior === undefined || o.occurredAt < prior.occurredAt) byAgent.set(o.agentId, o);
  }
  const picked = [...byAgent.values()]
    .sort((a, b) => a.occurredAt - b.occurredAt || (a.agentId < b.agentId ? -1 : 1))
    .slice(0, MAX_FLEET_CORRELATION_AGENTS)
    .map(
      (o): FailureOccurrenceCitation => ({
        cites: "failure_occurrence",
        agentId: o.agentId,
        runId: o.runId,
        fingerprintHash: o.fingerprintHash,
        occurredAt: o.occurredAt,
      }),
    );
  return picked as [FailureOccurrenceCitation, ...FailureOccurrenceCitation[]];
}

/**
 * Does this correlation's citation sample actually span distinct agents?
 *
 * The server-side counterpart to the contract's `isCorrelationSelfConsistent`,
 * asserting the property that one deliberately cannot. A correlation claiming N
 * agents must cite `min(N, MAX_FLEET_CORRELATION_AGENTS)` DISTINCT agents —
 * exactly what {@link citationsSpanningAgents} produces.
 *
 * Exported so it can be asserted over every correlation this engine emits,
 * rather than trusted because the builder looks right.
 */
export function citationsSpanDistinctAgents(correlation: ObservedCorrelation): boolean {
  const failureCitations = correlation.observedBy.filter((c) => c.cites === "failure_occurrence");
  if (failureCitations.length === 0) return true; // declared-attribute correlations cite no occurrences
  const distinct = new Set(failureCitations.map((c) => c.agentId));
  const expected = Math.min(correlation.agentCount, MAX_FLEET_CORRELATION_AGENTS);
  return distinct.size === failureCitations.length && distinct.size >= Math.min(expected, 2);
}

// ===========================================================================
// PART F — DECLARED ATTRIBUTES AND BASE RATES
// ===========================================================================

/** A path into an agent version's config snapshot that a cluster might share. */
export type FleetDeclaredPath = "model.models[]" | "tools[].name" | "capabilities[]";

const DECLARED_PATH_LABEL: Record<FleetDeclaredPath, string> = {
  "model.models[]": "model",
  "tools[].name": "tool",
  "capabilities[]": "capability",
};

const DECLARED_PATH_HYPOTHESIS: Record<FleetDeclaredPath, HypothesisedCauseKind> = {
  "model.models[]": "shared_model",
  "tools[].name": "shared_tool",
  "capabilities[]": "shared_capability",
};

/**
 * Declared values at one path, or `null` when the version DECLARED NOTHING
 * there.
 *
 * `null` and the empty set are different and must not collapse: a version that
 * declares no `tools` key does not have zero tools, it has an uncaptured tool
 * list. Treating the second as the first is what
 * `helpers/divergence.ts` calls "fabricating a proof out of missing metadata",
 * and at this altitude it would fabricate a shared attribute — a lead someone
 * acts on — out of two agents that both happen to have incomplete snapshots.
 */
export function declaredValuesAt(config: ReadConfig, path: FleetDeclaredPath): Set<string> | null {
  switch (path) {
    case "model.models[]": {
      const facet = config.models;
      if (facet.status !== "read" || facet.value === undefined) return null;
      return new Set(facet.value.list);
    }
    case "tools[].name": {
      const facet = config.tools;
      if (facet.status !== "read" || facet.value === undefined) return null;
      return new Set(facet.value.map((t) => t.name));
    }
    case "capabilities[]": {
      const facet = config.capabilities;
      if (facet.status !== "read" || facet.value === undefined) return null;
      return new Set(facet.value);
    }
  }
}

export const FLEET_DECLARED_PATHS: FleetDeclaredPath[] = ["model.models[]", "tools[].name", "capabilities[]"];

/**
 * Measure how many AFFECTED and how many UNAFFECTED agents declare a value.
 *
 * The `null` discipline is the whole point, and it is the contract's rule
 * restated in code: `unaffectedSharing: 0` says "we checked the healthy agents
 * and none of them declare this" — the strongest support a hypothesis can have.
 * `unaffectedSharing: null` says nothing was checked. They are opposites, and
 * writing `0` for the second is how "all twelve failing agents use m-4" ships
 * next to 198 healthy agents that also use m-4.
 */
export function measureShare(input: {
  affectedAgentIds: readonly string[];
  unaffectedAgentIds: readonly string[];
  declarations: Map<string, ReadConfig>;
  path: FleetDeclaredPath;
  value: string;
  populationMeasurable: boolean;
}): FleetShareMeasurement {
  const affectedSharing = input.affectedAgentIds.filter((id) => {
    const config = input.declarations.get(id);
    if (config === undefined) return false;
    return declaredValuesAt(config, input.path)?.has(input.value) === true;
  }).length;

  if (!input.populationMeasurable) {
    return {
      affectedSharing,
      affectedTotal: input.affectedAgentIds.length,
      unaffectedSharing: null,
      unaffectedTotal: null,
      measurementTruncated: true,
    };
  }

  // Only agents whose declaration was actually READ count as examined. An
  // agent we could not read is not an agent that does not share the attribute.
  const examined = input.unaffectedAgentIds.filter((id) => {
    const config = input.declarations.get(id);
    return config !== undefined && declaredValuesAt(config, input.path) !== null;
  });
  const unaffectedSharing = examined.filter(
    (id) => declaredValuesAt(input.declarations.get(id)!, input.path)?.has(input.value) === true,
  ).length;

  return {
    affectedSharing,
    affectedTotal: input.affectedAgentIds.length,
    unaffectedSharing,
    unaffectedTotal: examined.length,
    measurementTruncated: false,
  };
}

// ===========================================================================
// PART G — THE FOLD
// ===========================================================================

export interface FleetCorrelationInput {
  analyzedAt: number;
  agents: readonly FleetAgentInput[];
  occurrences: readonly FleetOccurrenceInput[];
  baselineOccurrences: readonly FleetOccurrenceInput[];
  runs: readonly FleetRunInput[];
  patterns: readonly FleetPatternInput[];
  declarations: readonly FleetAgentDeclarationInput[];
  baseline: FleetBaselineCoverage;
  /** Echoed EXACTLY into the scan. Already clamped by the caller. */
  burstWindowMs: number;
  minDistinctAgents: number;
  since: number;
  until: number;
  rosterTruncated: boolean;
  occurrenceScanTruncated: boolean;
  declarationScanTruncated: boolean;
  scanRowCeiling?: number;
  /** Roster LISTING size. The correlation pass is unaffected by it. */
  rosterListingLimit: number;
}

export interface FleetEngineResult {
  report: FleetHealthReport;
  /** Diagnostics beyond the contract's report shape. */
  baselineEstablished: boolean;
  baseRatesMeasurable: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function deriveAgentHealthState(input: {
  runsObserved: number;
  runsFailed: number;
  failureOccurrences: number;
  spikingCount: number;
  regressedCount: number;
}): AgentHealthState {
  // ORDER IS THE SAFETY PROPERTY. `unobserved` is tested FIRST so a zero-run
  // agent can never fall through to `healthy`; `healthy` is LAST and is
  // therefore unreachable without a positive run observation AND zero recorded
  // failures. Written the other way round — `if (nothingBad) return "healthy"`
  // first — the function is vacuously green on every empty input.
  if (input.runsObserved <= 0) return "unobserved";
  if (input.spikingCount > 0 || input.regressedCount > 0) return "failing";
  const failures = Math.max(input.runsFailed, input.failureOccurrences > 0 ? 1 : 0);
  if (failures <= 0) return "healthy";
  return input.runsFailed / input.runsObserved >= FLEET_FAILING_SHARE ? "failing" : "degrading";
}

/**
 * The whole analysis. Pure: same rows in, same report out, every time.
 */
export function foldFleetCorrelation(input: FleetCorrelationInput): FleetEngineResult {
  const correlations: ObservedCorrelation[] = [];
  const hypotheses: HypothesisedCause[] = [];
  const unanswered: UnansweredFleetQuestion[] = [];

  const windowMs = input.burstWindowMs;
  const minAgents = Math.max(input.minDistinctAgents, 2);
  const baselineEstablished = isBaselineEstablished(input.baseline);

  const patternByHash = new Map(input.patterns.map((p) => [p.fingerprintHash, p]));
  const onsets = computeOnsets(input.occurrences);
  const baselineOnsets = computeOnsets(input.baselineOccurrences);

  const declarations = new Map<string, ReadConfig>();
  const declarationVersionId = new Map<string, string>();
  for (const d of input.declarations) {
    declarations.set(d.agentId, readConfigSnapshot(d.configSnapshot));
    declarationVersionId.set(d.agentId, d.agentVersionId);
  }
  const baseRatesMeasurable = isRunPopulationMeasurable({
    declarationsRead: declarations.size,
    rosterTruncated: input.rosterTruncated,
    declarationScanTruncated: input.declarationScanTruncated,
  });

  // -- Coverage questions, emitted BEFORE any finding. --------------------
  if (input.rosterTruncated) {
    unanswered.push({
      certainty: "unanswered",
      kind: "roster_incomplete",
      questionKey: "roster_incomplete",
      undecidedQuestion: "whether agents beyond the roster ceiling also failed inside this window",
      unknownBecause: `the roster ceiling (${input.agents.length}) was reached, so the correlation pass did not see the whole fleet and every cluster's breadth is a FLOOR`,
      remedy: "re-run with a higher limit",
    });
  }
  if (input.occurrenceScanTruncated) {
    unanswered.push({
      certainty: "unanswered",
      kind: "occurrence_history_truncated",
      questionKey: "occurrence_history_truncated",
      undecidedQuestion: `whether further correlations exist earlier in the window ${iso(input.since)}..${iso(input.until)}`,
      unknownBecause:
        "the occurrence scan is read most-recent-first and hit its ceiling before reaching the start of the window; what WAS read is exact, but clusters may be cut and their breadth is a floor",
      remedy: "narrow the window",
    });
  }
  // NOTE: `baseline_not_established` is NOT emitted here either. Like
  // `base_rate_unmeasurable` below, it is a gap ONLY when a burst was actually
  // found — with no burst there is no comparison being blocked. Emitting it
  // unconditionally would make `healthy` unreachable for every org without a
  // full baseline period of `daily_rollups`: every NEW org, and every org
  // inside its first week. See immediately after the burst section.
  // NOTE: `base_rate_unmeasurable` is NOT emitted here. It is emitted only if a
  // cluster is actually found — see after the cluster loop. Emitting it
  // unconditionally makes `healthy` UNREACHABLE, because `unanswered` is
  // completeness-bearing: a quiet fleet with nothing wrong has no hypotheses to
  // rank, so "we could not measure base rates" is not a gap in that answer, it
  // is irrelevant to it. The contract calls this out explicitly on
  // `FleetHealthScan.baseRatesMeasured` ("folding it in would make `healthy`
  // unreachable on exactly the quiet days it should be reachable"), and an
  // earlier version of this engine did exactly that and graded a demonstrably
  // clean fleet `indeterminate`.

  // -- Correlation 1: one fingerprint, several agents. ---------------------
  const byFingerprint = new Map<string, FleetOnset[]>();
  for (const o of onsets) {
    const list = byFingerprint.get(o.fingerprintHash);
    if (list === undefined) byFingerprint.set(o.fingerprintHash, [o]);
    else list.push(o);
  }
  const baselineByFingerprint = new Map<string, FleetOnset[]>();
  for (const o of baselineOnsets) {
    const list = baselineByFingerprint.get(o.fingerprintHash);
    if (list === undefined) baselineByFingerprint.set(o.fingerprintHash, [o]);
    else list.push(o);
  }

  /** Clusters that a hypothesis may rest on: (correlationKey, agentIds). */
  const clusters: Array<{ correlationKey: string; agentIds: string[]; label: string }> = [];

  for (const [hash, group] of [...byFingerprint.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const agentIds = [...new Set(group.map((g) => g.agentId))].sort();
    if (agentIds.length < 2) continue;

    const p = patternByHash.get(hash);
    const label = p?.label ?? hash;
    const correlationKey = `shared_fingerprint:${hash}`;
    const times = group.map((g) => g.occurredAt);

    // Muted and resolved-and-recurred are SURFACED here rather than used to
    // filter. A pattern whose alerting is off while it spreads to N agents is
    // something an operator must be told, not a reason to hide the row.
    const notes: string[] = [];
    if (p?.muted === true) notes.push("alerting for this pattern is MUTED");
    if (p?.status === "resolved" || p?.fixConfidenceState === "regressed") {
      notes.push(`this pattern is marked ${p.status}${p.fixConfidenceState ? ` with fix confidence ${p.fixConfidenceState}` : ""} and recurred`);
    }

    correlations.push({
      certainty: "observed",
      kind: "shared_failure_fingerprint",
      correlationKey,
      observedFact: `${agentIds.length} agents recorded failures matching fingerprint ${hash} (${label}) between ${iso(
        Math.min(...times),
      )} and ${iso(Math.max(...times))}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`,
      agentIds: agentIds.slice(0, MAX_FLEET_CORRELATION_AGENTS),
      agentCount: agentIds.length,
      firstObservedAt: Math.min(...times),
      lastObservedAt: Math.max(...times),
      observedBy: citationsSpanningAgents(group),
    });
    clusters.push({ correlationKey, agentIds, label: `fingerprint ${hash}` });
  }

  // -- Correlation 2: temporal burst, ACROSS fingerprints. -----------------
  //    The realistic provider incident: one upstream fault surfaces as a
  //    timeout in one agent, a schema error in another and a rate-limit in a
  //    third, so they never share a fingerprint and every fingerprint-scoped
  //    view sees three unrelated problems.
  const fleetOnsets = computeFleetWideOnsets(onsets);
  const peak = peakConcentration(fleetOnsets, windowMs);
  if (peak !== null && peak.distinctAgentCount >= minAgents) {
    const distinctHashes = new Set(peak.members.map((m) => m.fingerprintHash));
    const distinctClasses = new Set(peak.members.map((m) => m.heuristicClass));
    const correlationKey = `burst:${peak.startAt}`;

    let baselineSentence = "";
    if (baselineEstablished) {
      const basePeak = peakConcentration(computeFleetWideOnsets(baselineOnsets), windowMs);
      const baseCount = basePeak?.distinctAgentCount ?? 0;
      baselineSentence = `; over the baseline period ${iso(input.baseline.baselineWindowStartAt)}..${iso(
        input.baseline.baselineWindowEndAt,
      )} the peak over any equal window was ${baseCount}`;
    }
    // When the baseline is NOT established the sentence is simply absent —
    // never present with a caveat. See PART 4.

    correlations.push({
      certainty: "observed",
      kind: "temporal_burst",
      correlationKey,
      observedFact: `${peak.distinctAgentCount} agents recorded their first in-window failure between ${iso(
        peak.startAt,
      )} and ${iso(peak.endAt)} (${Math.round((peak.endAt - peak.startAt) / 1000)}s), across ${
        distinctHashes.size
      } distinct fingerprints and ${distinctClasses.size} failure class(es)${baselineSentence}`,
      agentIds: peak.agentIds.slice(0, MAX_FLEET_CORRELATION_AGENTS),
      agentCount: peak.distinctAgentCount,
      firstObservedAt: peak.startAt,
      lastObservedAt: peak.endAt,
      observedBy: citationsSpanningAgents(peak.members),
    });
    clusters.push({ correlationKey, agentIds: peak.agentIds, label: "this burst" });

    // A burst EXISTS, so "is it abnormal?" is now a real question — and one
    // this scan could not answer. Emitted here, not in the coverage block, so
    // that a fleet with no burst is not held indeterminate for want of a
    // comparison nobody asked for.
    if (!baselineEstablished) {
      const absent = input.baseline.baselineWindowEndAt <= input.baseline.baselineWindowStartAt;
      const idle = input.baseline.baselineRunsObserved <= 0;
      unanswered.push({
        certainty: "unanswered",
        kind: "engine_limit",
        questionKey: "baseline_not_established",
        undecidedQuestion: "whether the burst observed here is abnormal for this fleet",
        unknownBecause: absent
          ? "no baseline period precedes the requested window, so there is nothing to compare against"
          : idle
            ? "the fleet recorded no runs during the baseline period; a period in which nothing ran cannot establish what normal looks like"
            : "the baseline scan hit its ceiling, so the peak concentration it would have measured is only a lower bound",
        remedy: "widen the baseline period, or narrow the analysis window",
      });
    }
  }

  // -- Correlation 3 + hypotheses: what the cluster's agents DECLARE. ------
  const observedAgentIds = [...new Set(input.runs.map((r) => r.agentId))].sort();
  const seenHypothesisKeys = new Set<string>();
  const seenQuestionKeys = new Set(unanswered.map((u) => u.questionKey));

  for (const cluster of clusters) {
    const unaffected = observedAgentIds.filter((id) => !cluster.agentIds.includes(id));
    let namedSomething = false;

    for (const path of FLEET_DECLARED_PATHS) {
      // Intersect the DECLARED values across the cluster. An agent whose
      // version declared nothing at this path makes the shared claim
      // undecidable — it is not evidence of a different value.
      let shared: Set<string> | null = null;
      const undeclaredBy: string[] = [];
      for (const agentId of cluster.agentIds) {
        const config = declarations.get(agentId);
        const values = config === undefined ? null : declaredValuesAt(config, path);
        if (values === null) {
          undeclaredBy.push(agentId);
          continue;
        }
        const prior: Set<string> | null = shared;
        shared = prior === null ? new Set(values) : new Set([...prior].filter((v: string) => values.has(v)));
      }

      if (undeclaredBy.length > 0) {
        const questionKey = `attribute_undeclared:${cluster.correlationKey}:${path}`;
        if (!seenQuestionKeys.has(questionKey)) {
          seenQuestionKeys.add(questionKey);
          unanswered.push({
            certainty: "unanswered",
            kind: "attribute_undeclared",
            questionKey,
            undecidedQuestion: `whether the agents in ${cluster.label} share a ${DECLARED_PATH_LABEL[path]}`,
            unknownBecause: `${undeclaredBy.length} of the ${cluster.agentIds.length} agents declare nothing at \`${path}\`; an absent declaration is not evidence of a different value`,
            remedy: `publish these agents' next version with a structured configSnapshot declaring \`${path}\``,
            agentIds: undeclaredBy.slice(0, MAX_FLEET_CORRELATION_AGENTS),
          });
        }
        continue;
      }
      if (shared === null || shared.size === 0) continue;

      for (const value of [...shared].sort()) {
        namedSomething = true;
        const attrKey = `shared_attribute:${cluster.correlationKey}:${path}:${value}`;

        // The SHARED DECLARATION is a FACT — identical values at the same path
        // in each version's immutable snapshot — and is filed as an observation.
        correlations.push({
          certainty: "observed",
          kind: "shared_declared_attribute",
          correlationKey: attrKey,
          observedFact: `all ${cluster.agentIds.length} agents in ${cluster.label} declare ${DECLARED_PATH_LABEL[path]} \`${value}\` at \`${path}\``,
          agentIds: cluster.agentIds.slice(0, MAX_FLEET_CORRELATION_AGENTS),
          agentCount: cluster.agentIds.length,
          firstObservedAt: input.since,
          lastObservedAt: input.until,
          observedBy: cluster.agentIds.slice(0, MAX_FLEET_CORRELATION_AGENTS).map((agentId) => ({
            cites: "declared_attribute" as const,
            agentId,
            agentVersionId: declarationVersionId.get(agentId) ?? "",
            declaredConfigPath: path,
            declaredValue: value,
          })) as [
            { cites: "declared_attribute"; agentId: string; agentVersionId: string; declaredConfigPath: string; declaredValue: string },
            ...Array<{ cites: "declared_attribute"; agentId: string; agentVersionId: string; declaredConfigPath: string; declaredValue: string }>,
          ],
        });

        // That the attribute EXPLAINS the failures is NOT a fact. Separate
        // type, separate array, denominator required, resting on both the
        // cluster and the shared-declaration observation.
        const hypothesisKey = `hypothesis:${DECLARED_PATH_HYPOTHESIS[path]}:${cluster.correlationKey}:${value}`;
        if (seenHypothesisKeys.has(hypothesisKey)) continue;
        seenHypothesisKeys.add(hypothesisKey);

        const sharedBy = measureShare({
          affectedAgentIds: cluster.agentIds,
          unaffectedAgentIds: unaffected,
          declarations,
          path,
          value,
          populationMeasurable: baseRatesMeasurable,
        });

        hypotheses.push({
          certainty: "hypothesis",
          kind: DECLARED_PATH_HYPOTHESIS[path],
          hypothesisKey,
          // A VALUE, NOT A SENTENCE. The contract composes the operator-facing
          // line with `hypothesisQuestion()`, always interrogative, so this
          // engine has no field in which to write "model `m-4` is failing".
          // That is the last route by which suspicion becomes fact and it is
          // closed by the absence of the field, not by our restraint.
          sharedValue: value,
          restingOn: [cluster.correlationKey, attrKey],
          notEstablishedBecause: `the recorded data shows co-occurrence only. Nothing stored can distinguish \`${value}\` from any other attribute these agents also share, and a flight recorder holds no counterfactual in which they did not share it${
            discriminationOf(sharedBy) === "base_rate_unmeasured"
              ? ". The unaffected population was not measured, so this is unrankable rather than weakly supported"
              : ""
          }`,
          sharedBy,
          wouldBeTestedBy: `move one of ${cluster.agentIds.slice(0, 2).join(", ")} off ${DECLARED_PATH_LABEL[path]} \`${value}\` and watch whether its failures stop, leaving the others as controls`,
          attributeConfigPath: path,
        });
      }
    }

    // "Twelve agents are failing together and we can name nothing they share"
    // is a real, useful, honest thing to say, and the contract makes it
    // first-class precisely so a type cannot pressure this engine into naming
    // something. Emitted only when nothing was named AND the cluster is a
    // temporal one — a shared fingerprint already names what they share.
    if (!namedSomething && cluster.correlationKey.startsWith("burst:")) {
      const hypothesisKey = `hypothesis:unattributed:${cluster.correlationKey}`;
      if (!seenHypothesisKeys.has(hypothesisKey)) {
        seenHypothesisKeys.add(hypothesisKey);
        hypotheses.push({
          certainty: "hypothesis",
          kind: "unattributed",
          hypothesisKey,
          // No `sharedValue`: this hypothesis is about no attribute at all.
          // "Twelve agents are failing together and we can name nothing they
          // share" is a real, useful, honest thing to say, and the contract
          // makes it first-class precisely so a type cannot pressure this
          // engine into naming something.
          restingOn: [cluster.correlationKey],
          notEstablishedBecause:
            "no shared declared attribute was found, so there is no candidate mechanism to state — and the absence of one is not evidence that the agents are unrelated, only that this product records nothing that connects them",
          sharedBy: {
            affectedSharing: 0,
            affectedTotal: cluster.agentIds.length,
            unaffectedSharing: null,
            unaffectedTotal: null,
            measurementTruncated: true,
          },
          wouldBeTestedBy: `check what changed outside these agents' configuration around ${iso(
            Math.min(...cluster.agentIds.map(() => input.since)),
          )} — a dependency release, an upstream provider status page, an infrastructure change`,
        });
      }
    }
  }

  // An unmeasured base rate is a gap ONLY when there is something to rank. With
  // at least one cluster, every hypothesis over it is unrankable and that IS a
  // question the scan could not answer — an attribute shared by every affected
  // agent explains nothing if the healthy agents share it too, and during an
  // incident that unmeasured lead is what gets the wrong thing rolled back.
  if (!baseRatesMeasurable && clusters.length > 0) {
    unanswered.push({
      certainty: "unanswered",
      kind: "base_rate_unmeasurable",
      questionKey: "base_rate_unmeasurable",
      undecidedQuestion: "how common any shared attribute is among the agents that are FINE",
      unknownBecause:
        "the declared configuration of the unaffected population could not be read in full, so every hypothesis over this fleet is unrankable",
      remedy: "re-run with a higher limit so the whole roster's declarations are read",
    });
  }

  // -- Roster. ------------------------------------------------------------
  const runsByAgent = new Map<string, { total: number; failed: number }>();
  for (const r of input.runs) {
    const cur = runsByAgent.get(r.agentId) ?? { total: 0, failed: 0 };
    cur.total += 1;
    if (r.status === "failed" || r.status === "timed_out") cur.failed += 1;
    runsByAgent.set(r.agentId, cur);
  }
  const occByAgent = new Map<string, FleetOccurrenceInput[]>();
  for (const o of input.occurrences) {
    const list = occByAgent.get(o.agentId);
    if (list === undefined) occByAgent.set(o.agentId, [o]);
    else list.push(o);
  }

  const staleSpikes = input.patterns.filter(
    (p) =>
      p.isSpiking === true &&
      p.spikeAssessedAt !== undefined &&
      input.analyzedAt - p.spikeAssessedAt > FLEET_SPIKE_ASSESSMENT_STALE_AFTER_MS,
  );
  if (staleSpikes.length > 0) {
    unanswered.push({
      certainty: "unanswered",
      kind: "engine_limit",
      questionKey: "spike_assessment_stale",
      undecidedQuestion: `whether ${staleSpikes.length} fingerprint(s) marked spiking are still spiking`,
      unknownBecause: `their stored spike assessment is older than ${Math.round(
        FLEET_SPIKE_ASSESSMENT_STALE_AFTER_MS / 3600000,
      )}h; the assessment cron may be behind, which is likeliest during the load spike this analysis is for`,
      remedy: "check the spike-assessment cron",
    });
  }

  const allEntries: AgentHealthEntry[] = input.agents.map((agent) => {
    const counts = runsByAgent.get(agent.agentId) ?? { total: 0, failed: 0 };
    const occ = occByAgent.get(agent.agentId) ?? [];
    const hashes = [...new Set(occ.map((o) => o.fingerprintHash))].sort();
    const spiking = hashes.filter((h) => patternByHash.get(h)?.isSpiking === true);
    const regressed = hashes.filter((h) => {
      const p = patternByHash.get(h);
      return p !== undefined && (p.fixConfidenceState === "regressed" || p.regressedAt !== undefined);
    });
    const times = occ.map((o) => o.occurredAt);

    return {
      agentId: agent.agentId,
      agentName: agent.name,
      state: deriveAgentHealthState({
        runsObserved: counts.total,
        runsFailed: counts.failed,
        failureOccurrences: occ.length,
        spikingCount: spiking.length,
        regressedCount: regressed.length,
      }),
      runsObserved: counts.total,
      runsFailed: counts.failed,
      distinctFingerprints: hashes.length,
      ...(times.length > 0 ? { firstFailureAt: Math.min(...times), lastFailureAt: Math.max(...times) } : {}),
      // The occurrence and run scans are org-wide, so an agent's observation is
      // exactly as truncated as they are. There is no per-agent scan that could
      // be complete while the org-wide one is not.
      observationTruncated: input.occurrenceScanTruncated,
    };
  });

  // ORDER: most concerning first. `unobserved` outranks `healthy` — "we do not
  // know" is more urgent to show an operator than "we looked and it was fine",
  // and putting it below fine is how a fleet that has silently stopped being
  // invoked renders as a green wall.
  const STATE_RANK: Record<AgentHealthState, number> = { failing: 3, degrading: 2, unobserved: 1, healthy: 0 };
  allEntries.sort(
    (a, b) =>
      STATE_RANK[b.state] - STATE_RANK[a.state] ||
      b.runsFailed * a.runsObserved - a.runsFailed * b.runsObserved ||
      b.distinctFingerprints - a.distinctFingerprints ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
  );

  // `agentsFailing` is counted over ALL assessed agents, never over the
  // truncated listing — deriving it from the listing would undercount exactly
  // when the roster is too big to show, which is when it matters.
  const agentsFailing = allEntries.filter((e) => e.state === "failing" || e.state === "degrading").length;
  const roster = allEntries.slice(0, input.rosterListingLimit);
  const listingTruncated = allEntries.length > input.rosterListingLimit;

  if (listingTruncated) {
    unanswered.push({
      certainty: "unanswered",
      kind: "roster_incomplete",
      questionKey: "roster_listing_truncated",
      undecidedQuestion: `the state of the ${allEntries.length - roster.length} agents beyond the listing limit`,
      unknownBecause: `the roster listing limit (${input.rosterListingLimit}) is smaller than the ${allEntries.length} agents assessed. The CORRELATION pass still ran over all of them, so no cluster was split — but this listing is partial`,
      remedy: "re-run with a higher limit",
    });
  }

  // -- Scan. --------------------------------------------------------------
  //
  // `whole_roster` requires that the correlation pass actually saw every
  // agent's failures: the roster read to completion AND the occurrence scan
  // read to completion. Either ceiling means clusters may have been cut, so the
  // basis is `page_local` and the scan can never be complete.
  const correlationBasis: CorrelationBasis =
    !input.rosterTruncated && !input.occurrenceScanTruncated ? "whole_roster" : "page_local";

  const scan: FleetHealthScan = {
    // ECHOED EXACTLY for ignored-parameter detection. A deployment that dropped
    // `burstWindowMs` would correlate over its own far wider default and
    // present a day of ordinary background failure as a four-minute incident,
    // so the SDK checks this echo and refuses on a mismatch.
    since: input.since,
    until: input.until,
    burstWindowMs: input.burstWindowMs,
    correlationBasis,
    agentsInRoster: input.agents.length,
    agentsAssessed: allEntries.length,
    agentsUnassessable: 0,
    agentsSkippedForBudget: 0,
    occurrencesScanned: input.occurrences.length,
    scanTruncated: input.occurrenceScanTruncated || input.rosterTruncated,
    ...(input.scanRowCeiling !== undefined ? { scanRowCeiling: input.scanRowCeiling } : {}),
    baseRatesMeasured: baseRatesMeasurable,
    ...(listingTruncated ? { nextCursor: String(input.rosterListingLimit) } : {}),
  };

  const ranked = rankFleetCorrelations(correlations);
  const report: FleetHealthReport = {
    analyzedAt: input.analyzedAt,
    verdict: computeFleetHealthVerdict({
      correlationCount: ranked.length,
      agentsFailing,
      // THE SINGLE DEFINITION. Not hand-rolled: `complete: true` is the one
      // input that turns "nothing observed" into `healthy`, so a locally
      // invented version of it is a locally invented all-clear.
      complete: isFleetHealthScanComplete(scan) && unanswered.length === 0,
    }),
    roster,
    correlations: ranked,
    hypotheses: hypotheses.sort((a, b) => (a.hypothesisKey < b.hypothesisKey ? -1 : 1)),
    unanswered: unanswered.sort((a, b) => (a.questionKey < b.questionKey ? -1 : 1)),
    agentsFailing,
    scan,
  };

  return { report, baselineEstablished, baseRatesMeasurable };
}
