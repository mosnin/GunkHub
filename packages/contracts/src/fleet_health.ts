// ---------------------------------------------------------------------------
// FLEET HEALTH — "what is wrong across everything, and what is it that is
// actually wrong?"
//
// Every other view in this product is one-run or one-agent. That is the wrong
// altitude for an org running hundreds of agents: the thing worth catching is
// not "agent 41 failed", it is "twelve agents started failing inside four
// minutes". This is the type contract for that altitude — a roster of agents
// with a health state, cross-agent correlation over recorded failure
// fingerprints, and temporal burst detection.
//
// DERIVED, NEVER SOURCE OF TRUTH — the same posture as replay, diff and
// divergence (CLAUDE.md Event Log Rule 2), and the same posture as
// `FailurePattern` one level down (ADR-005: observability-grade rollups, never
// a substitute for the event log). A `FleetHealthReport` is computed at query
// time from `runs`, `failure_pattern_occurrences`, and immutable
// `configSnapshot`s. Recompute it; do not cache it as a fact.
//
// NAMING, BECAUSE THERE IS A COLLISION AND IT IS WORTH BEING EXPLICIT ABOUT:
// `divergence.ts` already uses "fleet" to mean ONE AGENT across MANY RUNS
// (`FleetDivergenceReport`). This file uses "fleet health" to mean MANY AGENTS
// at one moment. Different subject, different question, deliberately
// non-overlapping type names. `afr compat --agent` answers the first; `afr
// fleet` answers the second.
//
// ---------------------------------------------------------------------------
// THE ONE INVARIANT THIS FILE EXISTS TO ENFORCE
// ---------------------------------------------------------------------------
//
// CORRELATION IS NOT CAUSATION, and at this altitude the distinction is not
// pedantry — it is the whole safety property. There are two utterly different
// claims a fleet engine can make:
//
//   OBSERVED     "agents ag_1..ag_12 each recorded a failure matching
//                 fingerprint 9f3c between 14:02:11 and 14:06:40, and all
//                 twelve versions declare model `m-4`." — statements about the
//                 past, each checkable against stored rows, with no model, no
//                 sampling and no judgement in them.
//
//   HYPOTHESIS   "model `m-4` is degrading." — a claim about a MECHANISM.
//                 Causation needs a counterfactual, and a flight recorder
//                 stores only what happened. This claim can never be checked
//                 from recorded data, no matter how much of it there is.
//
// THE STAKES ARE HIGHER HERE THAN FOR DIVERGENCE, not lower. A divergence
// report gates a deploy: a wrong answer blocks or permits a change, and
// somebody reads it with time to think. A fleet report is read DURING AN
// INCIDENT by someone deciding what to roll back, at speed, under pressure,
// looking for permission to act. A confidently-worded wrong hypothesis is
// therefore the most dangerous artifact this product can produce — it is the
// one that gets a healthy model rolled back while the actual cause (a shared
// tool that changed shape an hour earlier) keeps burning.
//
// So, exactly as in `divergence.ts`, the separation is STRUCTURAL rather than
// advisory. There is no `confidence: number` and no `severity` enum, because
// an advisory field is a field every careless consumer forgets to read:
//
//   1. THREE TYPES, MUTUALLY UNASSIGNABLE. {@link ObservedCorrelation},
//      {@link HypothesisedCause} and {@link UnansweredFleetQuestion} share no
//      assignable shape. Each carries a distinct `certainty` literal AND
//      required fields the others lack (`observedBy` / `restingOn` +
//      `sharedBy` / `unknownBecause`), so assignment fails in BOTH directions
//      on a missing required property, not merely on the discriminant.
//      Deleting the discriminant would not open the hole.
//
//   2. NO SHARED TEXT FIELD, AND THE HYPOTHESIS HAS NO PROSE HEADLINE AT ALL.
//      An observation says `observedFact`; an unanswered question says
//      `undecidedQuestion`. There is deliberately no `message`, `summary`,
//      `title` or `description` common to any two of them, so the incident
//      dashboard one-liner that renders "everything we found" cannot be
//      written by accident.
//
//      A HYPOTHESIS HAS NO HEADLINE FIELD WHATSOEVER. It carries `kind` and a
//      `sharedValue`, and its sentence is COMPOSED by
//      {@link hypothesisQuestion} rather than transmitted. This closes the last
//      route by which suspicion becomes fact: every other barrier in this file
//      stops a CONSUMER promoting a guess by forgetting something, and a free
//      prose field let the ENGINE do it by writing "model m-4 is failing" —
//      a compiling, contract-valid hypothesis that reads as a finding no
//      matter what chrome surrounds it. During an incident the sentence IS the
//      thing someone acts on, so the mood of that sentence has to be a
//      property of the TYPE, not a convention the writer is trusted to keep.
//
//      A REGEX ON PROSE WOULD NOT HAVE WORKED, and it is worth saying why
//      rather than leaving it as an unexplored option: a mood check strict
//      enough to reject "m-4 is degrading" also rejects valid English, and one
//      loose enough to accept valid English is satisfied by inserting the word
//      "may" — leaving "m-4 may be the cause", which is read as an accusation
//      anyway. Composition removes the writer from the sentence instead of
//      grading their grammar.
//
//   3. NO EXPORTED UNION. There is no `FleetFinding = Observed | Hypothesis`
//      here, on purpose. A union is the flattening this design refuses to make
//      convenient. This is also why {@link FleetHealthReport} keeps three
//      arrays instead of one.
//
//   4. AN OBSERVATION MUST CARRY ITS EVIDENCE. `observedBy` is a NON-EMPTY
//      tuple type, so an "observed" correlation with nothing behind it does
//      not compile — the same rule as `ProvenDivergence.provenBy`.
//
//   5. A HYPOTHESIS MUST CARRY ITS DENOMINATOR, AND MUST REST ON AN
//      OBSERVATION. This one is NEW at this altitude, and it is the rule this
//      file exists for. The specific way a fleet view manufactures a
//      confidently-worded wrong answer is a MISSING BASE RATE: "all twelve
//      failing agents use model m-4" is worthless — indeed actively
//      misleading — if all two hundred agents in the org use model m-4. So
//      {@link HypothesisedCause.sharedBy} is REQUIRED and its
//      unaffected-population fields are `number | null` where `null` means NOT
//      MEASURED and can never be read as zero. A producer cannot state a
//      shared-attribute hypothesis without stating what it measured across the
//      agents that are FINE. And `restingOn` is a non-empty tuple of
//      `correlationKey`s, so a hypothesis can never float free of the facts it
//      is supposed to explain.
//
//   6. A HYPOTHESIS CAN NEVER MOVE THE VERDICT. {@link
//      computeFleetHealthVerdict} does not take a hypothesis count. It is not
//      an oversight and it is not a default that can be flipped: there is no
//      parameter to pass. A guess cannot page anyone, cannot fail a monitoring
//      loop, and cannot turn `healthy` into anything else. This is a
//      deliberate difference from `afr compat`, which does offer `--fail-on
//      any` for speculative divergences — a speculative divergence is read at
//      leisure before a deploy; a fleet hypothesis is read at 3am by someone
//      about to roll something back.
//
// A negative test asserting all of the above (via `@ts-expect-error`, which
// fails the build if the conflation ever BECOMES legal) lives at
// `tests/unit/fleet_type_conflation.test.ts`.
//
// See also `packages/sdk/src/reader.ts` (`getFleetHealth`) for the wire-level
// counterpart: the same segregation re-checked at runtime, because a server is
// not typechecked by us.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

/**
 * One agent's health, as far as a BOUNDED observation window could tell.
 *
 * `unobserved` is its own state and is not a synonym for `healthy`. An agent
 * with no runs in the window has not passed anything — it has not been tested.
 * Collapsing the two is the roster-level version of the same false-clean this
 * whole feature is built against, and it is the state an agent lands in
 * precisely when it has silently stopped being invoked at all (a scheduler
 * died, a queue backed up), which is itself an incident worth seeing.
 */
export type AgentHealthState =
  /** Recorded failures in the window, at or above the failing threshold. */
  | "failing"
  /** Recorded failures in the window, below the failing threshold but non-zero. */
  | "degrading"
  /** Runs observed in the window, none of them failed. A real, earned pass — for this window only. */
  | "healthy"
  /** No runs observed in the window. NOT a pass: nothing was tested. */
  | "unobserved";

/** One row of the roster. Counts are over the scan window only — see {@link FleetHealthScan}. */
export interface AgentHealthEntry {
  agentId: string;
  /** Display name, when the engine carried it. `agentId` is the identity. */
  agentName?: string;
  state: AgentHealthState;
  /** Runs started inside the window that this scan actually looked at. */
  runsObserved: number;
  /** Of those, how many ended `failed`. */
  runsFailed: number;
  /** Distinct `FailurePattern` fingerprints recorded for this agent inside the window. */
  distinctFingerprints: number;
  /** Earliest failure inside the window, when there was one. */
  firstFailureAt?: number;
  /** Latest failure inside the window, when there was one. */
  lastFailureAt?: number;
  /**
   * True when this agent's own run scan hit a per-agent ceiling. Its counts
   * are FLOORS, not totals, and `state: 'healthy'` on a truncated row is not
   * an earned pass — see {@link isFleetHealthScanComplete}, which is what
   * stops the report as a whole reading clean.
   */
  observationTruncated: boolean;
}

// ---------------------------------------------------------------------------
// OBSERVED correlation — the facts
// ---------------------------------------------------------------------------

/**
 * A kind of cross-agent correlation that is DECIDABLE from stored rows alone.
 *
 * CLOSED SET, and it must stay closed. Every member has a stated observation
 * obligation: a mechanical check over recorded occurrences or immutable
 * `configSnapshot`s that admits no judgement call. If the check you want to add
 * needs a "probably" or a model, it is not a member of this union — whatever it
 * produces is a {@link HypothesisedCause}.
 */
