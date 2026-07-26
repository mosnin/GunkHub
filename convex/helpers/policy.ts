// ---------------------------------------------------------------------------
// DECLARATIVE POLICY — detection over recorded runs, and the pre-flight listing.
//
// "Agent X may not call tool Y." "No run in environment Z may egress to host H."
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness, no recursion. Same posture as convex/helpers/{budget,causal_graph,
// fleet,divergence,otel_mapping,analytics}.ts. `evaluatedAt` is an INPUT for the
// same reason `analyzedAt` is in helpers/causal_graph.ts.
//
// ===========================================================================
// PART 1 — THE CONTRACT VOCABULARY, IMPORTED (not mirrored)
// ===========================================================================
//
// Everything about rules, subjects, evidence, certainty, coverage and verdict is
// IMPORTED from `packages/contracts/src/policy.ts`, which is CANONICAL. THERE IS
// NO COPY OF IT HERE.
//
// AN EARLIER REVISION OF THIS FILE DEFINED THE VOCABULARY LOCALLY, and the cost
// was paid twice in one cycle, which is why the whole story is kept:
//
//   FIRST it exported six names — `PolicyViolated`, `PolicySatisfied`,
//     `PolicyNotEvaluable`, `PolicyNotEvaluableKind`, `PolicySubject`,
//     `PolicyPreflightAnswer` — that collide with contracts' with DIFFERENT
//     SHAPES. Two definitions of a certainty boundary that can silently disagree,
//     and a drifted boundary HERE renders `not_evaluable` as `satisfied`, which
//     is the single outcome this module exists to prevent.
//   THEN, told contracts was authoritative, it was rewritten to MIRROR the
//     contracts file as it stood — which was the other vocabulary, mid-flight.
//     Mirroring a moving target produced a second wrong copy in the same day.
//
// The resolution both times is the one helpers/budget.ts, helpers/causal_graph.ts
// and helpers/fleet.ts each record reaching: DELETE the local copy, do not
// synchronise it. This is now the FOURTH file in this repository to write that
// sentence down. There is no `Local…` type here any more and there must never be
// one again.
//
// THE ONE COST, STATED: `@agent-flight-recorder/contracts` resolves through
// `dist/`, a gitignored build artifact, so `convex typecheck` requires
// `packages/contracts` to be BUILT first — and at >= 0.26.0, the version whose
// index re-exports `./policy.js`. Before that the vocabulary existed in the
// package source but was unreachable from this boundary, which is why this file
// carried a local mirror for one cycle. helpers/{budget,divergence,fleet,
// causal_graph}.ts already record the build-ordering coupling; this adds nothing.
//
// ===========================================================================
// PART 2 — THE RULING THAT INVERTS THE OBVIOUS DESIGN
// ===========================================================================
//
// A POLICY GATE MUST NEVER REFUSE, MUTATE, OR SUPPRESS AN EVENT.
//
// The obvious build is enforcement at ingest: reject the `tool.call` that
// violates the policy. That is exactly backwards for this product. REFUSING TO
// RECORD A VIOLATION DESTROYS THE EVIDENCE OF THE VIOLATION. We are the recorder;
// a breach is the single most valuable row in the log, and an engine that rejects
// it makes the product blind precisely when something has gone wrong. The
// forbidden call still HAPPENED, in a process this product does not run, and
// refusing the event changes only whether anyone can find out.
//
// So this module is two honest things and never a third:
//
//   1. DETECTION over recorded data — which runs violated which policy, with the
//      events that prove it.
//   2. A PRE-FLIGHT LISTING the SDK can ask for — the DEFINITIONS, never a
//      verdict — subject to the same limit as the budget breaker's snapshot: WE
//      CANNOT STOP AN AGENT WE DO NOT CONTROL. The decision is the caller's;
//      contracts' `decidePreflight` runs client-side for the reason
//      `decideBudget` does.
//
// NOTHING IN THIS FEATURE WRITES TO `events`. Nothing patches a run.
//
// AND THE STRONGER FORM, WHICH IS THE ONE THAT BINDS: NO POLICY EVALUATION RUNS
// INSIDE AN INGEST TRANSACTION AT ALL, even non-rejectingly. "Does not reject" is
// a property of code someone wrote and can be undone by a bug — an evaluation
// that merely THROWS fails the surrounding insert and has become a refusal by
// accident. "Does not run there" is a property of the dependency graph, which no
// bug inside this module can violate. Asserted structurally in
// convex/policies.test.ts over the ingest modules' own imports, and behaviourally
// there and in tests/unit/policy_adversarial_ingest.test.ts.
//
// THE PRE-FLIGHT SEAM ONLY HAS TEETH BECAUSE RECORDING IS UNCONDITIONAL. An
// advisory answer is worth asking for precisely because ignoring it produces a
// recorded, findable violation.
//
// ===========================================================================
// PART 3 — THE THREE STATES, AND THE ASYMMETRY THAT DRIVES THEM
// ===========================================================================
//
// `violated` / `satisfied` / `not_evaluable`. The third is the COMMON case — in
// this product today the UNIVERSAL one — and the dangerous one. `not_evaluable`
// MUST NEVER RENDER AS `satisfied`: a compliance surface that reports "no
// violations" when it could not look is worse than no compliance surface, because
// someone will attest to it.
//
//   EVIDENCE OF A VIOLATION IS PROOF. It survives an incomplete scan, an
//     unreadable neighbour, an in-flight run — none can un-record it. So
//     `violated` is decided FIRST in {@link foldPolicyOutcome}, before any
//     coverage test. Testing coverage first would DISCARD A PROVEN BREACH because
//     the rest of the log was unreadable.
//   ABSENCE OF EVIDENCE PROVES NOTHING.
//
// ===========================================================================
// PART 4 — THE LIMIT NO READ-PROPERTY CAN FIX, NOW SETTLED BY THE CONTRACT
// ===========================================================================
//
// Five of `PolicyCoverageProof`'s six fields are properties of THE READ. All five
// are satisfiable over a run that called the forbidden tool through a code path
// that never called `Events.toolCall`. The act happened, nothing wrote it down,
// and the log is complete and silent about it.
//
// I FIRST APPLIED THIS TO EGRESS ONLY, ON A DISTINCTION THAT WAS FALSE, AND THE
// ERROR IS RECORDED RATHER THAN QUIETLY CORRECTED. The argument was that a tool
// call goes through a framework the SDK wraps, so an unrecorded tool call implies
// an operator-visible instrumentation lapse, while an unrecorded `fetch` needs no
// lapse. It is false: `packages/sdk/src/events.ts` exposes
// `toolCall(name, input, call_id)` — a MANUAL BUILDER taking the tool name as a
// caller-supplied string — and a grep across `packages/sdk/src` for `Proxy`,
// monkeypatching or tool wrapping returns nothing. THE SDK WRAPS NOTHING.
//
// I also wrote here, before anyone tested it, that if the distinction were ever
// shown false then `tool_denied` must FOLLOW egress into unreachability rather
// than be argued down to match it. It was shown false, and it has.
//
// THE CONTRACT'S FIX IS BETTER THAN THE ONE I BUILT AND SUPERSEDES IT ENTIRELY.
// I had a total `Record` over the rule kinds — a second gate beside the first,
// which at least made a new kind a compile error. Contracts puts the requirement
// INSIDE THE PROOF: `PolicyCoverageProof.instrumentation` is typed
// `CompleteInstrumentationClaim`, so `{ claims: "undeclared" }` IS NOT ASSIGNABLE
// and a coverage proof for an undeclared agent DOES NOT COMPILE. A third rule
// kind cannot ship without a declaration because the proof will not build without
// one — the requirement is a property of THE PROOF rather than of a table
// somebody has to remember to extend.
//
// `coversOperations` is a non-empty tuple plus a required `mechanism`, so a
// tool-call declaration cannot license an egress all-clear;
// {@link instrumentationCovers} is the check and this engine CALLS it rather than
// re-deriving it.
//
// NOTHING PRODUCES A COMPLETE CLAIM TODAY, so `satisfied` IS UNREACHABLE FOR
// EVERY AGENT IN THE PRODUCT. Same shape as helpers/budget.ts's counter-backed
// breaker, which can trip and can never arm. `violated` is unaffected: an
// unrecorded act cannot un-record a recorded one.
//
// ===========================================================================
// PART 5 — WHAT COUNTS AS "WE COULD NOT READ THE DECIDING FIELD"
// ===========================================================================
//
// Four ways, and the last two were missed in the first cut of this engine and are
// the reason coverage read complete over runs where it plainly was not:
//
//   EXTERNALIZED   Event Log Rule 3 moved the payload past 10 KB into an
//                  artifact. `originalType` survives; the tool name does not.
//   ABSENT         Inline payload, no such field — malformed, or an older SDK.
//   UNMAPPED SPAN  An `otel.span.unmapped` event is a span the mapper could not
//                  interpret. IT MAY HAVE BEEN ANY OPERATION, including the
//                  forbidden one, so it is undecidable FOR EVERY RULE KIND — not
//                  merely for the kind whose deciding event type it is not.
//                  Counting it as irrelevant is what let coverage read complete
//                  over a run whose every act was an unreadable span.
//   LOSSY DERIVED  An OTel-derived event whose `provenance.lossy` is true has
//                  mapped fields that may be missing or approximate. The sibling
//                  engine over the same rows — helpers/divergence.ts's
//                  `extractRunObservation` — raises `LOSSY_DERIVED_EVENT` for
//                  exactly this. Two engines, one question, and they must not
//                  give different answers.
//
// THE ONE EXCEPTION, AND ITS BOUNDARY. When the rule denies the OPERATION ITSELF
// (`deniedTools`/`deniedHosts` absent), the event TYPE alone decides it and the
// payload is never needed — so an externalized payload still PROVES a violation,
// recorded as `decidedBy: "event_type_alone"`. Against a rule naming even one
// target this must still decline, because an unnamed call may have been to a
// permitted one. The guard is contracts' {@link ruleIsDecidableFromEventTypeAlone},
// used and not hand-rolled, and contracts audits misuse of the route as a
// `type_alone_against_a_targeted_rule` contradiction.
//
// AN EMPTY TARGET LIST IS A MISCONFIGURATION, NOT A WIDENED RULE. `undefined`
// denies everything; `[]` denies nothing, forever — two opposite meanings one
// serialization step apart. A `[]` rule would clear a run that called the banned
// tool while producing an observation indistinguishable from a rule that genuinely
// checked. It is refused at write time AND re-checked here in
// {@link isInterpretableRule}, because a row restored from a backup, or written
// before the guard existed, must be reported `policy_unreadable` rather than
// silently matching nothing.
//
// ===========================================================================
// PART 6 — TRUTH THAT IS TRUE FOR THE WRONG REASON
// ===========================================================================
//
// Every clause of {@link isPolicyCoverageComplete} is POSITIVE. There is no
// `!truncated`, no `.every()` over a possibly-empty array, no "no gaps were
// recorded":
//
//   runObserved === true       The run was READ. Not "not missing".
//   logReadComplete === true   The reader SAW the end of the log. It over-fetches
//                              by one and checks, so this cannot be true by
//                              default.
//   runIsTerminal === true     The run FINISHED (Event Log Rule 5).
//   undecidableCount === 0     Every deciding field was legible.
//   crossOrgRowsSkipped === 0  Everything read was accounted for.
//
// `eventsExamined` is deliberately NOT gated, the same call helpers/budget.ts's
// `isSpendSumComplete` makes about `runsCounted`.
//
// ZERO RUNS IN SCOPE IS ITS OWN OUTCOME (`no_runs_in_scope`), never an absent
// one: an empty set satisfies every prohibition trivially, and a scan pointed at
// the wrong project produces exactly that.
// ---------------------------------------------------------------------------

import {
  MAX_POLICIES_PER_ORG,
  MAX_POLICY_ANSWER_FRESHNESS_MS,
  MAX_POLICY_OUTCOMES,
  POLICY_NOT_EVALUABLE_KINDS,
  POLICY_RULE_KINDS,
  POLICY_SUBJECT_KINDS,
  RULE_DECIDING_EVIDENCE,
  countPolicyOutcomes,
  hostFallsUnder,
  hostForMatching,
  instrumentationCovers,
  isCoverageProof,
  isEstablishedSatisfied,
  isExternalizedPayload,
  isInterpretableRule,
  matchRecordedEventAgainstPolicy,
  policyGoverns,
  policyOutcomeStatement,
  ruleIsDecidableFromEventTypeAlone,
  type CompleteInstrumentationClaim,
  type InstrumentationClaim,
  type PolicyDefinition,
  type PolicyEvaluation,
  type PolicyEvaluationScan,
  type PolicyEventCitation,
  type PolicyNotEvaluable,
  type PolicyNotEvaluableKind,
  type PolicyOutcome,
  type PolicyOutcomeCounts,
  type PolicyRule,
  type PolicyRuleKind,
  type PolicySatisfied,
  type PolicySnapshot,
  type PolicySubject,
  type PolicyViolated,
  type PolicyViolationProof,
  type RecordedActEvent,
  type RuleMatch,
  type SatisfactionLicence,
} from "@agent-flight-recorder/contracts";

import { assertNoExecutionClaim, executionClaimIn } from "./budget.js";

// Re-exported so convex/policies.ts and convex/policy_gate.ts have ONE import
// site for the vocabulary, and so nothing downstream is tempted to redeclare a
// name. These are contracts' types unchanged — this module adds no member to any
// of them, and a re-export cannot drift the way a mirror can.
export type {
  CompleteInstrumentationClaim,
  InstrumentationClaim,
  PolicyDefinition,
  PolicyEvaluation,
  PolicyEvaluationScan,
  PolicyEventCitation,
  PolicyNotEvaluable,
  PolicyNotEvaluableKind,
  PolicyOutcome,
  PolicyOutcomeCounts,
  PolicyRule,
  PolicyRuleKind,
  PolicySatisfied,
  PolicySnapshot,
  PolicySubject,
  PolicyViolated,
  PolicyViolationProof,
  RecordedActEvent,
  RuleMatch,
  SatisfactionLicence,
};

export {
  MAX_POLICIES_PER_ORG,
  MAX_POLICY_ANSWER_FRESHNESS_MS,
  MAX_POLICY_OUTCOMES,
  POLICY_NOT_EVALUABLE_KINDS,
  POLICY_RULE_KINDS,
  POLICY_SUBJECT_KINDS,
  RULE_DECIDING_EVIDENCE,
  countPolicyOutcomes,
  hostFallsUnder,
  hostForMatching,
  instrumentationCovers,
  isCoverageProof,
  isEstablishedSatisfied,
  isExternalizedPayload,
  isInterpretableRule,
  matchRecordedEventAgainstPolicy,
  policyGoverns,
  policyOutcomeStatement,
  ruleIsDecidableFromEventTypeAlone,
};

// THE EXECUTION-CLAIM GUARD IS IMPORTED, NOT REIMPLEMENTED. It bans exactly the
// sentences this module must also never write — "blocked", "prevented",
// "enforced", "stopped" — and it is the same claim being guarded.
//
// IT EARNED ITS KEEP DURING DEVELOPMENT: it fired on "terminated" and "stopped"
// in their run-lifecycle and scan senses, in prose that would otherwise have
// shipped, and it fired from INSIDE `foldPolicyOutcome` — so the engine worked
// when there was a violation and threw when there was not. Both sentences are
// rephrased, and helpers/policy.test.ts now sweeps EVERY sentence this module can
// emit rather than the two that happened to fail.
export { assertNoExecutionClaim, executionClaimIn };

// ===========================================================================
// PART A — BOUNDS not fixed by the contract
// ===========================================================================

export const MAX_POLICY_NAME_LENGTH = 80;
export const MAX_POLICY_RATIONALE_LENGTH = 1_024;
export const MAX_DENIED_ENTRIES = 50;
export const MAX_DENIED_ENTRY_LENGTH = 200;

/**
 * Events read when evaluating ONE run. THE READ IS UNFILTERED, deliberately: the
 * unmapped-span count is a property of the WHOLE log, and a read filtered to the
 * deciding event type cannot see one. One read serves every policy governing the
 * run.
 */
export const POLICY_MAX_EVENTS_PER_RUN = 20_000;

/** Runs opened in one page of the cross-run scan. */
export const POLICY_SCAN_MAX_RUNS_PER_PAGE = 25;

/** Events read per run inside the cross-run scan, and in total across the page. */
export const POLICY_SCAN_MAX_EVENTS_PER_RUN = 2_000;
export const POLICY_SCAN_MAX_EVENTS_TOTAL = 20_000;

/** Evidence citations carried on one outcome. The count is reported separately as a FLOOR. */
export const MAX_VIOLATION_PROOFS = 20;

/** Server-stated shelf life, taken FROM THE CONTRACT rather than chosen here. */
export const POLICY_SNAPSHOT_SHELF_LIFE_MS = MAX_POLICY_ANSWER_FRESHNESS_MS;

// ===========================================================================
// PART B — THE COMPLIANCE-CLAIM GUARD
//
// COMPLEMENTARY TO the imported execution-claim guard. That one stops us claiming
// an agent was stopped. This one stops us describing an UNDECIDED result in the
// vocabulary of a DECIDED one — "no violations", "clean", "passed", "compliant"
// are what a contributor reaches for when composing a message for a run nothing
// could be read from, and every one is what an auditor would quote.
//
// DELIBERATELY WIDER THAN CONTRACTS' `FORBIDDEN_COMPLIANCE_PROSE`, which is the
// WIRE check. This is the PRODUCER-SIDE check over sentences this module composes
// itself, and it adds the everyday spellings a global wire regex would over-reach
// by banning. Both are needed, in the same way helpers/budget.ts's prose sweep
// complements the contract's field-name list: a producer can over-claim by adding
// a FIELD or by writing one SENTENCE.
//
// Applied ONLY to not-evaluable and coverage prose; a licensed `satisfied` is
// entitled to say so, and contracts guards that one at the wire.
// ===========================================================================

export const FORBIDDEN_COMPLIANCE_CLAIMS: readonly RegExp[] = [
  /\bcompliant\b/i,
  /\bin compliance\b/i,
  /\bno violations?\b/i,
  /\bnone found\b/i,
  /\bclean\b/i,
  /\bpassed\b/i,
  /\bverified\b/i,
  /\ball clear\b/i,
  /\bnothing found\b/i,
];

/** The first compliance claim in `text`, or null. Returns the OFFENDING SUBSTRING. */
export function producerComplianceClaimIn(text: string): string | null {
  for (const pattern of FORBIDDEN_COMPLIANCE_CLAIMS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

/** Assert a sentence describing an UNDECIDED result does not read as a decided one. */
export function assertNoComplianceClaim(text: string, where: string): string {
  assertNoExecutionClaim(text, where);
  const offending = producerComplianceClaimIn(text);
  if (offending !== null) {
    throw new Error(
      `policy vocabulary violation in ${where}: "${offending}" describes an UNDECIDED result in the ` +
        `vocabulary of a decided one. A not_evaluable outcome means we could not look, which is not the ` +
        `same as having looked and found nothing. See convex/helpers/policy.ts PART 3.`,
    );
  }
  return text;
}

// ===========================================================================
// PART C — OBSERVATIONS. Plain rows, so the engine is testable with literals.
// ===========================================================================

/** One stored event row, as this engine needs it. Produced by convex/policies.ts. */
export interface PolicyObservableEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
  readonly sequenceNumber: number;
  readonly timestamp: number;
  readonly payload: unknown;
  /**
   * OTel provenance, when the event was DERIVED rather than recorded first-party.
   *
   * THE CHANNEL EXISTS BECAUSE ITS ABSENCE WAS A DEFECT: without it a lossy
   * OTel-derived `tool.call` graded byte-identically to a first-party one, while
   * helpers/divergence.ts — the sibling engine answering the same question over
   * the same rows — correctly raised `LOSSY_DERIVED_EVENT`.
   */
  readonly provenance?: { readonly source?: string; readonly lossy?: boolean };
}

/** What the I/O layer can say about its OWN read, independent of any policy. */
export interface PolicyRunReadFacts {
  readonly runId: string;
  readonly runObserved: boolean;
  readonly runIsTerminal: boolean;
  /** POSITIVE: the reader over-fetched by one row and saw the end of the log. */
  readonly logReadComplete: boolean;
  readonly crossOrgRowsSkipped: number;
  readonly observedAt: number;
  /**
   * The agent version's own instrumentation claim for this run.
   *
   * ABSENT is treated exactly as `{ claims: "undeclared" }` — nothing defaults to
   * covered. Nothing produces a COMPLETE claim today, so `satisfied` is
   * unreachable; see PART 4. This is the seam an agent-version declaration plugs
   * into.
   */
  readonly instrumentation?: InstrumentationClaim;
}

/**
 * ALIAS for {@link PolicyRunReadFacts}, kept because callers outside this
 * boundary spell it this way.
 *
 * IT IS AN ALIAS AND NOT A SECOND SHAPE. The FIELD is `logReadComplete`, matching
 * the contract's `PolicyCoverageProof.logReadComplete` exactly — an earlier draft
 * called it `reachedEndOfLog`, and two spellings of one certainty field is the
 * drift this repository keeps paying for. A consumer still using the old field
 * name gets a compile error, which is the intended outcome.
 */
export type PolicyScanFacts = PolicyRunReadFacts;

export type DecidingFieldAvailability =
  | "field_present"
  | "field_externalized"
  | "field_absent"
  | "event_unreadable";

export interface PolicyRunObservation extends PolicyRunReadFacts {
  readonly eventsExamined: number;
  /** Events of the rule's deciding type, INCLUDING those whose field was unreadable. */
  readonly relevantEventsSeen: number;
  /** See PART 5 — four ways, each fatal to a licence. */
  readonly undecidableCount: number;
  readonly undecidableSequenceNumbers: readonly number[];
  /**
   * The CONTRACT'S OWN account of why the first few were undecidable — kind,
   * reason and remedy, produced by `matchRecordedEventAgainstPolicy` rather than
   * re-derived here. Carrying the contract's sentence means the operator is told
   * what the matcher actually could not do, instead of this file's guess at it.
   */
  readonly undecidableKinds: readonly PolicyNotEvaluableKind[];
  readonly undecidableReasons: readonly string[];
  readonly undecidableRemedies: readonly string[];
  readonly proofs: readonly PolicyViolationProof[];
  readonly operationsMatched: number;
  /**
   * WHY THIS POLICY DOES NOT GOVERN, as the CONTRACT classified it, or `null`.
   *
   * Obtained by asking `matchRecordedEventAgainstPolicy` rather than by
   * re-deriving it here, because the ORDER matters and is the contract's to fix:
   * enablement is read BEFORE the rule, so a disabled policy carrying a vacuous
   * rule reports `policy_disabled` rather than sending an operator to go and fix
   * a rule on a policy nobody switched on. A local `enabled ? … : …` here would
   * be a second spelling of "does this policy count" — the exact split that let
   * the pre-flight and the evaluator disagree.
   */
  readonly governanceFailure: {
    readonly kind: PolicyNotEvaluableKind;
    readonly because: string;
    readonly wouldBeEvaluableBy: string;
  } | null;
  /** True when any event in this run was OTel-derived: `sequenceNumber` is ARRIVAL order. */
  readonly orderingCaveat: boolean;
}

// ===========================================================================
// PART D — MATCHING. THERE IS NO READER HERE ANY MORE, AND THAT IS THE FIX (D6)
// ===========================================================================
//
// THIS FILE USED TO CARRY `readToolName`, `readEgressHost`, `readDecidingField`,
// `ruleForbidsValue`, `isInterpretableRule`, `isExternalizedPayload` and a
// `nonMatchIsUndecidable` predicate. ALL SEVEN ARE DELETED. Contracts'
// {@link matchRecordedEventAgainstPolicy} takes the whole event and the whole
// POLICY and
// returns all four bands, so THERE IS NO WAY FOR THIS BOUNDARY TO PERFORM HALF
// OF THE OPERATION.
//
// WHY THE PAIR WAS THE DEFECT, RECORDED BECAUSE IT SHIPPED. The reader accepted
// `host`/`hostname` as well as `url`; the matcher resolved values through a URL
// parse and understood only full URLs. Measured against the contracts build of
// the day: `"https://evil.example.com/x"` matched, and `"evil.example.com"`,
// `"evil.example.com:443"` and `"api.evil.example.com"` did not. So an
// `http.request` payload carrying `host: "evil.example.com"` was examined,
// counted FULLY LEGIBLE, matched against nothing, and — given a complete
// instrumentation claim — returned `satisfied`. A recorded, inline, legible
// forbidden call reported as compliant. THE READER WAS RIGHT AND THE MATCHER WAS
// RIGHT AND THE PAIR WAS WRONG, which is what "separately maintained" means.
//
// MY OWN COMMENT PREDICTED IT WITH THE POLARITY REVERSED — "the boundary logic
// was single-sourced and the EXTRACTION was not, which was enough" — written
// after fixing the mirror-image version of the same bug. Single-sourcing the
// matcher is not enough while the extractor decides what SHAPE of value to hand
// it, and my interim repair (deleting the `host` branch) was also wrong: it
// traded a false all-clear for a missed violation, in the safe direction but
// still losing the breach that matters most.
//
// TWO THINGS THIS BOUNDARY MUST NOT REACQUIRE:
//
//   NO FIELD-CANDIDATE LIST HERE. `url` / `uri` / `endpoint` / `host` /
//     `hostname` / `name` / `tool` / `tool_name` live in contracts, because a
//     spelling the emitter uses and the evaluator does not is a forbidden call
//     nobody sees, and that list must be ONE list.
//   NO INTERPRETATION OF A NON-MATCH. `permitted_by_this_rule` and `undecidable`
//     are different bands of the contract's own return type, so this file cannot
//     collapse "read and permitted" into "not matched" — the conflation that
//     produced the second half of D6.
// ===========================================================================

/** Does this policy govern this run? Decided positively; nothing defaults to governed. */
export function policyGovernsRun(
  subject: PolicySubject,
  run: { projectId: string; agentId: string; environment?: string },
): boolean {
  switch (subject.appliesTo) {
    case "org":
      return true;
    case "project":
      return run.projectId === subject.projectId;
    case "agent":
      return run.agentId === subject.agentId;
    case "environment":
      // A run with `environment` UNSET is NOT governed. `runs.environment` is
      // optional (ADR-002) and absent on every run recorded before it existed, so
      // "unset matches everything" would silently apply an environment rule to
      // the entire historical corpus.
      return typeof run.environment === "string" && run.environment === subject.environment;
  }
}

// ===========================================================================
// PART E — THE OBSERVATION
// ===========================================================================

/**
 * Reduce one run's events to the facts {@link foldPolicyOutcome} needs, for ONE
 * policy.
 *
 * PURE and TOTAL: never throws on any payload, including deliberately hostile
 * ones. An unrecognised shape is undecidable, which withholds; it is never an
 * exception that would take down an evaluation mid-scan, and never a silent skip.
 */
export function observeRunAgainstPolicy(
  policy: PolicyDefinition,
  events: readonly PolicyObservableEvent[],
  facts: PolicyRunReadFacts,
): PolicyRunObservation {
  const rule = policy.rule;
  const proofs: PolicyViolationProof[] = [];
  const undecidableSequenceNumbers: number[] = [];
  const undecidableKinds: PolicyNotEvaluableKind[] = [];
  const undecidableReasons: string[] = [];
  const undecidableRemedies: string[] = [];
  let relevantEventsSeen = 0;
  let undecidableCount = 0;
  let operationsMatched = 0;
  let orderingCaveat = false;

  const undecidable = (seq: number, m: Extract<RuleMatch, { match: "undecidable" }>): void => {
    undecidableCount += 1;
    if (undecidableSequenceNumbers.length < MAX_VIOLATION_PROOFS) {
      undecidableSequenceNumbers.push(seq);
      undecidableKinds.push(m.kind);
      undecidableReasons.push(m.because);
      undecidableRemedies.push(m.wouldBeEvaluableBy);
    }
  };

  // A POLICY THAT DOES NOT GOVERN MATCHES NOTHING, so the event loop is not
  // entered at all — and the REASON is the contract's, obtained by asking the
  // primitive rather than re-deriving it.
  //
  // THE READING IS `policyGoverns`, THE CONTRACT'S, AND NOT `enabled === true`.
  // That is the same repair as D6 and as rule-versus-policy, a third time: a
  // second spelling of "does this policy count" is how the two halves diverge,
  // and `actIsForbiddenBy` and `matchRecordedEventAgainstPolicy` both read it
  // through this function. A local `enabled === true` here would be a fourth.
  //
  // THE GUARD WAS FREE, THEN WAS NOT, AND IS NOW EXPLICIT. It used to come from
  // `actIsForbiddenBy(policy, …)`. Moving to a rule-only primitive — the right
  // move for D6 — took it away silently, because A RULE HAS NO ENABLED FLAG, and
  // a disabled policy produced a violation. Contracts has since moved the
  // primitive to take the whole POLICY; this guard stays anyway, because a
  // property that survives only as a side effect of which overload you call is a
  // property waiting to be lost.
  //
  // THE PROBE USES AN EMPTY PAYLOAD ON PURPOSE: a governance failure is decided
  // before the payload is looked at, so it cannot be mistaken for evidence about
  // the run — and if the primitive ever stopped short-circuiting, this would
  // surface as `deciding_field_unreadable` rather than as a false clear.
  const governs = policyGoverns(policy);
  let governanceFailure: PolicyRunObservation["governanceFailure"] = null;
  if (!governs) {
    const probe = matchRecordedEventAgainstPolicy(
      { type: RULE_DECIDING_EVIDENCE[policy?.rule?.kind]?.eventType ?? "tool.call", payload: {} },
      policy,
    );
    governanceFailure =
      probe.match === "undecidable"
        ? { kind: probe.kind, because: probe.because, wouldBeEvaluableBy: probe.wouldBeEvaluableBy }
        : {
            kind: "policy_unreadable",
            because: "this policy does not govern, and the reason could not be classified",
            wouldBeEvaluableBy: "inspect the stored policy row directly",
          };
  }

  for (const ev of governs ? events : []) {
    if (ev.provenance?.source === "otel") orderingCaveat = true;

    // AN UNMAPPED SPAN MAY HAVE BEEN ANY OPERATION. It is a span the mapper could
    // not interpret, so it is undecidable for EVERY rule kind — not merely for
    // the kind whose deciding event type it is not. Counting it as irrelevant is
    // what let coverage read complete over a run whose every act was an
    // unreadable span. Handled HERE rather than in the contract's matcher because
    // it is a fact about OUR ingest pipeline (ADR-007), not about the rule.
    if (ev.type === "otel.span.unmapped") {
      undecidable(ev.sequenceNumber, {
        match: "undecidable",
        kind: "deciding_field_unreadable",
        because:
          `event ${ev.sequenceNumber} is an unmapped OpenTelemetry span, so the operation it represents ` +
          "is unknown and may be the one this policy forbids",
        wouldBeEvaluableBy:
          "re-record this run through the first-party SDK path, or extend the span mapper to cover this span kind",
      });
      continue;
    }

    // A LOSSY DERIVED EVENT'S MAPPED FIELDS MAY BE MISSING OR APPROXIMATE — and
    // so may its TYPE, which is why this is checked BEFORE the matcher rather
    // than left to it: the one route that survives an unreadable PAYLOAD (the
    // event type alone) does not survive an unreliable TYPE. The sibling engine
    // over the same rows, helpers/divergence.ts, raises `LOSSY_DERIVED_EVENT` for
    // exactly this, and two engines answering one question must not disagree.
    const lossy = ev.provenance?.source === "otel" && ev.provenance.lossy === true;
    if (lossy && ev.type === RULE_DECIDING_EVIDENCE[rule.kind]?.eventType) {
      relevantEventsSeen += 1;
      undecidable(ev.sequenceNumber, {
        match: "undecidable",
        kind: "deciding_field_unreadable",
        because:
          `event ${ev.sequenceNumber} was derived from an OpenTelemetry span and is flagged lossy, so its ` +
          "mapped fields — including the one that decides this policy — may be missing or approximate",
        wouldBeEvaluableBy: "re-record this run through the first-party SDK path",
      });
      continue;
    }

    // THE ONE PRIMITIVE. Extraction, interpretation and matching in one call, so
    // this boundary cannot perform half of it — see PART D.
    //
    // IT TAKES THE WHOLE POLICY, NOT THE RULE, and that is the §N3 fix at the
    // contract level: `enabled` lives on the definition, so a primitive given a
    // bare rule STRUCTURALLY CANNOT honour it — which is how the pre-flight
    // (`actIsForbiddenBy(policy, …)`) and the retrospective evaluator came to
    // disagree, and a disabled policy produced a violation. The asymmetry is why
    // it was worth a rebase rather than a caller-side filter: a false all-clear
    // is MISSED, but a false violation is ACTED ON — someone rolls back a deploy
    // on a rule that was explicitly switched off.
    //
    // The `governs` guard above is kept as well. The two do different jobs: the
    // primitive stops a disabled policy producing a VIOLATION, and the fold's own
    // branch stops it producing an ALL-CLEAR. A property that holds only because
    // one caller is careful is the argument this repository rejects everywhere
    // else, and it is what hid D6 for a cycle.
    const recorded: RecordedActEvent = { type: ev.type, payload: ev.payload };
    const m: RuleMatch = matchRecordedEventAgainstPolicy(recorded, policy);

    // `not_relevant` IS SILENT, NOT CLEAN. An `llm.request` says nothing about a
    // tool policy; it is not counted as a relevant event and it clears nothing.
    if (m.match === "not_relevant") continue;
    relevantEventsSeen += 1;

    if (m.match === "undecidable") {
      undecidable(ev.sequenceNumber, m);
      continue;
    }

    // `permitted_by_this_rule` IS THE ONLY BAND THAT CLEARS ANYTHING, and it is
    // deliberately not merged with `not_relevant` above: one means the value was
    // READ and this rule allows it, the other means nothing was read at all.
    if (m.match === "permitted_by_this_rule") continue;

    operationsMatched += 1;
    if (proofs.length < MAX_VIOLATION_PROOFS) {
      proofs.push({
        proves: "forbidden_operation_recorded",
        citedEvent: {
          runId: ev.runId,
          eventId: ev.eventId,
          sequenceNumber: ev.sequenceNumber,
          eventType: ev.type,
          recordedAt: ev.timestamp,
        },
        observedValue: m.observedValue,
        decidedBy: m.decidedBy,
        recordedFact:
          m.decidedBy === "event_type_alone"
            ? `run ${ev.runId} recorded a "${ev.type}" event at sequence ${ev.sequenceNumber}; this policy ` +
              `permits no ${rule.kind === "tool_denied" ? "tool call" : "egress"} whatsoever, so the event ` +
              "type alone decides it and the payload was not consulted"
            : rule.kind === "tool_denied"
              ? `run ${ev.runId} recorded a "tool.call" event at sequence ${ev.sequenceNumber} naming tool "${m.observedValue}", which this policy denies`
              : `run ${ev.runId} recorded an "http.request" event at sequence ${ev.sequenceNumber} to host "${m.observedValue}", which falls under a host this policy denies`,
      });
    }
  }

  return {
    ...facts,
    eventsExamined: events.length,
    relevantEventsSeen,
    undecidableCount,
    undecidableSequenceNumbers,
    undecidableKinds,
    undecidableReasons,
    undecidableRemedies,
    proofs,
    operationsMatched,
    orderingCaveat,
    governanceFailure,
  };
}

/**
 * MAY THIS OBSERVATION LICENSE A SATISFACTION CLAIM ABOUT THE READ?
 *
 * Every clause is POSITIVE — see PART 6.
 *
 * DELIBERATELY NOT THE WHOLE CONDITION FOR `satisfied`: the instrumentation claim
 * is orthogonal and is not a property of the read at all, so folding it in here
 * would make one predicate answer two different questions. The type system
 * enforces that half; this enforces the read half.
 */
export function isPolicyCoverageComplete(o: PolicyRunObservation): boolean {
  return (
    o.runObserved === true &&
    o.logReadComplete === true &&
    o.runIsTerminal === true &&
    o.undecidableCount === 0 &&
    o.crossOrgRowsSkipped === 0
  );
}

// ===========================================================================
// PART F — THE FOLD
// ===========================================================================

function notEvaluable(input: {
  policy: PolicyDefinition;
  runId: string;
  kind: PolicyNotEvaluableKind;
  because: string;
  wouldBeEvaluableBy: string;
}): PolicyNotEvaluable {
  return {
    outcome: "not_evaluable",
    undecidedPolicyId: input.policy.policyId,
    undecidedPolicyRevision: input.policy.revision,
    forRunId: input.runId,
    kind: input.kind,
    notEvaluableBecause: assertNoComplianceClaim(input.because, "notEvaluable/because"),
    wouldBeEvaluableBy: assertNoComplianceClaim(
      input.wouldBeEvaluableBy,
      "notEvaluable/wouldBeEvaluableBy",
    ),
  };
}

/**
 * An outcome for a run the cross-run scan never opened.
 *
 * Exported because the scan must emit one per unopened run WITHOUT fabricating an
 * observation of a run it did not read. Manufacturing an empty
 * `PolicyRunObservation` and folding that would work today and is exactly the
 * shape that later grows a branch reading it as compliance.
 */
export function unopenedRunOutcome(
  policy: PolicyDefinition,
  runId: string,
  reason: "event_budget_exhausted" | "run_budget_exhausted",
): PolicyNotEvaluable {
  return notEvaluable({
    policy,
    runId,
    kind: "run_not_opened",
    because: `run ${runId}'s log was never read: this scan's ${
      reason === "event_budget_exhausted"
        ? "total event budget was spent on earlier runs in the page"
        : "per-page run budget was reached before it"
    }`,
    wouldBeEvaluableBy: `evaluate run ${runId} on its own, which reads up to ${POLICY_MAX_EVENTS_PER_RUN} of its events, or narrow the scan window so fewer runs compete for the same budget`,
  });
}

/** No run is in scope at all. NOT satisfied — an empty set satisfies every prohibition. */
export function noRunsInScopeOutcome(policy: PolicyDefinition): PolicyNotEvaluable {
  return notEvaluable({
    policy,
    runId: "",
    kind: "no_runs_in_scope",
    because:
      "no recorded run falls within this policy's subject and the window asked about, so there was nothing to evaluate it over. An empty set satisfies every prohibition trivially, and a scan pointed at the wrong project, or at an environment nobody deploys to, produces exactly that",
    wouldBeEvaluableBy:
      "check the policy's subject against the runs actually recorded, and widen the window asked about",
  });
}

export interface PolicyFoldInput {
  readonly policy: PolicyDefinition;
  readonly observation: PolicyRunObservation;
  readonly evaluatedAt: number;
}

/**
 * Decide one policy against one run.
 *
 * THE ORDER OF THESE BRANCHES IS THE SAFETY PROPERTY, exactly as in
 * helpers/budget.ts's `foldBreakerState` and helpers/causal_graph.ts's
 * `classifyFrontier`:
 *
 *   1. PROVEN VIOLATION, FIRST AND UNCONDITIONALLY. PART 3's asymmetry in code. A
 *      recorded forbidden operation is a positive fact about a stored row; a
 *      truncated read, an unreadable neighbour and an in-flight run cannot
 *      un-record it.
 *   2. AN UNINTERPRETABLE RULE. After the violation branch — `actIsForbiddenBy`
 *      cannot fire on one, so branch 1 is unreachable for it — and before
 *      everything else, because reporting it as an unreadable POLICY rather than
 *      an unreadable RUN sends the operator to what is actually broken.
 *   3..6. THE NAMED READ FAILURES, each individually redundant with the coverage
 *      predicate and each present so the operator is told WHICH thing went wrong.
 *   7. INSTRUMENTATION — PART 4. Placed last before satisfaction because it is the
 *      one no amount of further reading can fix, so an operator should first be
 *      told about the ones that can.
 *   8. SATISFACTION, through the coverage predicate AND the six-field licence,
 *      whose `instrumentation` field will not accept an `undeclared` claim.
 *   9. `not_evaluable` IS THE FALLTHROUGH. Every path that did not positively
 *      establish something lands here, including any observation field a future
 *      contributor adds without thinking about this function.
 */
export function foldPolicyOutcome(input: PolicyFoldInput): PolicyOutcome {
  const { policy, observation: o } = input;
  const runId = o.runId;
  const rule = policy.rule;

  // 1. PROVEN VIOLATION. First, always.
  if (o.proofs.length > 0) {
    const first = o.proofs[0]!;
    const truncated = o.operationsMatched > o.proofs.length || o.logReadComplete !== true;
    const violated: PolicyViolated = {
      outcome: "violated",
      violatedPolicyId: policy.policyId,
      violatedPolicyRevision: policy.revision,
      violatedRule: rule,
      violatedInRunId: runId,
      provenBy: o.proofs as readonly [PolicyViolationProof, ...PolicyViolationProof[]],
      violationCount: o.operationsMatched,
      violationCountIsFloor: truncated,
      violatedBecause: assertNoExecutionClaim(
        `${policy.rationale} The append-only log for run ${runId} records ${o.operationsMatched} ` +
          `operation(s) this policy forbids${truncated ? " within the part of the log this scan read; there may be more" : ""}. ` +
          `First: ${first.recordedFact}. This states what the log records; it says nothing about what any ` +
          `agent did at runtime, which this product recorded but did not perform.`,
        "foldPolicyOutcome/violated",
      ),
    };
    return violated;
  }

  // 2. THE POLICY DOES NOT GOVERN — it is switched off, or its rule forbids
  //    nothing. Emitted rather than omitted, and it is neither a violation nor
  //    an all-clear: "this control is off" and "this control was checked and
  //    nothing breached it" are the two sentences a compliance surface must
  //    never merge. THAT IS WHY IT IS `not_evaluable` AND NOT A FOURTH BAND —
  //    not_evaluable is the only outcome wrong in NEITHER direction, so A
  //    FAILING SCAN CANNOT BE MADE TO PASS BY SWITCHING ITS POLICIES OFF.
  //
  //    THE KIND AND THE PROSE ARE THE CONTRACT'S, carried on the observation.
  //    Enablement is read before the rule, so a disabled policy with a vacuous
  //    rule says `policy_disabled` rather than sending an operator to fix a rule
  //    on a policy nobody switched on.
  const governance = o.governanceFailure;
  if (governance !== null) {
    return notEvaluable({
      policy,
      runId,
      kind: governance.kind,
      because: governance.because,
      wouldBeEvaluableBy: governance.wouldBeEvaluableBy,
    });
  }

  // 4. THE RUN ITSELF. Aged out under retention, or another org — deliberately
  //    indistinguishable, for the reason helpers/causal_graph.ts PART 6 gives: a
  //    distinguishable "forbidden" is a cross-org existence oracle.
  if (o.runObserved !== true) {
    return notEvaluable({
      policy,
      runId,
      kind: "run_unreadable",
      because: `run ${runId} could not be read, so none of its events were available to this evaluation. Aged out under this organization's retention window (ADR-001), purged, or outside this organization — deliberately indistinguishable`,
      wouldBeEvaluableBy: `check the run id, and whether run ${runId} predates this organization's retention window`,
    });
  }

  // 5. THE READ ENDED SHORT.
  if (o.logReadComplete !== true) {
    return notEvaluable({
      policy,
      runId,
      kind: "log_not_read_to_end",
      because: `the read of run ${runId} ended after ${o.eventsExamined} event(s) without reaching the end of its log, so the unread remainder may contain the very operation this policy forbids`,
      wouldBeEvaluableBy: `evaluate run ${runId} on its own, which reads up to ${POLICY_MAX_EVENTS_PER_RUN} events, or reduce the run's event count below that ceiling`,
    });
  }

  // 6. THE RUN HAS NOT FINISHED. Its next event may be the violation.
  if (o.runIsTerminal !== true) {
    return notEvaluable({
      policy,
      runId,
      kind: "run_in_flight",
      because: `run ${runId} has recorded no terminal event, so it is still producing evidence (Event Log Rule 5). Nothing forbidden appears in the log SO FAR, which is a statement about a prefix of the log rather than about the run`,
      wouldBeEvaluableBy: `re-evaluate once run ${runId} records run.completed or run.failed`,
    });
  }

  // 7. ROWS WE COULD NOT ACCOUNT FOR, then a deciding field we could not read.
  if (o.crossOrgRowsSkipped > 0) {
    return notEvaluable({
      policy,
      runId,
      kind: "scan_contaminated",
      because: `${o.crossOrgRowsSkipped} row(s) read during this evaluation did not belong to this organization and were discarded, so the set of events examined is not the set run ${runId}'s log contains`,
      wouldBeEvaluableBy:
        "re-run the evaluation; a non-zero count here means a stored row is mis-stamped and should be investigated directly",
    });
  }
  if (o.undecidableCount > 0) {
    const seqs = o.undecidableSequenceNumbers;
    // THE KIND AND THE PROSE ARE THE CONTRACT'S, not re-derived here. A second
    // classification of the same condition is the drift that produced D6.
    const kind = o.undecidableKinds[0] ?? "deciding_field_unreadable";
    const because = o.undecidableReasons[0] ?? "the deciding value could not be read";
    const remedy = o.undecidableRemedies[0] ?? "re-record this run through the first-party SDK path";
    return notEvaluable({
      policy,
      runId,
      kind,
      because:
        `${o.undecidableCount} event(s) in run ${runId}` +
        `${seqs.length > 0 ? ` (first at sequence ${seqs[0]})` : ""} could not be decided against this ` +
        `policy: ${because}. Each of those events may or may not be the operation this policy forbids`,
      wouldBeEvaluableBy: remedy,
    });
  }

  // 8. INSTRUMENTATION — PART 4. The one that reading more cannot fix.
  const claim: InstrumentationClaim = o.instrumentation ?? { claims: "undeclared" };
  if (!instrumentationCovers(claim, rule)) {
    const operation = rule.kind === "tool_denied" ? "tool call" : "HTTP request";
    const builder = rule.kind === "tool_denied" ? "Events.toolCall" : "Events.httpRequest";
    return notEvaluable({
      policy,
      runId,
      kind: "instrumentation_undeclared",
      because:
        `run ${runId}'s log was read end to end and records nothing this policy forbids — but every one of ` +
        `those facts is about the READING of the log. A ${operation} is recorded only when the caller invokes ` +
        `the SDK's manual \`${builder}\` builder; nothing proxies, wraps or intercepts it, so an operation ` +
        `performed outside the recorded path leaves no row whose absence anything can detect. ` +
        (claim.claims === "complete"
          ? "This run's agent version has declared complete recording, but not for this operation class"
          : "This run's agent version has declared nothing about its own recording"),
      wouldBeEvaluableBy: `declare complete ${operation} instrumentation on this agent version, naming the mechanism (for example "all outbound HTTP goes through recordedFetch()") — a falsifiable claim that a later recorded operation outside that path would contradict`,
    });
  }

  // 9. SATISFACTION. Through the coverage predicate AND the six-field licence.
  if (isPolicyCoverageComplete(o)) {
    const licence: SatisfactionLicence = {
      proves: "complete_log_read_found_nothing",
      runId,
      forPolicyId: policy.policyId,
      logReadComplete: true,
      payloadsAllReadable: true,
      runIsTerminal: true,
      crossOrgRowsSkipped: 0,
      forbiddenOperationsFound: 0,
      // TYPED `CompleteInstrumentationClaim`. Branch 7 has already established the
      // arm through `instrumentationCovers`, so this narrowing is sound — and if
      // branch 7 were ever removed, THIS LINE WOULD STOP COMPILING rather than
      // silently licensing an undeclared agent.
      instrumentation: claim as CompleteInstrumentationClaim,
      eventsExamined: o.eventsExamined,
      scannedAt: input.evaluatedAt,
    };
    const satisfied: PolicySatisfied = {
      outcome: "satisfied",
      satisfiedPolicyId: policy.policyId,
      satisfiedPolicyRevision: policy.revision,
      satisfiedInRunId: runId,
      establishedBy: licence,
      satisfiedBecause: assertNoExecutionClaim(
        `All ${o.eventsExamined} event(s) of this run, which has recorded a terminal event, were read to the ` +
          `end of the log, every relevant payload was legible, and none records an operation this policy ` +
          `forbids. This rests on agent version ${licence.instrumentation.claimedByAgentVersionId}'s own ` +
          `declaration that its recording is complete for ${licence.instrumentation.coversOperations.join(", ")}; ` +
          `if that declaration is wrong, this result is wrong and nothing in the log would show it.`,
        "foldPolicyOutcome/satisfied",
      ),
    };
    return satisfied;
  }

  // 10. FALLTHROUGH.
  return notEvaluable({
    policy,
    runId,
    kind: "coverage_unestablished",
    because: `this evaluation of run ${runId} did not positively establish every condition a satisfaction licence requires, and did not identify which one was missing`,
    wouldBeEvaluableBy: `re-evaluate run ${runId} once it has recorded a terminal event, reading its log unfiltered to completion`,
  });
}

// ===========================================================================
// PART G — THE REPORT
//
// THE SCALE RULING. Policy evaluation over many runs has the same
// one-`.paginate()`-per-execution constraint as everything else, and it hits a
// harder wall than the budget breaker did: THERE IS NO DENORMALIZED FIELD ON
// `runs` THAT CAN ANSWER A POLICY QUESTION.
//
// ADDING ONE WAS CONSIDERED AND REFUSED, for two reasons, the second decisive:
//
//   IT WOULD INHERIT THE SAME BLINDNESS. A write-time `toolsUsed` is extracted
//     from the same payload externalization destroys, so it would be silent about
//     exactly the events this design exists to flag — while LOOKING like
//     coverage.
//   IT WOULD BE ABSENT ON EVERY EXISTING RUN, and `undefined` is
//     indistinguishable from "this run used no tools". That is PART 6's trap
//     applied to the entire historical corpus at once, on the one surface where a
//     false all-clear is the whole risk.
//
// So the cross-run surface is a bounded scan that REPORTS ITS OWN COVERAGE PER
// RUN, and every run the budget did not reach is emitted as an explicit
// `run_not_opened` outcome NAMING THE RUN, never omitted. A run missing from a
// compliance report reads as a run with nothing to report.
// ===========================================================================

export interface PolicyScanReport extends PolicyEvaluation {
  readonly counts: PolicyOutcomeCounts;
  /**
   * The report's own account of its limits, guarded against compliance
   * vocabulary. A caller rendering only the counts still cannot present zero
   * violations as an all-clear, because this sentence travels with them.
   */
  readonly coverageStatement: string;
}

/**
 * Assemble the report.
 *
 * THE COUNTS ARE THREE, NEVER ONE, and they come from the contract's
 * {@link countPolicyOutcomes}, which returns all three or nothing — there is
 * deliberately no `countSatisfied` anywhere. A bare `satisfiedCount` in an API
 * response, or pasted into a security questionnaire, is the attestation figure
 * with every safeguard above it stripped off. There is likewise no rate,
 * percentage or ratio: a denominator that mixes runs we cleared with runs we
 * could not open is exactly the arithmetic that turns `not_evaluable` into
 * `satisfied`, and it would do it silently in a chart.
 *
 * THREE COVERAGE FACTS TRAVEL IN THE SENTENCE, each because it is invisible
 * otherwise:
 *
 *   RETENTION HORIZON  ADR-001 lets an org's window purge runs, so a report over
 *     a period whose runs have aged out finds nothing, honestly and uselessly.
 *     A COMPLIANCE REPORT THAT GOES CLEAR BY ELAPSED TIME is the failure that
 *     happens without anyone deciding it.
 *   ORDERING CAVEAT    On an OTel-derived run a cited `sequenceNumber` is ARRIVAL
 *     order, not occurrence order (ADR-007). Forwarded rather than swallowed.
 *   ENVIRONMENT IS A SELF-REPORT  A rule scoped to `environment: "production"` is
 *     scoped to a label the client set on its own runs. "No violations in
 *     production" really means "none among runs that SAID they were production".
 */
export function buildPolicyScanReport(input: {
  outcomes: readonly PolicyOutcome[];
  scan: PolicyEvaluationScan;
  evaluatedAt: number;
}): PolicyScanReport {
  const outcomes = input.outcomes.slice(0, MAX_POLICY_OUTCOMES);
  const counts = countPolicyOutcomes(outcomes);
  const s = input.scan;

  const statement =
    `${s.policiesInScope} policy(ies) govern this subject and ${s.policiesEvaluated} produced an outcome, ` +
    `over ${s.runsRead} of ${s.runsInScope} run(s) in scope. ` +
    `${counts.violated} recorded a forbidden operation; ${counts.satisfied} were established satisfied; ` +
    `${counts.notEvaluable} could not be settled either way. ` +
    (s.evaluationTruncated ? "This evaluation ended on a server ceiling, so every count is a floor. " : "") +
    (s.retentionHorizon !== null
      ? `Runs started before ${new Date(s.retentionHorizon).toISOString()} have aged out under this organization's retention window (ADR-001) and are not in this report at all. `
      : "") +
    (s.orderingCaveat
      ? "At least one run here was derived from OpenTelemetry spans, so the sequence numbers cited are ARRIVAL order rather than occurrence order (ADR-007). "
      : "") +
    (s.subject.appliesTo === "environment"
      ? `This subject is the environment label "${s.subject.environment}", which a client SETS on its own runs — so this describes runs that SAID they were that environment, not runs that were. `
      : "") +
    "An outcome counted as unsettled is one this evaluation could not decide, which is not the same as one with nothing to report.";

  return {
    evaluatedAt: input.evaluatedAt,
    outcomes,
    scan: s,
    counts,
    // Guarded: this is the sentence most likely to be quoted, and the one a
    // well-meaning edit would turn into "no violations found".
    coverageStatement: assertNoComplianceClaim(statement, "buildPolicyScanReport/coverageStatement"),
  };
}

// ===========================================================================
// PART H — THE PRE-FLIGHT LISTING
//
// Returns the governing DEFINITIONS and never a verdict, for exactly the reason
// convex/budget_gate.ts returns a `BreakerSnapshot` and never an allow/deny: only
// the caller knows its own risk posture, and a backend that returned "proceed"
// would be making that decision on behalf of a customer whose risk it does not
// know — while giving a compromised deployment one field to flip. A prohibition
// is decidable IN THE CLIENT from the definition and the proposed act (contracts'
// `decidePreflight`), so the SDK asks once per shelf life and answers locally.
//
// AND THE LIMIT: an answer here is ADVISORY. A caller that ignores it produces a
// run this system will record in full, and the recording is the point — PART 2.
// Contracts encodes that as `PREFLIGHT_STILL_RECORDS`, total over every preflight
// answer, so no branch of the client-side decision can imply otherwise.
// ===========================================================================

export function buildPolicySnapshot(input: {
  policies: readonly PolicyDefinition[];
  listingTruncated: boolean;
  subject: PolicySubject;
  answeredAt: number;
}): PolicySnapshot {
  return {
    evaluatedAt: input.answeredAt,
    // FROM THE CONTRACT, not chosen here: a server stating a longer shelf life
    // than the client's ceiling is silently overruled and has no idea how stale
    // its answers are in the field. helpers/budget.ts records the same correction.
    shelfLifeMs: POLICY_SNAPSHOT_SHELF_LIFE_MS,
    subject: input.subject,
    policies: input.policies.slice(0, MAX_POLICIES_PER_ORG),
    policiesInScope: input.policies.length,
    listingTruncated: input.listingTruncated,
  };
}