export type ObservedCorrelationKind =
  /**
   * N distinct agents each recorded a failure carrying the SAME
   * `fingerprintHash`. OBSERVATION: N `failure_pattern_occurrences` rows with
   * one hash and N distinct `agentId`s. Says nothing about why.
   */
  | "shared_failure_fingerprint"
  /**
   * N distinct agents each began failing inside one window, WITHOUT needing to
   * share a fingerprint. OBSERVATION: N agents whose first in-window failure
   * timestamps all fall inside `burstWindowMs`. This is the one that catches a
   * shared dependency changing shape, because a provider degrading rarely
   * produces one tidy fingerprint — it produces twelve different ones at once.
   */
  | "temporal_burst"
  /**
   * The agents in an existing cluster all DECLARE the same thing — a model, a
   * tool, a capability. OBSERVATION: identical values at the same path in each
   * agent version's `AgentConfigSnapshot` (`agent_config.ts`), for versions
   * that actually declared it.
   *
   * NOTE WHAT THIS IS AND IS NOT. That they share the attribute is a fact and
   * belongs here. That the attribute EXPLAINS the failures is not, and belongs
   * in {@link HypothesisedCause} — with a base rate attached, because a shared
   * attribute that every healthy agent also shares explains nothing.
   */
  | "shared_declared_attribute";

/** One recorded failure, cited by the row that stores it. */
export interface FailureOccurrenceCitation {
  cites: "failure_occurrence";
  agentId: string;
  runId: string;
  /** The `FailurePattern` fingerprint recorded for that run. */
  fingerprintHash: string;
  /** When the failure was recorded. Used to check a burst claim against its own evidence. */
  occurredAt: number;
}

/** One agent version's declaration, cited by path into its immutable snapshot. */
export interface DeclaredAttributeCitation {
  cites: "declared_attribute";
  agentId: string;
  agentVersionId: string;
  /** Path into that version's {@link AgentConfigSnapshot}, e.g. `"model.models[]"`. */
  declaredConfigPath: string;
  /** The declared value, rendered for display, e.g. the model id. */
  declaredValue: string;
}

/**
 * The evidence half of an observation.
 *
 * THIS union is fine and the certainty-band unions are not, and the difference
 * is worth stating: every member here is a FACT, differing only in which table
 * stores it. A consumer that flattens these two flattens two kinds of record,
 * not two kinds of claim.
 */
export type FleetObservationEvidence = FailureOccurrenceCitation | DeclaredAttributeCitation;

/**
 * Something that DEMONSTRABLY HAPPENED across several agents.
 *
 * Safe to page on. Safe to phrase in the past tense. Never assignable to or
 * from {@link HypothesisedCause} — see this file's header.
 *
 * It is deliberately not called a "cause", an "incident", or a "root cause".
 * It is a co-occurrence, and the name is the first line of defence against
 * being read as more than one.
 */
export interface ObservedCorrelation {
  /** Discriminant. One of the structural barriers; the others are `observedBy` and `agentIds`. */
  certainty: "observed";
  kind: ObservedCorrelationKind;
  /**
   * Stable identity of the CLUSTER, not of this sighting — e.g.
   * `"shared_fingerprint:9f3c"` or `"burst:1721908800000"`. Must contain no
   * run id and no per-page state, so the same cluster seen twice carries the
   * same key. Engine-assigned; treat as opaque. It is also what a
   * {@link HypothesisedCause} points at via `restingOn`.
   */
  correlationKey: string;
  /**
   * One line, phrased about WHAT WAS RECORDED, in the past tense, WITH ITS
   * COUNTS: "12 agents recorded failures matching fingerprint 9f3c between
   * 14:02:11 and 14:06:40."
   *
   * Never "model m-4 is failing". Deliberately NOT named
   * `message`/`summary`/`title` — see this file's header, point 2.
   */
  observedFact: string;
  /**
   * The agents in this cluster.
   *
   * MUST CARRY `min(agentCount, MAX_FLEET_CORRELATION_AGENTS)` ENTRIES, and
   * that requirement is what makes `agentCount` checkable at all. Because the
   * list is bounded at a KNOWN ceiling, a list SHORTER than the ceiling is a
   * COMPLETE list — the bound did not bind — so `agentCount` must equal
   * `agentIds.length`. A producer that lists three agents and claims five
   * hundred is contradicting itself, and {@link correlationIncoherences} says
   * so. Only once the list is AT the ceiling can `agentCount` legitimately
   * exceed it, and only then is the claim unverifiable.
   */
  agentIds: string[];
  /**
   * How many distinct agents are in the cluster. May exceed `agentIds.length`
   * ONLY when that list is at {@link MAX_FLEET_CORRELATION_AGENTS} — see
   * above.
   *
   * THIS NUMBER DECIDES WHAT AN OPERATOR READS FIRST (see
   * {@link rankFleetCorrelations}), so an unvalidated one decides it at 3am on
   * behalf of whoever produced it. It is therefore checked against the listed
   * agents and against the cited evidence rather than trusted.
   */
  agentCount: number;
  /** Earliest cited observation, epoch ms. */
  firstObservedAt: number;
  /** Latest cited observation, epoch ms. For a `temporal_burst` this minus `firstObservedAt` must fit `burstWindowMs`. */
  lastObservedAt: number;
  /**
   * THE EVIDENCE. NON-EMPTY BY TYPE: an `ObservedCorrelation` with an empty
   * `observedBy` does not compile. Bounded — it is a sample sufficient to
   * check the claim and start reading, not the full occurrence set.
   *
   * Every citation must be checkable: `FailureOccurrenceCitation.occurredAt`
   * must fall inside `[firstObservedAt, lastObservedAt]`, and the SDK refuses
   * a report where it does not. A correlation whose own evidence contradicts
   * its own window is a correlation the engine did not actually make.
   */
  observedBy: [FleetObservationEvidence, ...FleetObservationEvidence[]];
}

// ---------------------------------------------------------------------------
// HYPOTHESISED cause — the guesses, quarantined
// ---------------------------------------------------------------------------

/**
 * A kind of explanation a fleet engine can PROPOSE. None of these is derivable
 * from recorded data; each is a reading of an observation.
 *
 * Closed in type, for the same reason as {@link ObservedCorrelationKind}: a
 * monitoring script may key on these values.
 */
export type HypothesisedCauseKind =
  /** The cluster's agents all declare the same model. The archetypal provider-degradation guess. */
  | "shared_model"
  /** They all declare the same tool. A shared tool changing shape is the other classic. */
  | "shared_tool"
  /** They all declare the same named capability — retrieval source, MCP server, integration. */
  | "shared_capability"
  /** They were all published from the same version lineage, so a config change may be common to them. */
  | "shared_version_lineage"
  /** They started failing at the same time and NOTHING shared could be named. "Something changed at 14:02." */
  | "coincident_in_time"
  /** The engine sees a cluster and can name nothing shared at all. Deliberately sayable — see below. */
  | "unattributed";

/**
 * THE DENOMINATOR. How many affected agents share the proposed attribute, and
 * — critically — how many UNAFFECTED agents do too.
 *
 * This type exists because of one specific failure: an incident view that says
 * "all 12 failing agents use model m-4" while 198 of the org's 200 agents use
 * model m-4. The statement is true, the implication is false, and at 3am the
 * implication is what gets acted on. Requiring the unaffected population to be
 * carried alongside makes the misleading version unwriteable.
 *
 * `null` MEANS NOT MEASURED AND NEVER MEANS ZERO. A missing base rate is a
 * different fact from a base rate of zero, and it is the more common one:
 * measuring it means reading the config snapshot of every healthy agent, which
 * a bounded scan will often not have done. `unaffectedSharing: 0` says "we
 * checked the healthy agents and none of them share this" — the strongest
 * possible support for a hypothesis. `unaffectedSharing: null` says nothing at
 * all, and {@link discriminationOf} reports that rather than guessing.
 */
export interface FleetShareMeasurement {
  /** Affected agents that share the attribute. */
  affectedSharing: number;
  /** Affected agents in the cluster the measurement was taken over. */
  affectedTotal: number;
  /** Unaffected agents that ALSO share it, or `null` for NOT MEASURED. Never conflate `null` with `0`. */
  unaffectedSharing: number | null;
  /** Unaffected agents examined, or `null` for NOT MEASURED. */
  unaffectedTotal: number | null;
  /**
   * True when the base-rate measurement stopped on a ceiling. The numbers are
   * floors, so the comparison is not sound and {@link discriminationOf}
   * reports `base_rate_unmeasured` regardless of how favourable they look.
   */
  measurementTruncated: boolean;
}

/**
 * What a base-rate measurement actually supports. THREE-VALUED ON PURPOSE.
 *
 * A boolean here would force "we did not measure" to be reported as one of
 * "yes" or "no", and both are lies in the incident-shaped direction.
 */
export type ShareDiscrimination =
  /** The attribute is markedly more common among the affected than the unaffected. Worth reading first. Still not proof. */
  | "discriminating"
  /** The unaffected share it about as much. This explains nothing, and saying so out loud is the point. */
  | "not_discriminating"
  /** No comparison group was measured (or the measurement truncated). Unrankable — NOT weak support, NO support. */
  | "base_rate_unmeasured";

/**
 * How much better than chance the attribute separates sick from healthy.
 * Ranking only, and expressed as a rate DIFFERENCE rather than a ratio so a
 * tiny unaffected population cannot produce an enormous multiplier.
 *
 * A THRESHOLD IS A JUDGEMENT CALL, and this one is admitted as such: it orders
 * hypotheses on a screen and does nothing else. It cannot promote a hypothesis
 * to an observation, it is not an input to any verdict, and no exit code
 * depends on it.
 */
export const FLEET_DISCRIMINATION_MARGIN = 0.2;

/**
 * Does this measurement actually distinguish the failing agents from the
 * healthy ones?
 *
 * THE SINGLE DEFINITION, so the CLI, the web UI and the MCP surface cannot each
 * invent a slightly different one — the same reason
 * `isDivergenceCoverageComplete` lives in contracts.
 *
 * Reports `base_rate_unmeasured` whenever the comparison cannot be made
 * soundly: either population absent, a truncated measurement, an empty
 * comparison group, or an empty affected group. Each of those is a case where
 * the arithmetic would still produce a number, and the number would be
 * meaningless.
 */
export function discriminationOf(measurement: FleetShareMeasurement): ShareDiscrimination {
  // FAILS CLOSED ON ANYTHING IT CANNOT DO ARITHMETIC WITH — see
  // {@link baseRateUsability}. This function is exported, so it is reachable
  // by consumers who built a measurement themselves and never passed the SDK
  // gate; it cannot assume the boundary ran.
  if (baseRateUsability(measurement) !== "usable") return "base_rate_unmeasured";
  const affectedRate = measurement.affectedSharing / measurement.affectedTotal;
  const unaffectedRate = (measurement.unaffectedSharing as number) / (measurement.unaffectedTotal as number);
  return affectedRate - unaffectedRate >= FLEET_DISCRIMINATION_MARGIN ? "discriminating" : "not_discriminating";
}

/**
 * What a base-rate measurement is fit for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A `=== null` CHECK, WHICH IS WHAT IT USED TO BE
 * ---------------------------------------------------------------------------
 *
 * `null` was the case this design was built for, so `null` was airtight. Its
 * NEIGHBOURS were not, because the guard asked "did they SAY they measured
 * it?" when the property the verdict needs is "CAN I DO ARITHMETIC WITH THIS?".
 * Those are the same question only for inputs somebody thought about. For the
 * rest, the comparison falls through to whichever branch it happens to land
 * in:
 *
 *   fields ABSENT (not null)      -> `undefined === null` is false, so it
 *                                    proceeded, divided, and returned
 *                                    `not_discriminating` — A MEASURED VERDICT
 *                                    FROM NO MEASUREMENT.
 *   `'0'` / `'188'` (strings)     -> `'188' <= 0` is false and `'0'/'188'` is
 *                                    0 by JS coercion, so it returned
 *                                    `discriminating`: A GUESS PROMOTED TO
 *                                    "READ THIS FIRST" FROM UNVALIDATED WIRE
 *                                    DATA.
 *   `measurementTruncated` DROPPED -> `undefined` is falsy, so the truncation
 *                                    guard FAILED OPEN and floors were
 *                                    compared as though they were totals ->
 *                                    `discriminating`.
 *   `NaN`                          -> `not_discriminating`, and this one is
 *                                    the warning rather than the reassurance:
 *                                    it was safe ONLY by the coincidence that
 *                                    every IEEE comparison with NaN is false.
 *                                    Correct-by-coincidence is wrong-and-lucky
 *                                    with better outcomes so far.
 *
 * So the question is asked directly. A count must be a non-negative integer —
 * which excludes `NaN`, both infinities, strings, `null`, `undefined` and
 * negatives in one predicate rather than four — and the truncation flag must
 * be an actual boolean, so a dropped flag fails CLOSED.
 */
export type BaseRateUsability =
  /** Every field is a real count and the comparison group is non-empty. Arithmetic is safe. */
  | "usable"
  /** Honestly declared as not measured (`null`), truncated, or an empty comparison group. Legal, and says nothing. */
  | "not_measured"
  /**
   * MALFORMED: absent, wrong-typed, non-finite, negative, or internally
   * impossible. Distinct from `not_measured` because it is not a statement a
   * producer can legitimately make — the SDK REFUSES a report carrying one
   * rather than quietly reading it as "unmeasured".
   */
  | "unusable";

/** A count: a non-negative integer. Rejects NaN, infinities, strings, null, undefined and negatives at once. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A real point in time or duration. Rejects NaN and infinities, which arithmetic silently swallows. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A number a comparison can be trusted with: real, and not `NaN`. Infinities
 * ARE allowed, because an infinite bound is a deliberate way of saying "this
 * rule does not apply" — the only thing a comparison cannot survive is `NaN`,
 * against which every comparison is false and therefore every check is skipped.
 */
function isComparableNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Can this measurement be compared, and if not, is that because nobody
 * measured or because what arrived is not a measurement?
 *
 * THE SINGLE DEFINITION, so the CLI, the web UI, the MCP surface and the SDK
 * gate cannot each invent a slightly different notion of "usable".
 */
export function baseRateUsability(measurement: FleetShareMeasurement): BaseRateUsability {
  // Boundary function: tolerate anything, refuse clearly, never throw.
  if (measurement === null || typeof measurement !== "object" || Array.isArray(measurement)) return "unusable";
  const m = measurement as unknown as Record<string, unknown>;

  // The flag first, and it must be a real boolean. A DROPPED flag is the
  // failure that mattered most: `undefined` is falsy, so the old guard let
  // truncated floors through as totals — the one direction that promotes a
  // hypothesis.
  if (typeof m["measurementTruncated"] !== "boolean") return "unusable";
  if (!isCount(m["affectedSharing"]) || !isCount(m["affectedTotal"])) return "unusable";

  const sharing = m["unaffectedSharing"];
  const total = m["unaffectedTotal"];
  // `null` is a legitimate statement ("we did not measure"); anything else
  // that is not a count is not a statement at all.
  if (!(sharing === null || isCount(sharing))) return "unusable";
  if (!(total === null || isCount(total))) return "unusable";

  // More sharers than the population they were drawn from is arithmetic
  // nonsense, not a measurement — the same "numbers must agree with each
  // other" rule as `fleetReportIncoherences`, one level down.
  if (measurement.affectedSharing > measurement.affectedTotal) return "unusable";
  if (sharing !== null && total !== null && sharing > total) return "unusable";

  if (measurement.measurementTruncated) return "not_measured";
  if (sharing === null || total === null) return "not_measured";
  // No comparison group, or no cluster: the rates are undefined, not zero.
  if (total <= 0 || measurement.affectedTotal <= 0) return "not_measured";
  return "usable";
}

/**
 * A PROPOSED reading of an observation. NOT a finding, NOT evidence, and NEVER
 * a gate signal — {@link computeFleetHealthVerdict} does not accept a
 * hypothesis count at all (header point 6).
 *
 * The reason hypotheses exist in the contract rather than being left out
 * entirely is that an operator forms one within seconds of seeing a cluster,
 * and they will form it from whatever is on the screen. Making the system state
 * its hypothesis EXPLICITLY, with its denominator and its refutation attached,
 * is safer than leaving the human to construct an undocumented one from a table
 * of agent names. `unattributed` is a first-class kind for exactly this reason:
 * "twelve agents are failing together and we can name nothing they share" is a
 * real, useful, honest thing to say, and a type that could not say it would
 * pressure an engine into naming something.
 *
 * Never assignable to or from {@link ObservedCorrelation}.
 */
export interface HypothesisedCause {
  /** Discriminant. The other structural barriers are `restingOn`, `sharedBy` and `wouldBeTestedBy`. */
  certainty: "hypothesis";
  kind: HypothesisedCauseKind;
  /** Stable identity of the hypothesis, as `correlationKey` is for observations. Opaque. */
  hypothesisKey: string;
  /**
   * The VALUE the affected agents share — the model id, the tool name — when
   * `kind` is one of the shared-attribute kinds. Absent for
   * `coincident_in_time` and `unattributed`, which are about no attribute.
   *
   * THIS IS A VALUE, NOT A SENTENCE, AND THAT IS THE POINT — see
   * {@link hypothesisQuestion}.
   */
  sharedValue?: string;
  /**
   * REQUIRED, NON-EMPTY: the `correlationKey`s of the {@link
   * ObservedCorrelation}s this rests on.
   *
   * A hypothesis that names no observation is a free-floating assertion, and a
   * free-floating assertion on an incident dashboard is indistinguishable from
   * a finding. The tuple type makes the empty case a compile error; the SDK
   * additionally refuses a report whose hypothesis names a `correlationKey`
   * that is not present in the same report (see `orphanHypotheses`).
   */
  restingOn: [string, ...string[]];
  /**
   * REQUIRED: why the recorded data cannot establish this. Forcing the engine
   * to write the limit down at the point of making the claim is what keeps
   * hypotheses honest — the same discipline as
   * `SpeculativeDivergence.speculativeBecause`.
   */
  notEstablishedBecause: string;
  /**
   * REQUIRED: the base rate. See {@link FleetShareMeasurement} — this is the
   * field that makes "all twelve failing agents use m-4" unwriteable without
   * also saying what the healthy agents use.
   */
  sharedBy: FleetShareMeasurement;
  /**
   * REQUIRED: what would CONFIRM OR REFUTE this, phrased as something the
   * operator can do — "roll one of ag_3, ag_7 onto model `m-3` and watch
   * whether its failures stop".
   *
   * This is the difference between a product that hands someone a suspicion
   * and one that hands them an experiment. A hypothesis with no test attached
   * is acted on directly, which during an incident means rolling back the first
   * plausible thing.
   */
  wouldBeTestedBy: string;
  /**
   * The attribute path this hypothesis is about, when it has one — e.g.
   * `"model.models[]"`. Absent for `coincident_in_time` and `unattributed`,
   * which are hypotheses about no attribute at all.
   */
  attributeConfigPath?: string;
}

/**
 * The noun each shared-attribute hypothesis is about. Derived from `kind`, so
 * it cannot drift with whatever an engine felt like writing.
 */
const HYPOTHESIS_NOUN: Record<HypothesisedCauseKind, string | null> = {
  shared_model: "model",
  shared_tool: "tool",
  shared_capability: "capability",
  shared_version_lineage: "version lineage",
  coincident_in_time: null,
  unattributed: null,
};

/**
 * THE SENTENCE A HUMAN READS, COMPOSED RATHER THAN TRANSMITTED.
 *
 * This function exists because it is the only way to make the MOOD of a
 * hypothesis a property of the type. Every other barrier in this file stops a
 * CONSUMER from promoting a guess to a fact by forgetting to check something.
 * A free-text headline let the PRODUCER do it, in one keystroke, with nothing
 * downstream able to tell: "model `m-4` is failing" is a perfectly valid,
 * compiling `HypothesisedCause`, and during an incident that sentence is the
 * thing someone acts on. No amount of surrounding chrome — a HYPOTHESIS label,
 * a separate column, a different colour — survives contact with a declarative
 * sentence about a named dependency at 3am.
 *
 * So the engine no longer writes the sentence. It supplies `kind` (a closed
 * enum) and, where there is one, the `sharedValue`; the interrogative frame
 * comes from here. An engine that wants to accuse a model cannot: there is no
 * field to do it in.
 *
 * ALWAYS INTERROGATIVE, ALWAYS. Every branch below returns a question, and
 * that is the invariant a test should pin. A question cannot be misread as a
 * finding, and it also happens to be the honest shape of the claim — a
 * hypothesis is a thing you go and check, not a thing you have.
 *
 * (`notEstablishedBecause` and `wouldBeTestedBy` remain free prose, and that is
 * safe: one is a statement of a LIMIT and the other of an ACTION. Neither can
 * be misread as a finding about what broke, and both are genuinely
 * engine-specific. The dangerous field was only ever the headline.)
 *
 * @param hypothesis - the hypothesis to render.
 * @returns a question, phrased for an operator, naming the shared value when
 *   there is one. Never a claim, in any branch.
 */
export function hypothesisQuestion(hypothesis: HypothesisedCause): string {
  if (hypothesis.kind === "coincident_in_time") {
    return "These agents began failing together — could something that changed at that moment explain it?";
  }
  if (hypothesis.kind === "unattributed") {
    return "These agents failed together and nothing shared could be named — what do they have in common?";
  }
  const noun = HYPOTHESIS_NOUN[hypothesis.kind] ?? "attribute";
  return hypothesis.sharedValue === undefined
    ? `Could the shared ${noun} explain this?`
    : `Could the shared ${noun} \`${hypothesis.sharedValue}\` explain this?`;
}

/**
 * Which kinds are ABOUT a shared attribute, and therefore should name the
 * value the affected agents share.
 *
 * Exported because the SDK reader enforces it on the wire: a `shared_model`
 * hypothesis with no `sharedValue` composes to "Could the shared model explain
 * this?", which is a question about nothing in particular and wastes the one
 * line an operator will read.
 */
export const SHARED_ATTRIBUTE_HYPOTHESIS_KINDS: readonly HypothesisedCauseKind[] = [
  "shared_model",
  "shared_tool",
  "shared_capability",
  "shared_version_lineage",
];

// ---------------------------------------------------------------------------
// UNANSWERED — the third band, for the same reason divergence has one
//
// A real engine over a real roster routinely lands on a question it cannot
// answer: an agent whose versions declare no model, so whether it shares the
// cluster's model is UNKNOWN; a roster page that ran out of budget, so whether
// the burst is 12 agents or 40 is unread. With only OBSERVED and HYPOTHESIS
// available, both places to put that are lies — file it as observed and a gap
// becomes a fact; file it as a hypothesis and "we could not check" is rendered
// as "we checked and here is a theory". Dropping it is worse than either.
//
// So it gets its own type, and it is COMPLETENESS-BEARING: any unanswered
// question makes the analysis incomplete, which forces `indeterminate`, which
// in `afr fleet` is exit 11. "I could not read the roster" can never exit 0.
// ---------------------------------------------------------------------------

/** Why a specific fleet question could not be decided. Facts about the INPUTS, never about any agent. */
export type UnansweredFleetQuestionKind =
  /** The roster could not be enumerated in full, so the cluster's real breadth is unread. */
  | "roster_incomplete"
  /** An agent version declares nothing at the relevant path, so shared-attribute membership is unknown. */
  | "attribute_undeclared"
  /** Failure occurrences for some agents were truncated, so their in-window history is partial. */
  | "occurrence_history_truncated"
  /** The base rate across unaffected agents could not be measured, so no hypothesis over this cluster can be ranked. */
  | "base_rate_unmeasurable"
  /** The engine's own ceiling was reached mid-question. */
  | "engine_limit";

/**
 * A question this fleet scan COULD NOT ANSWER.
 *
 * Not a correlation and not the absence of one. Never assignable to or from
 * {@link ObservedCorrelation} or {@link HypothesisedCause}: distinct
 * `certainty` literal, plus a required `unknownBecause` neither of the others
 * has, plus a text field named for a question rather than a fact or a guess.
 */
export interface UnansweredFleetQuestion {
  /** Discriminant. The structural barrier is `unknownBecause`. */
  certainty: "unanswered";
  kind: UnansweredFleetQuestionKind;
  /** Stable identity of the question, as on the other two types. */
  questionKey: string;
  /**
   * What could not be decided, PHRASED AS THE OPEN QUESTION: "whether the 40
   * agents after the roster ceiling also failed inside this window."
   */
  undecidedQuestion: string;
  /**
   * REQUIRED: what specifically stopped the scan. "The roster ceiling (200)
   * was reached." An unexplained "unknown" is indistinguishable from laziness
   * and gets ignored.
   */
  unknownBecause: string;
  /**
   * What would make this answerable, as an action: "re-run with --limit 500",
   * or "publish ag_9's next version with a structured configSnapshot".
   *
   * The difference between a product that says "I cannot tell" and one that
   * says "I cannot tell YET, and here is what to do". A verdict that reads as
   * a shrug is one people learn to click past — which during an incident means
   * clicking past the only honest thing on the screen.
   */
  remedy?: string;
  /** Agents the unanswered question bears on, when it is agent-specific. Bounded. */
  agentIds?: string[];
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * WHERE THE CORRELATION PASS RAN. The single most load-bearing field on the
 * scan, and the one that makes paging safe.
 *
 * A per-agent analysis composes across pages: reasons are run-independent,
 * pages partition the runs, counts add. THAT IS NOT TRUE OF A CROSS-AGENT
 * CORRELATION. A burst of twelve agents split four-and-eight across two roster
 * pages is a cluster of four and a cluster of eight to a page-local engine —
 * both possibly under any threshold, so the incident is invisible on every
 * page and invisible in any merge of them. The failure is silent and it is
 * total: nothing in the output says a cluster was cut in half.
 *
 * So the basis is declared rather than assumed, and a `page_local` basis can
 * never produce a complete fleet answer (see {@link isFleetHealthScanComplete}).
 * An engine that must page its roster should correlate over the whole roster
 * first and paginate the ROSTER LISTING only.
 */
export type CorrelationBasis =
  /** The correlation pass saw every agent in the roster. Only this basis can be complete. */
  | "whole_roster"
  /** The correlation pass saw only the agents on this page. Breadth is a floor and clusters may be split. */
  | "page_local";

/**
 * What the fleet scan actually covered.
 *
 * Same posture as `DivergenceScanWindow` and `FailurePattern`'s pattern scan
 * (ADR-005): the server STATES its incompleteness in a field rather than
 * refusing, and the GATE decides that an incomplete scan is not a pass.
 *
 * AND NOTE WHEN THIS MATTERS. Data volume spikes during an incident — that is
 * what an incident is — so truncation is LIKELIEST during exactly the event
 * this scan exists to explain. A completeness rule that is merely decorative
 * on a quiet day is the whole product on a bad one.
 */
export interface FleetHealthScan {
  /** Lower bound on the observation window, epoch ms. Echoed for ignored-parameter detection. */
  since: number;
  /** Upper bound, epoch ms. Echoed. */
  until: number;
  /**
   * The width, in ms, inside which failures on different agents count as
   * coincident.
   *
   * ECHOED BACK DELIBERATELY AND LOAD-BEARING. A deployment that predates this
   * parameter drops it and correlates over its own default — typically far
   * wider — so a "burst" it reports may be a day of unrelated failures
   * presented as four minutes of one incident. That is a confidently-worded
   * wrong answer produced at the worst possible moment, so the SDK checks the
   * echo exactly and refuses on a mismatch.
   */
  burstWindowMs: number;
  /** Where the correlation pass ran. See {@link CorrelationBasis}. */
  correlationBasis: CorrelationBasis;
  /** Agents in the org's roster the scan knew about. */
  agentsInRoster: number;
  /**
   * Agents actually assessed. THE POSITIVE CLAUSE's subject — see
   * {@link isFleetHealthScanComplete}.
   */
  agentsAssessed: number;
  /** Agents visited but not assessable (no retained runs, unreadable rows). NOT counted as healthy. */
  agentsUnassessable: number;
  /** Agents inside the roster the execution's budget never reached. Unexamined is not passed. */
  agentsSkippedForBudget: number;
  /** Failure occurrences read. Informational. */
  occurrencesScanned: number;
  /** True when the scan stopped on the server's row ceiling: every count above is a floor. */
  scanTruncated: boolean;
  /** The ceiling that was hit, when the server reported it. */
  scanRowCeiling?: number;
  /**
   * Whether base rates across UNAFFECTED agents were measured at all.
   *
   * Deliberately NOT part of {@link isFleetHealthScanComplete}: an unmeasured
   * base rate does not make the OBSERVATIONS incomplete, and a fleet with
   * nothing wrong has no hypotheses to rank, so folding it in would make
   * `healthy` unreachable on exactly the quiet days it should be reachable.
   * What it does do is make every hypothesis in the report unrankable, which
   * {@link discriminationOf} already reports per hypothesis and the CLI prints.
   */
  baseRatesMeasured: boolean;
  /**
   * PAGES REMAIN in the roster listing.
   *
   * ITS PRESENCE ALONE MAKES THE SCAN INCOMPLETE. A first page is not a fleet
   * answer, and unlike the divergence scan there is deliberately NO merge
   * helper here — see {@link CorrelationBasis} for why merging pages of a
   * cross-agent correlation produces a report about a fleet that does not
   * exist.
   */
  nextCursor?: string;
}

/**
 * A fleet scan is complete only when it ACTUALLY ASSESSED AN AGENT, correlated
 * over the WHOLE ROSTER, and then truncated nothing, skipped nothing, failed
 * on nothing, and has no pages left.
 *
 * SIX CONDITIONS, and the FIRST TWO are the ones to protect.
 *
 * Four of them are negative ("nothing went wrong"), and a predicate made only
 * of negative clauses is VACUOUSLY TRUE ON AN EMPTY SCAN:
 *
 *   { agentsInRoster: 0, agentsAssessed: 0, agentsUnassessable: 0,
 *     agentsSkippedForBudget: 0, scanTruncated: false }
 *
 * Nothing truncated, nothing skipped, nothing failed — and nothing examined.
 * Fed to {@link computeFleetHealthVerdict} with no correlations that returns
 * `healthy`: AN ORG-WIDE ALL-CLEAR DERIVED FROM ZERO AGENTS. This is the same
 * category error that has now produced defects in several layers of this
 * codebase — THE PREDICATE ANSWERS "WAS ANYTHING TRUNCATED?" WHEN THE PROPERTY
 * IT MUST EXPRESS IS "DO WE HAVE ENOUGH EVIDENCE TO CONCLUDE?". They coincide
 * on every input where something was examined and diverge precisely on the
 * empty one, which is where a false green does the most damage. `agentsAssessed
 * > 0` is the positive clause that fixes it.
 *
 * `correlationBasis === 'whole_roster'` is the second, and it is specific to
 * this altitude: a page-local correlation pass can report zero clusters over a
 * fleet that is visibly on fire, because it never held enough of the fleet in
 * one place to see one. That is not an incomplete answer, it is a wrong one,
 * and it must never read as clean.
 *
 * See `isFleetScanComplete` and `isDivergenceCoverageComplete` in
 * `divergence.ts` for the same rule at the two lower altitudes.
 */
export function isFleetHealthScanComplete(scan: FleetHealthScan): boolean {
  return (
    scan.agentsAssessed > 0 &&
    scan.correlationBasis === "whole_roster" &&
    !scan.scanTruncated &&
    scan.agentsUnassessable === 0 &&
    scan.agentsSkippedForBudget === 0 &&
    scan.nextCursor === undefined
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * The operator's actual question — "is something wrong across everything?" —
 * answered in one word.
 *
 * `indeterminate` is not a hedge; it is the answer that stops a false clean. A
 * scan that could not enumerate the roster has not established that the roster
 * is fine.
 */
export type FleetHealthVerdict =
  /** At least one OBSERVED cross-agent correlation. Something is wrong across several agents. */
  | "correlated_failures"
  /** Agents are failing, but nothing was observed to connect them. Real problems, no fleet event. */
  | "isolated_failures"
  /** Complete scan, agents assessed, nothing failing and nothing correlated. */
  | "healthy"
  /** Nothing correlated, but the scan did not finish — "nothing found" is not evidence here. */
  | "indeterminate";

/**
 * The inputs {@link computeFleetHealthVerdict} needs.
 *
 * NOTE WHAT IS NOT HERE: there is no hypothesis count, and there is no place to
 * put one. A hypothesis cannot move this verdict, cannot page anyone, and
 * cannot fail a monitoring loop. See this file's header, point 6.
 */
export interface FleetHealthVerdictInput {
  /** OBSERVED correlations only. */
  correlationCount: number;
  /** Agents in state `failing` or `degrading`. */
  agentsFailing: number;
  /**
   * Whether the analysis was complete.
   *
   * **Get this from {@link isFleetHealthAnalysisComplete}. Do not hand-roll
   * it.** `complete: true` is the single input that can turn "nothing
   * observed" into `healthy`, so a locally-invented version of it is a
   * locally-invented all-clear — and the failure is silent, because a
   * hand-rolled predicate built from "nothing went wrong" clauses looks
   * correct and is vacuously true on an empty scan.
   */
  complete: boolean;
}

/**
 * THE verdict rule, in one place, for every surface that states one.
 *
 * Precedence, and why:
 *
 *  1. `correlationCount > 0` -> `correlated_failures`, EVEN IF THE SCAN WAS
 *     INCOMPLETE. An observation does not become less true because something
 *     else went unread, and demoting it to `indeterminate` on a partial scan
 *     would let a truncated scan hide the fleet event — which is precisely
 *     backwards, since truncation is likeliest DURING the incident. This is
 *     the rule that makes "10 wins over 11" correct in the CLI.
 *  2. `!complete` -> `indeterminate`. Nothing observed and we did not finish
 *     looking: the false-clean case, and it gets its own word.
 *  3. `agentsFailing > 0` -> `isolated_failures`.
 *  4. otherwise -> `healthy`.
 *
 * A consumer must not re-derive this. `afr fleet` computes its exit code from
 * these same inputs rather than from a `verdict` string a server handed it, and
 * `FlightReader` cross-checks a server's `verdict` against this function — a
 * response whose verdict disagrees with its own contents is a response that
 * cannot be trusted at 3am.
 */
export function computeFleetHealthVerdict(input: FleetHealthVerdictInput): FleetHealthVerdict {
  if (input.correlationCount > 0) return "correlated_failures";
  if (!input.complete) return "indeterminate";
  if (input.agentsFailing > 0) return "isolated_failures";
  return "healthy";
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * "What is wrong across everything?" — org-scoped, one moment, every agent.
 *
 * Derived at query time; never stored (CLAUDE.md Event Log Rule 2).
 */
export interface FleetHealthReport {
  /** Server clock at analysis time. The report is a snapshot; recompute rather than cache. */
  analyzedAt: number;
  /** Must equal `fleetHealthReportVerdict(...)` over this report's own contents. Clients verify. */
  verdict: FleetHealthVerdict;
  /**
   * Every agent the scan assessed, with its state. Bounded by the roster
   * ceiling — see {@link FleetHealthScan.nextCursor}.
   */
  roster: AgentHealthEntry[];
  /**
   * OBSERVED cross-agent correlations. THE HEADLINE, ranked by
   * {@link rankFleetCorrelations} — breadth first, recency only as a tiebreak.
   */
  correlations: ObservedCorrelation[];
  /**
   * Proposed readings of those correlations. NOT findings. Never counted into
   * the verdict, never a gate signal, and every one of them names the
   * observations it rests on.
   */
  hypotheses: HypothesisedCause[];
  /**
   * Questions the scan could not answer. Each one makes the analysis
   * incomplete, and therefore makes `verdict: 'healthy'` unreachable.
   */
  unanswered: UnansweredFleetQuestion[];
  /**
   * Agents in state `failing` or `degrading`. Carried rather than derived from
   * `roster` because the roster is BOUNDED and this count is over the whole
   * assessed set — deriving it from a truncated roster would undercount
   * exactly when it matters.
   */
  agentsFailing: number;
  /** REQUIRED. What the scan covered — see {@link FleetHealthScan}. */
  scan: FleetHealthScan;
}

// ---------------------------------------------------------------------------
// READING A REPORT'S COLLECTIONS — THE ONLY WAY, ON PURPOSE
//
// WHAT THIS EXISTS TO PREVENT, stated as the failure rather than the rule,
// because the rule was already known and did not help:
//
//   The tolerance rule ("a required array's ELEMENTS are as untrusted as a
//   required field") was named, written down, and then applied to three of the
//   six functions in this file that needed it — the three whose call sites
//   happened to be open at the time. One of the three that was missed is
//   `fleetReportUnusableFields`, whose entire job is reporting unusable
//   fields, in this same file, in the same sitting.
//
// So the repair is not "remember harder at six call sites". THERE IS NO LONGER
// A RAW READ TO FORGET ABOUT: nothing in this file touches
// `report.correlations`, `report.hypotheses`, `report.roster`,
// `report.unanswered` or `correlation.observedBy` directly, and the
// container-only helper that made the mistake easy (`listOf`, which validated
// the array and trusted its contents — exactly the shape wire JSON produces)
// is deleted rather than left available.
//
// TWO ACCESSORS, because there are genuinely two needs, and collapsing them
// would break one:
//   - CONSUMERS want malformed elements GONE, so they can compute safely.
//   - REPORTERS want malformed elements KEPT AND POSITIONED, so they can say
//     which entry is bad. A reporter that silently dropped one would turn a
//     malformed cluster into an absent one — the failure this whole contract
//     is against.
//
// `tests/unit/fleet_export_tolerance.test.ts` enumerates this module's exports
// FROM ITS OWN SOURCE and fails on any export without a malformed-contents
// probe, so a new helper cannot ship without one. A hand-maintained list
// cannot catch this class, because the thing that goes wrong IS the list being
// incomplete.
// ---------------------------------------------------------------------------

/** An element that is at least shaped like a record. `null`, arrays and primitives are not. */
function isRecordLike(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Elements with their POSITIONS PRESERVED, malformed ones surfaced as `null`.
 * For the two reporting functions, which must name a bad entry rather than
 * quietly shorten the list.
 */
function indexedElements<T>(value: unknown): (T | null)[] {
  if (!Array.isArray(value)) return [];
  return value.map((element) => (isRecordLike(element) ? (element as T) : null));
}

/**
 * Elements that can actually be computed with; malformed ones removed. For
 * every consumer. Dropping is correct HERE and only here: a consumer's
 * alternative is throwing, and a view that crashes tells an operator less than
 * one that shows the sound clusters — while the reporters above still surface
 * exactly what was dropped.
 */
function soundElements<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLike) as T[];
}

/**
 * EVERY ARRAY COLLECTION ON A REPORT, AND WHAT A MALFORMED ELEMENT IN IT MEANS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TABLE AND NOT A DECISION AT EACH CALL SITE
 * ---------------------------------------------------------------------------
 *
 * Providing a consumer accessor and a reporter accessor fixed the throwing,
 * and immediately created a worse bug: `isFleetHealthAnalysisComplete` reached
 * for the CONSUMER direction on `unanswered`. Both accessors were correct. The
 * direction was wrong, and for that one collection wrong means:
 *
 *   unanswered: [null]        ->  complete: TRUE  ->  verdict: HEALTHY
 *   unanswered: [null,null,null] -> complete: TRUE -> verdict: HEALTHY
 *
 * Three questions the engine could not answer produced an ORG-WIDE ALL-CLEAR.
 * Dropping an element from `unanswered` does not lose a row on a screen — IT
 * DELETES THE REASON THE ANALYSIS WAS NOT ALLOWED TO CERTIFY. An unreadable
 * question is the STRONGEST possible ground for `indeterminate`; it had become
 * the weakest, discarded silently and licensing the opposite verdict. Same
 * family as the negative-clause vacuity: a completeness predicate satisfied by
 * an absence it created itself.
 *
 * So the direction is no longer picked at a call site. It is declared ONCE,
 * per collection, HERE — the same reason the container-only helper was deleted
 * rather than documented. A collection that GATES cannot have its malformed
 * elements dropped, whoever is reading it.
 *
 * This table also drives {@link fleetReportUnusableFields}, so the reporter
 * covers four collections of four BY CONSTRUCTION. It previously covered
 * three, and the missing one was precisely the completeness-bearing one —
 * which is why nothing named the defect above.
 */
const REPORT_COLLECTIONS = {
  /** Counted into the verdict. An unreadable claim about the fleet is not "no claim". */
  correlations: "gates",
  /** Completeness-bearing. The reason to withhold a verdict; dropping one deletes the reason. */
  unanswered: "gates",
  /** Cannot move the verdict by design. */
  hypotheses: "displays",
  /** A bounded view collection; `agentsFailing` is carried separately for exactly this reason. */
  roster: "displays",
} as const;

type ReportCollection = keyof typeof REPORT_COLLECTIONS;

/** Every malformed element in the report, with the collection and position that locate it. */
function malformedElements(report: FleetHealthReport): { collection: ReportCollection; index: number }[] {
  const found: { collection: ReportCollection; index: number }[] = [];
  for (const collection of Object.keys(REPORT_COLLECTIONS) as ReportCollection[]) {
    indexedElements((report as unknown as Record<string, unknown>)?.[collection]).forEach((element, index) => {
      if (element === null) found.push({ collection, index });
    });
  }
  return found;
}

/**
 * Is anything unreadable in a collection the VERDICT depends on?
 *
 * The gate's question, asked once. A malformed correlation is an unreadable
 * CLAIM about the fleet — neither an observation nor the absence of one — and
 * the honest response is the same as for an unanswered question: the analysis
 * did not finish.
 */
function hasUnreadableGateInput(report: FleetHealthReport): boolean {
  return malformedElements(report).some(({ collection }) => REPORT_COLLECTIONS[collection] === "gates");
}

/** A report's observed correlations, safe to compute with. */
function correlationsOf(report: FleetHealthReport): ObservedCorrelation[] {
  return soundElements<ObservedCorrelation>(report?.correlations);
}

/** A report's hypotheses, safe to compute with. */
function hypothesesOf(report: FleetHealthReport): HypothesisedCause[] {
  return soundElements<HypothesisedCause>(report?.hypotheses);
}

/** A correlation's citations, safe to compute with. */
function citationsOf(correlation: ObservedCorrelation): FleetObservationEvidence[] {
  return soundElements<FleetObservationEvidence>(correlation?.observedBy);
}

/** The keys a hypothesis rests on. A non-array, or a non-string element, is not a key. */
function restingKeysOf(hypothesis: HypothesisedCause): string[] {
  const keys = hypothesis?.restingOn;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

/**
 * Was this fleet analysis actually finished?
 *
 * TWO WAYS TO NOT HAVE LOOKED, and both count: the scan itself
 * ({@link isFleetHealthScanComplete}) and a specific question reached but
 * unanswerable (`unanswered`). THE SINGLE DEFINITION — the CLI gate, the web
 * UI, the MCP projection and `FlightReader`'s response verification all call
 * this rather than each deciding what "complete" means.
 */
export function isFleetHealthAnalysisComplete(report: FleetHealthReport): boolean {
  return (
    isFleetHealthScanComplete(report?.scan) &&
    // INDEXED, NOT SOUND. Any entry blocks — including one too malformed to
    // read, which is the strongest ground for `indeterminate` there is. Using
    // the consumer direction here silently deleted unreadable questions and
    // licensed `healthy`; see REPORT_COLLECTIONS.
    indexedElements(report?.unanswered).length === 0 &&
    // And the same for any other collection the verdict depends on.
    !hasUnreadableGateInput(report)
  );
}

/** Convenience: the verdict this report's own contents imply. Use to verify a server's `verdict`. */
export function fleetHealthReportVerdict(report: FleetHealthReport): FleetHealthVerdict {
  return computeFleetHealthVerdict({
    correlationCount: correlationsOf(report).length,
    agentsFailing: report.agentsFailing,
    complete: isFleetHealthAnalysisComplete(report),
  });
}

// ---------------------------------------------------------------------------
// Ranking and navigation
// ---------------------------------------------------------------------------

/** Bound on `ObservedCorrelation.agentIds`. `agentCount` carries the real size. */
export const MAX_FLEET_CORRELATION_AGENTS = 20;

/**
 * Rank observed correlations for a one-screen incident view: BREADTH FIRST,
 * recency only as a tiebreak.
 *
 * The ordering is the product decision this function exists to hold in one
 * place. During an incident the most RECENT cluster is usually a downstream
 * symptom — retries piling up, a queue draining into a second agent — while
 * the BROADEST cluster is usually nearest the thing that actually changed.
 * Sorting by recency puts the symptom at the top of the screen and the cause
 * below the fold, and the person reading it has about ninety seconds.
 *
 * So recency can never promote a narrow correlation above a broad one; it only
 * orders correlations of equal breadth. This mirrors `afr triage`'s rule that
 * recency and volume order items WITHIN a signal class and never across one.
 *
 * ---------------------------------------------------------------------------
 * BREADTH DECIDES WHAT IS READ FIRST, SO BREADTH IS THE NUMBER MOST WORTH
 * FAKING
 * ---------------------------------------------------------------------------
 *
 * `agentCount` is a number a server hands over, and this function lets it
 * decide what an operator reads in the first ninety seconds of an incident.
 * Sorting by an unvalidated claim delegates that decision to whoever produced
 * it, including a buggy engine that inflates a one-agent retry loop into "500
 * agents affected".
 *
 * The fix is at the SOURCE rather than here: {@link correlationIncoherences}
 * now makes `agentCount` checkable (`agentIds` is bounded at a known ceiling,
 * so a list below that ceiling is complete and must match the count) and
 * requires a claim beyond that ceiling to be corroborated by at least two
 * distinct cited agents. A fabricated breadth is refused before it is ever
 * ranked. Demoting breadth in the sort would have been the wrong repair: it
 * would trade a correct product rule away to work around an unchecked input.
 *
 * {@link citedAgentCount} is kept as the SECOND key, so among equal claims the
 * better-evidenced one leads.
 *
 * Returns a new array; the input is not mutated.
 *
 * @param correlations - observed correlations, in any order. Rank only
 *   correlations that have passed {@link fleetReportIncoherences}; ranking an
 *   unchecked `agentCount` is the defect described above.
 * @returns the same correlations, most agents first; ties broken by most
 *   distinct cited agents, then most recent, then by `correlationKey` so the
 *   order is total and deterministic (an unstable incident view re-orders
 *   under the operator's cursor).
 */
export function rankFleetCorrelations(correlations: readonly ObservedCorrelation[]): ObservedCorrelation[] {
  // Ranking is a DISPLAY function and must not throw on a malformed element:
  // an incident view that crashes tells the operator less than one that shows
  // the sound clusters. A malformed entry sorts LAST and is never dropped —
  // silently shortening the list would turn a malformed cluster into an absent
  // one, which is the failure this whole contract is against.
  const rankOf = (c: ObservedCorrelation | null | undefined): number =>
    c !== null && c !== undefined && isCount(c.agentCount) ? c.agentCount : -1;
  const recencyOf = (c: ObservedCorrelation | null | undefined): number =>
    c !== null && c !== undefined && isFiniteNumber(c.lastObservedAt) ? c.lastObservedAt : -1;
  const keyOf = (c: ObservedCorrelation | null | undefined): string => c?.correlationKey ?? "";

  // Typed rather than left to `Array.isArray`'s `any[]` narrowing. The
  // accessors above already tolerate a null element at runtime; this keeps the
  // declared element type so nothing downstream loses its types.
  const input = (Array.isArray(correlations) ? correlations : []) as readonly ObservedCorrelation[];
  return [...input].sort((a, b) => {
    if (rankOf(b) !== rankOf(a)) return rankOf(b) - rankOf(a);
    const citedDelta = citedAgentCount(b) - citedAgentCount(a);
    if (citedDelta !== 0) return citedDelta;
    if (recencyOf(b) !== recencyOf(a)) return recencyOf(b) - recencyOf(a);
    return keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;
  });
}

/**
 * The hypotheses that rest on a given observed correlation.
 *
 * The navigation direction is deliberately observation -> hypothesis and never
 * the reverse. An incident view is read top-down from what happened; a list of
 * hypotheses with observations hanging off them would put the guesses first,
 * which is the layout that gets a healthy model rolled back.
 */
export function hypothesesFor(report: FleetHealthReport, correlationKey: string): HypothesisedCause[] {
  return hypothesesOf(report).filter((h) => restingKeysOf(h).includes(correlationKey));
}

/**
 * Hypotheses in this report that name ANY `correlationKey` the report does not
 * contain.
 *
 * A hypothesis whose observation is absent is a free-floating assertion — it
 * renders on an incident dashboard identically to one backed by twelve cited
 * occurrences, and there is nothing on screen to tell them apart. Empty is the
 * only acceptable result; the SDK refuses a response where it is not, and the
 * CLI never prints an orphan.
 *
 * EVERY KEY MUST RESOLVE, NOT MERELY ONE OF THEM. This predicate previously
 * asked whether the hypothesis rested on at least one real observation, which
 * let `restingOn: ['real-key', 'fabricated-key']` through as grounded. A
 * hypothesis that names two clusters is claiming to explain BOTH, and the
 * fabricated half is exactly the part a reader cannot check — worse, a
 * PARTIALLY grounded explanation is more persuasive than a wholly invented
 * one, because the half that resolves lends its credibility to the half that
 * does not. The distinction is one word of semantics and an entire safety
 * property.
 */
export function orphanHypotheses(report: FleetHealthReport): HypothesisedCause[] {
  const keys = new Set(correlationsOf(report).map((c) => c.correlationKey));
  return hypothesesOf(report).filter((h) => {
    const resting = restingKeysOf(h);
    // A hypothesis whose `restingOn` is missing or empty rests on nothing,
    // which is the orphan condition in its purest form — `.some()` over an
    // empty list is false, so it needs saying explicitly.
    return resting.length === 0 || resting.some((key) => !keys.has(key));
  });
}

// ---------------------------------------------------------------------------
// COHERENCE — do the report's own numbers agree WITH EACH OTHER?
//
// THE CLASS OF DEFECT THIS SECTION EXISTS FOR, STATED PLAINLY, BECAUSE IT
// PRODUCED FOUR SEPARATE HOLES BEFORE ANYONE NAMED IT:
//
//   Verifying that a field is PRESENT, and that it is internally well-formed,
//   is not the same as verifying that the NUMBERS IT CARRIES AGREE WITH THE
//   OTHER NUMBERS IN THE SAME REPORT.
//
// The gate had a check that the server honoured `burstWindowMs` (the echo) and
// a check that citations sat inside the window a correlation declared — and no
// check that the declared window fits the burst width. So a "burst" could echo
// four minutes and span twenty-four hours, and every existing check passed.
// Same shape: `agentCount` was never compared to the agents actually listed or
// cited, and a hypothesis's `restingOn` was checked for one resolving key
// rather than all of them.
//
// Cross-field arithmetic is decidable from the report's own contents at no
// extra request, and it is the last line of defence before a number reaches an
// operator's screen during an incident. So it lives here, enumerated, in one
// place, rather than being re-derived by each surface.
// ---------------------------------------------------------------------------

/**
 * One way a report's own numbers can contradict each other.
 *
 * ENUMERATED RATHER THAN BOOLEAN, on purpose: a gate needs a pass/fail, but a
 * human debugging a misbehaving engine needs to know WHICH arithmetic broke,
 * and a boolean forces every surface to re-derive that from scratch.
 */
export type CorrelationIncoherence =
  /** `lastObservedAt` precedes `firstObservedAt`. */
  | "inverted_window"
  /** A cited failure occurred outside the window the correlation declares. */
  | "citation_outside_window"
  /**
   * THE SERIOUS ONE. A `temporal_burst` whose declared span is wider than the
   * `burstWindowMs` the scan was run with. A day of ordinary background
   * failure, rendered as a four-minute incident — the same wrong answer the
   * parameter echo prevents, arriving by the other route. Only decidable with
   * the scan in hand, which is why {@link correlationIncoherences} takes one.
   */
  | "burst_span_exceeds_window"
  /**
   * `agentCount` contradicts `agentIds`. Either it is smaller than the list,
   * or the list is BELOW its ceiling — and therefore complete — while
   * `agentCount` claims more. See {@link ObservedCorrelation.agentIds}.
   */
  | "agent_count_contradicts_listed_agents"
  /**
   * A multi-agent claim whose whole citation sample names ONE agent. Coverage
   * of the CLAIM is not checkable from a bounded sample; coverage of the
   * SAMPLE is. Twelve citations that all name `ag_1` is not an outage, it is
   * one agent retrying — and that is decidable here, for free.
   */
  | "evidence_confined_to_one_agent"
  /**
   * A claim BEYOND the point where `agentIds` can corroborate it (more than
   * {@link MAX_FLEET_CORRELATION_AGENTS} agents), cited by fewer than two
   * distinct agents. Any real wide cluster can produce two citations from
   * different agents; this is the cheapest possible corroboration of the one
   * number that decides what gets read first.
   *
   * ---------------------------------------------------------------------
   * TWO RESIDUALS NO CLIENT-SIDE RULE CAN CLOSE — FOR WHOEVER WRITES THE
   * SERVER GUARANTEE
   * ---------------------------------------------------------------------
   *
   * These are not oversights; they are the limit of what a bounded report can
   * be checked against from the outside, and they are recorded here so the
   * next person does not rediscover them as bugs:
   *
   *   1. A claim of 500 agents, with `agentIds` filled to the cap and two
   *      distinct citations, passes every rule here AND STILL RANKS FIRST.
   *      Past the cap, `agentCount` is simply not verifiable from a bounded
   *      report — the corroboration rule bounds the lie to "two", it does not
   *      eliminate it.
   *   2. A single-citation sample is exempt from
   *      `evidence_confined_to_one_agent` BY DESIGN, because a sample of one
   *      has no room to demonstrate breadth and rejecting it would force an
   *      honest engine to pad its evidence.
   *
   * Both close only with a SERVER-SIDE guarantee about the citation sample:
   * that `observedBy` spans distinct agents in proportion to `agentCount`, up
   * to the sample bound. That guarantee belongs to the engine, because only
   * the engine has the unsampled occurrence set.
   */
  | "wide_claim_uncorroborated"
  /**
   * A numeric field this correlation is made of is not a usable number —
   * `NaN`, an infinity, a string, `null`, absent.
   *
   * THE REASON THIS CODE HAS TO EXIST, and it is the lesson of
   * {@link fleetReportUnusableFields} one layer up, in the file that already
   * wrote the lesson down: EVERY OTHER CHECK IN
   * {@link correlationIncoherences} IS A COMPARISON, AND EVERY COMPARISON
   * INVOLVING `NaN` IS FALSE. So a `NaN` did not FAIL those checks, it SKIPPED
   * them — a correlation with `agentCount: NaN` and `NaN` timestamps returned
   * ZERO incoherence codes and passed as sound. It then counted toward
   * `correlationCount`, produced `correlated_failures`, and paged someone at
   * 3am off a cluster made of `NaN`.
   *
   * A safe RENDERING is what hides this rather than exposing it: a UI that
   * correctly shows `—` for a `NaN` count makes the malformed input invisible
   * at the one place a human might have caught it.
   *
   * So this function no longer trusts that a usability sweep ran before it.
   * It is reachable independently — the web calls it directly — and a check
   * that is only correct when something else ran first is a check with an
   * ordering dependency nobody can see.
   */
  | "unusable_numbers"
  /** The entry is not a correlation at all — `null`, or not an object. See {@link fleetReportIncoherences}. */
  | "malformed_correlation";

/** How many DISTINCT agents this correlation's own cited evidence actually names. */
export function citedAgentCount(correlation: ObservedCorrelation): number {
  // Tolerant for the same reason its callers are: it is reached from a display
  // path that must not throw on a malformed element.
  return new Set(citationsOf(correlation).map((citation) => citation.agentId)).size;
}

/**
 * Every way this correlation's numbers contradict each other.
 *
 * PASS THE SCAN. It is a REQUIRED parameter, not an optional one, and that is
 * deliberate: the burst-span rule is the most important check here and an
 * optional scan is a scan that gets forgotten at exactly one call site. The
 * shape only needs `burstWindowMs`, so a caller holding a whole
 * {@link FleetHealthScan} can pass it directly.
 *
 * @param correlation - the observation to check.
 * @param scan - the scan it was produced by. Its `burstWindowMs` is what a
 *   `temporal_burst`'s span is measured against.
 * @returns every incoherence found, in a stable order. Empty means the numbers
 *   agree — which is NOT the same as the correlation being true, only that it
 *   does not refute itself.
 */
export function correlationIncoherences(
  correlation: ObservedCorrelation,
  scan: Pick<FleetHealthScan, "burstWindowMs">
): CorrelationIncoherence[] {
  const found: CorrelationIncoherence[] = [];

  // ---------------------------------------------------------------------
  // INPUTS FIRST, AND FAIL CLOSED — see `unusable_numbers` for why.
  //
  // Every check below is a comparison, and a comparison against `NaN` is
  // false, so a non-finite value SKIPS a check rather than failing it. This
  // guard runs unconditionally rather than relying on
  // `fleetReportUnusableFields` having been called first: this function is
  // exported and the web reaches it directly, so an ordering dependency here
  // would be one nobody can see from the call site.
  //
  // It returns EARLY. Once a number in this correlation is not a number, the
  // remaining rules cannot be evaluated, and reporting codes derived from
  // partly-garbage input would imply checks that did not happen.
  // ---------------------------------------------------------------------
  if (correlation === null || typeof correlation !== "object") return ["malformed_correlation"];

  const citations = citationsOf(correlation);
  const numbersUsable =
    isFiniteNumber(correlation.firstObservedAt) &&
    isFiniteNumber(correlation.lastObservedAt) &&
    isCount(correlation.agentCount) &&
    Array.isArray(correlation.agentIds) &&
    // `isComparableNumber` rather than `isFiniteNumber`: an INFINITE burst
    // width is deliberate and legal — it is how `isCorrelationSelfConsistent`
    // expresses "I cannot see the scan, so the span rule cannot apply".
    isComparableNumber((scan ?? {}).burstWindowMs) &&
    citations.every((citation) => citation.cites !== "failure_occurrence" || isFiniteNumber(citation.occurredAt));
  if (!numbersUsable) return ["unusable_numbers"];

  if (correlation.lastObservedAt < correlation.firstObservedAt) found.push("inverted_window");

  if (
    citations.some(
      (citation) =>
        citation.cites === "failure_occurrence" &&
        (citation.occurredAt < correlation.firstObservedAt || citation.occurredAt > correlation.lastObservedAt)
    )
  ) {
    found.push("citation_outside_window");
  }

  // The rule this file's own `lastObservedAt` doc has always stated, now
  // actually enforced. Applies to `temporal_burst` ALONE: a shared-fingerprint
  // cluster may legitimately span the whole observation window — the same
  // failure recurring for a day is a real and useful thing to report — and
  // only a BURST makes a claim about tightness in time.
  if (
    correlation.kind === "temporal_burst" &&
    correlation.lastObservedAt >= correlation.firstObservedAt &&
    correlation.lastObservedAt - correlation.firstObservedAt > scan.burstWindowMs
  ) {
    found.push("burst_span_exceeds_window");
  }

  const listed = correlation.agentIds.length;
  if (correlation.agentCount < listed || (listed < MAX_FLEET_CORRELATION_AGENTS && correlation.agentCount > listed)) {
    found.push("agent_count_contradicts_listed_agents");
  }

  const cited = citedAgentCount(correlation);
  // With a single citation the sample has no room to show more than one agent,
  // so silence there is not evidence of anything. With two or more, it is.
  if (correlation.agentCount > 1 && citations.length >= 2 && cited === 1) {
    found.push("evidence_confined_to_one_agent");
  }
  if (correlation.agentCount > MAX_FLEET_CORRELATION_AGENTS && cited < 2) {
    found.push("wide_claim_uncorroborated");
  }

  return found;
}

/**
 * Does a correlation agree with ITSELF?
 *
 * **THIS PREDICATE CANNOT SEE THE SCAN, AND THEREFORE CANNOT CHECK THE BURST
 * SPAN.** It takes no `burstWindowMs`, so a `temporal_burst` declaring a
 * twenty-four-hour window passes it. That is not a gap left open by accident —
 * it is the boundary of what a correlation can say about itself — but it does
 * mean this is NOT the whole rule and must not be used as a gate.
 *
 * **Use {@link fleetReportIncoherences} to gate.** It has the scan, so it
 * folds in the span rule and every check below.
 *
 * @returns true when the correlation's own fields do not refute each other:
 *   the window is not inverted, every failure citation lies inside it,
 *   `agentCount` agrees with the agents listed, and the citation sample is not
 *   confined to a single agent under a multi-agent claim. Declared-attribute
 *   citations are timeless and are not checked against the window.
 */
export function isCorrelationSelfConsistent(correlation: ObservedCorrelation): boolean {
  // Passing an infinite burst width makes the one scan-dependent rule
  // vacuously satisfied, which is precisely this predicate's limitation stated
  // in code rather than only in prose.
  return correlationIncoherences(correlation, { burstWindowMs: Number.POSITIVE_INFINITY }).length === 0;
}

// ---------------------------------------------------------------------------
// USABILITY — is what arrived something arithmetic can be done with AT ALL?
//
// THE CLASS, AND IT HAS NOW BITTEN TWICE, SO IT IS WRITTEN DOWN HERE RATHER
// THAN FIXED FIELD BY FIELD:
//
//   A gate that verifies a field is PRESENT has not verified that its
//   CONTENTS ARE USABLE.
//
// `fleetReportIncoherences` (above) answers "do these numbers agree with each
// other?". It presumes they ARE numbers. This answers the prior question, and
// the two are genuinely different: a `lastObservedAt` of `'2024-01-01T00:00Z'`
// is a perfectly present, perfectly readable field that makes every comparison
// in the coherence sweep evaluate to `false` — so a burst with garbage
// timestamps reports NO incoherence and sails through.
//
// THE PATTERN TO WATCH FOR, in this file and anywhere else: a guard written as
// a comparison (`x <= 0`, `if (x.truncated)`, `x > 0`) does not reject a
// non-number, it just takes the other branch. Whether that branch is the safe
// one is luck. Four of the five holes found in this contract were exactly
// that, including one that was safe purely because every IEEE comparison with
// NaN is false.
//
// So the boundary asks the question directly, once, for every field that feeds
// a verdict, a gate, or the ranking — and the SDK REFUSES a report that fails
// it, rather than leaving each downstream function to defend itself forever.
// ---------------------------------------------------------------------------

/** Why a field's contents cannot be used. Facts about the VALUE, never about any agent. */
export type UnusableReason =
  /** Missing entirely, or present as something that is not the declared kind. */
  | "not_a_count"
  /** Present but not a finite number — `NaN`, an infinity, a string, `null`. */
  | "not_a_finite_number"
  /** A flag that is not a boolean. Fails CLOSED: a dropped flag must never read as `false`. */
  | "not_a_boolean"
  /** A closed-vocabulary field carrying a value this contract does not define. */
  | "not_a_known_value"
  /** A base-rate measurement that is malformed rather than honestly unmeasured. */
  | "unusable_measurement"
  /**
   * An ARRAY ELEMENT that is not an object at all — `null`, a primitive, a
   * nested array. Reported for EVERY collection, including `unanswered`, whose
   * omission from this reporter is why a malformed question went unnamed while
   * licensing `healthy`.
   */
  | "malformed_element";

/** One unusable field, addressed by a path a human can act on. */
export interface UnusableFieldFinding {
  /** e.g. `"scan.burstWindowMs"`, `"correlations[burst:1].agentCount"`, `"hypotheses[h1].sharedBy"`. */
  path: string;
  reason: UnusableReason;
}

/**
 * Every field in a report whose contents cannot be used.
 *
 * THE ONE FUNCTION A BOUNDARY SHOULD CALL, and it must run BEFORE
 * {@link fleetReportIncoherences} and before any verdict is computed — both do
 * arithmetic, and arithmetic on a string is how a guess became "read this
 * first".
 *
 * Covers exactly the fields that feed a verdict, a gate, or the ranking. It is
 * not a schema validator and does not try to be: a malformed `agentName`
 * cannot authorise a rollback, and a check that flags everything gets
 * disabled.
 *
 * MUST NEVER THROW. It runs at a boundary, on a JSON body nothing has
 * vouched for, and a validator that crashes on malformed input has handed the
 * caller an unhandled exception instead of a refusal — which on a monitoring
 * loop is an exit code nobody wrote a meaning for. Every collection it walks
 * is therefore checked before it is walked.
 *
 * @returns every unusable field, in report order. Empty means the numbers are
 *   real numbers — not that they are true, and not that they agree with each
 *   other (that is {@link fleetReportIncoherences}).
 */
export function fleetReportUnusableFields(report: FleetHealthReport): UnusableFieldFinding[] {
  const found: UnusableFieldFinding[] = [];
  const count = (value: unknown, path: string): void => {
    if (!isCount(value)) found.push({ path, reason: "not_a_count" });
  };
  const finite = (value: unknown, path: string): void => {
    if (!isFiniteNumber(value)) found.push({ path, reason: "not_a_finite_number" });
  };
  const bool = (value: unknown, path: string): void => {
    if (typeof value !== "boolean") found.push({ path, reason: "not_a_boolean" });
  };

  finite(report.analyzedAt, "analyzedAt");
  // Feeds the verdict directly: a NaN here made `agentsFailing > 0` false and
  // turned a failing fleet into `healthy`.
  count(report.agentsFailing, "agentsFailing");

  const scan = (report.scan ?? {}) as unknown as Record<string, unknown>;
  finite(scan["since"], "scan.since");
  finite(scan["until"], "scan.until");
  finite(scan["burstWindowMs"], "scan.burstWindowMs");
  if (scan["correlationBasis"] !== "whole_roster" && scan["correlationBasis"] !== "page_local") {
    // Unknown basis is refused rather than read as either. It already fails
    // closed in `isFleetHealthScanComplete`, but a deployment speaking a
    // vocabulary this contract does not define is not a deployment to guess at.
    found.push({ path: "scan.correlationBasis", reason: "not_a_known_value" });
  }
  for (const field of [
    "agentsInRoster",
    "agentsAssessed",
    "agentsUnassessable",
    "agentsSkippedForBudget",
    "occurrencesScanned",
  ]) {
    count(scan[field], `scan.${field}`);
  }
  bool(scan["scanTruncated"], "scan.scanTruncated");
  bool(scan["baseRatesMeasured"], "scan.baseRatesMeasured");

  // MALFORMED ELEMENTS FIRST, FOR EVERY COLLECTION, DRIVEN BY THE TABLE — so
  // this reporter cannot cover three of four again. It previously walked the
  // collections by hand and missed `unanswered`, which is the one whose
  // malformed elements license a false `healthy`.
  for (const { collection, index } of malformedElements(report)) {
    found.push({ path: `${collection}[${index}]`, reason: "malformed_element" });
  }

  for (const correlation of correlationsOf(report)) {
    const at = `correlations[${correlation.correlationKey}]`;
    // Every comparison in the coherence sweep reads these. A string here makes
    // the burst-span rule silently unenforceable.
    finite(correlation.firstObservedAt, `${at}.firstObservedAt`);
    finite(correlation.lastObservedAt, `${at}.lastObservedAt`);
    // The number that decides what is read first.
    count(correlation.agentCount, `${at}.agentCount`);
    for (const [i, citation] of indexedElements<FleetObservationEvidence>(correlation.observedBy).entries()) {
      if (citation === null) {
        found.push({ path: `${at}.observedBy[${i}]`, reason: "malformed_element" });
        continue;
      }
      if (citation.cites === "failure_occurrence") {
        finite(citation.occurredAt, `${at}.observedBy[${i}].occurredAt`);
      }
    }
  }

  for (const entry of soundElements<AgentHealthEntry>(report?.roster)) {
    const at = `roster[${entry.agentId}]`;
    count(entry.runsObserved, `${at}.runsObserved`);
    count(entry.runsFailed, `${at}.runsFailed`);
    count(entry.distinctFingerprints, `${at}.distinctFingerprints`);
    bool(entry.observationTruncated, `${at}.observationTruncated`);
  }

  for (const hypothesis of hypothesesOf(report)) {
    if (baseRateUsability(hypothesis.sharedBy) === "unusable") {
      found.push({ path: `hypotheses[${hypothesis.hypothesisKey}].sharedBy`, reason: "unusable_measurement" });
    }
  }

  return found;
}

/** One incoherence, and the correlation it was found in. */
export interface FleetIncoherenceFinding {
  correlationKey: string;
  incoherence: CorrelationIncoherence;
}

/**
 * Every incoherence in a whole report, checked against the scan that produced
 * it.
 *
 * THE ONE FUNCTION A GATE SHOULD CALL. It is the only entry point with both
 * halves in hand — the correlation and the `burstWindowMs` it was computed
 * under — so it is the only one that can enforce the burst-span rule. The SDK
 * refuses any response for which this is non-empty.
 *
 * @returns every finding, correlations in report order. Empty means the
 *   report's numbers agree with each other — not that its claims are true.
 */
export function fleetReportIncoherences(report: FleetHealthReport): FleetIncoherenceFinding[] {
  // TOLERATES A NULL ARRAY ELEMENT rather than throwing on it. The elements of
  // a REQUIRED array were still being trusted after every required FIELD had
  // stopped being — the same gap, one container deeper. Not reachable through
  // the SDK today (its certainty loop refuses a null element first, and a test
  // now pins that ordering), and reachable the moment a surface reads server
  // JSON directly, which the web is about to do. A validator that throws has
  // handed its caller an unhandled exception instead of a refusal.
  const correlations = indexedElements<ObservedCorrelation>(report?.correlations);
  const scan = report?.scan ?? { burstWindowMs: Number.POSITIVE_INFINITY };
  return correlations.flatMap((correlation, index) =>
    // A `null` entry reaches `correlationIncoherences`, which returns
    // `malformed_correlation` for it — the reporting path deliberately keeps
    // the entry rather than dropping it, so the bad position is named.
    correlationIncoherences(correlation as ObservedCorrelation, scan).map((incoherence) => ({
      // A malformed entry has no key to name itself with, so it is addressed
      // by position — never dropped, because a silently shorter list is how a
      // malformed cluster becomes an absent one.
      correlationKey: correlation?.correlationKey ?? `(correlations[${index}])`,
      incoherence,
    }))
  );
}
