// ---------------------------------------------------------------------------
// DECLARATIVE POLICY — "may this agent call that tool?", asked of the record
//
// A policy says a thing must not happen: agent_7 may not call `shell.exec`; no
// run in `production` may egress to `paste.example.com`. This file is the
// AUTHORITATIVE vocabulary (CLAUDE.md, Repo Conventions -> Types) for stating
// that, for evaluating it against recorded runs, and for the one pre-flight
// question the SDK can ask in-process. `convex/` imports it; it does not
// redeclare it.
//
// It is the second feature in this product where the SDK does something other
// than record, and the first whose output is a COMPLIANCE ARTEFACT.
// `budgets.ts` had to keep "the breaker tripped" apart from "the agent
// stopped". This file has a harder version of the same job, because the
// sentence somebody will try to build out of it — "we ran the scan and found no
// violations" — is a statement made to a third party.
//
// Governed by ADR-009 (`docs/adr/009-policy-engine.md`). Read §7 before adding
// anything; it is the list of things this engine cannot know, and it is longer
// than the list of things it can.
//
// ---------------------------------------------------------------------------
// INVARIANT 0 — A POLICY ENGINE INSIDE A RECORDER MUST NEVER REFUSE TO RECORD
//               A VIOLATION. THIS OVERRIDES EVERYTHING ELSE IN THIS FILE.
// ---------------------------------------------------------------------------
//
// THE BREACH IS THE MOST VALUABLE EVENT IN THE LOG. An agent that called the
// forbidden tool is the exact run an engineer needs to open, and the exact run
// a regulator will ask for. A design in which a policy hit causes the event to
// be dropped, suppressed, redacted, or "handled" before ingest turns the
// product's most valuable record into its only missing one — silently, at the
// moment it matters most.
//
// Enforced in three places rather than asserted once:
//
//   1. NOTHING IN THIS FILE SITS ON THE INGEST PATH. Every type here is
//      READ-SIDE. `PolicyEvaluation` is computed over runs already recorded;
//      {@link PolicyPreflightAnswer} is returned to a caller BEFORE an act and
//      has no channel to the recorder at all. There is no `onViolation` hook,
//      no `PolicyAction`, no field a definition could carry that names
//      something to do to an event. A policy in this contract cannot express
//      "and then drop it", because there is nowhere to write it down.
//
//   2. EVERY PREFLIGHT BAND CARRIES `recordRegardless: true`, THE LITERAL TYPE.
//      All six. {@link PREFLIGHT_STILL_RECORDS} is a total table whose VALUE
//      TYPE is the literal `true`, so a seventh band cannot ship without
//      restating the ruling and no future edit can express "do not record".
//
//   3. THE WIRE REFUSES A SUPPRESSION FIELD.
//      {@link FORBIDDEN_SUPPRESSION_FIELDS} is the list a server body may not
//      carry — `dropEvent`, `suppressViolation`, `doNotRecord`. The type system
//      makes them unspellable in OUR code; a JSON body is not typechecked by
//      anyone, and `dropEvent: true` is one keystroke.
//
// ---------------------------------------------------------------------------
// INVARIANT 1 — THE EVIDENTIAL ASYMMETRY RUNS THE OPPOSITE WAY FROM SPEND
// ---------------------------------------------------------------------------
//
// `budgets.ts` had to make `provably_under` — headroom — hard to establish.
// HERE IT IS EXACTLY INVERTED, and for a reason that is not symmetry but logic:
//
//   VIOLATED IS PROVABLE.      An event shows the forbidden call happened. A
//                              POSITIVE FACT in an append-only log, established
//                              by one event. Cheap to construct, and it SHOULD
//                              be — see invariant 0.
//
//   SATISFIED IS ESSENTIALLY   It is the claim that the act appears NOWHERE.
//   UNPROVABLE.                Absence of evidence is not evidence of absence,
//                              and over an incomplete log it is not even weak
//                              evidence.
//
// TWO THINGS MAKE THAT BITE IN PRODUCTION, AND THE SECOND IS WORSE THAN THE
// FIRST:
//
//   EVENT LOG RULE 3 — a payload over 10 KB is externalised: the event keeps a
//   pointer and the tool name is GONE. A policy about tool NAMES cannot be
//   evaluated over such a run. (A policy denying the OPERATION still can — see
//   {@link ruleIsDecidableFromEventTypeAlone}.)
//
//   THE INSTRUMENTATION GAP — `Events.toolCall` and `Events.httpRequest` are
//   MANUAL BUILDERS. There is no `fetch` interception, no monkey-patching, no
//   auto-instrumentation anywhere in `packages/sdk/src`. AN AGENT THAT
//   EGRESSES WITHOUT CALLING THE BUILDER PRODUCES A RUN THAT IS BYTE-IDENTICAL,
//   TO THIS ENGINE, TO A RUN THAT TOUCHED NO NETWORK AT ALL.
//
// The second is the deeper limit and it is the one ADR-009 §7.1 calls the
// sharpest thing in the document. Every field a coverage proof could gain by
// READING HARDER is a property of the read — complete, terminal, no gaps, no
// externalised fields — and every one of them is satisfiable over a run that
// egressed through an uninstrumented `fetch`. A COMPLETE READ OF AN INCOMPLETE
// RECORDING PROVES NOTHING ABOUT THE WORLD. There is no sixth field available
// by looking, because the missing fact was never written.
//
// SO THE FACT IS CLAIMED, NOT INFERRED — the ADR-008 §5.1b device, which this
// codebase already uses to turn an empty tool list into a checkable assertion
// via `{ declared: 'none' }`. An agent that declares "every HTTP call I make
// goes through the recorder" has said something FALSIFIABLE: a single recorded
// egress that contradicts it is a lie somebody can point at. An agent that says
// nothing has not made a claim, and absence in its log means nothing.
//
// {@link PolicyCoverageProof} therefore requires a
// {@link CompleteInstrumentationClaim} — a sixth field, and the only one that
// is not a property of the read. WITHOUT A DECLARATION, `satisfied` IS
// UNREACHABLE. That is not a gap: it is the same honest unreachability as
// `provably_under` for a counter-backed budget, and it is the correct state of
// the product until agents start declaring.
//
// So `satisfied` gets the strongest barrier this codebase has built:
//
//   1. IT IS LICENSED BY A ONE-MEMBER UNION. {@link SatisfactionLicence} has
//      exactly one member. There is precisely one way to establish
//      satisfaction; adding a second is a deliberate edit to a single visible
//      line, and every consumer that narrows on `proves` becomes a compile
//      error until it handles the new member. (`budgets.ts` reached for this
//      shape as `SpendReconciliation` and did not name it; naming the extension
//      point is the improvement.)
//
//   2. THE LICENCE CARRIES FIVE LITERAL-TYPED FIELDS PLUS THE CLAIM. A
//      truncated read, an in-flight run, an externalised deciding field,
//      contaminated rows, or a found violation each make it UNSPELLABLE — a
//      compile error, not a convention. `OriginProof` in `causality.ts` needed
//      two; this needs five, because there are five ways to have not looked —
//      and then one more field for the way looking cannot help at all.
//
//   3. THE LICENCE IS PER-RUN AND THE ROLL-UP LIST IS NON-EMPTY BY TYPE. A
//      policy evaluated over ZERO runs cannot be `satisfied` — it does not
//      compile. Vacuous truth is fine in logic and a catastrophe in compliance:
//      "no run violated it" over an empty set is what a scan of the wrong
//      project produces, and it reads identically to a real all-clear.
//
// ---------------------------------------------------------------------------
// INVARIANT 2 — `not_evaluable` MAY NEVER RENDER AS `satisfied`, BECAUSE
//               SOMEBODY WILL ATTEST TO IT — AND A COUNT IS HOW IT ESCAPES
// ---------------------------------------------------------------------------
//
// The fifth outing for `proven | speculative | unknown` (`divergence.ts`),
// `observed | hypothesised | unmeasured` (`fleet_health.ts`), `recorded |
// inferred | unread` (`causality.ts`) and `tripped | armed | undetermined`
// (`budgets.ts`). The stakes have moved again: a wrong spend figure costs money
// and is caught by reconciliation, but A COMPLIANCE SURFACE REPORTING "no
// violations" WHEN IT COULD NOT LOOK does not stay inside the building.
// Somebody signs a questionnaire. An attestation is a statement to a third
// party and it is not retractable the way a dashboard is.
//
// ADR-009 §4.2 found where the safeguards leak, and it is worth stating plainly
// because it is not where the type system was pointing:
//
//   THE PROOF DOES NOT AGGREGATE. THE PROSE DOES NOT AGGREGATE. THE DISCLAIMER
//   ABOUT UNINSTRUMENTED CODE PATHS DOES NOT AGGREGATE. THE WORD DOES.
//
// `satisfiedCount: 12` in an API response carries none of the five literals,
// none of the instrumentation claim, and none of the prose. It is the
// attestation figure with every safeguard above it stripped off, and it is one
// field name away at all times. So:
//
//   1. THE THREE OUTCOMES SHARE NO FIELD BUT THE DISCRIMINANT. Not a policy id
//      (`violatedPolicyId` / `satisfiedPolicyId` / `undecidedPolicyId`), not a
//      run id, not a timestamp name, not a message. `outcome.policyId` DOES NOT
//      COMPILE on any of them, so no renderer prints one under another's
//      heading by forgetting to narrow.
//
//   2. A SATISFIED COUNT CANNOT EXIST ALONE. {@link PolicyOutcomeCounts} has
//      all three counts as REQUIRED fields, so `satisfiedCount` is
//      unconstructible without `notEvaluableCount` and `violatedCount` beside
//      it. There is no function in this contract that returns a satisfied count
//      by itself, and `satisfiedCount` as a standalone wire field is REFUSED by
//      {@link FORBIDDEN_COMPLIANCE_CLAIM_FIELDS} along with every rate and
//      percentage spelling of the same idea.
//
//   3. THERE IS NO ONE-WORD NAME FOR THE GOOD OUTCOME, ANYWHERE. The verdict is
//      `"no_violation_and_every_policy_was_evaluable"`. It is long on purpose.
//      `clean`, `compliant`, `passed` and `ok` are shorter, wrong, and exactly
//      the word somebody puts on a badge — so they are not merely absent from
//      the type, they are REFUSED AT THE WIRE.
//
//   4. THE SENTENCE IS COMPOSED, NEVER TRANSMITTED.
//      {@link policyOutcomeStatement} and {@link policyVerdictStatement} are the
//      only prose a surface should render, and every good-news branch states its
//      own scope inline.
//
// ---------------------------------------------------------------------------
// INVARIANT 3 — WE ADVISE, WE DO NOT PREVENT
// ---------------------------------------------------------------------------
//
// Inherited from `budgets.ts` invariant 1 with the nouns changed. Three facts,
// two of them ours:
//
//   OWNED   "A policy forbids this act."  Established from a stored definition.
//   OWNED   "The SDK advised against it." A fact about our own return value.
//   NEVER   "The call was prevented."     A fact about a process we do not
//                                         control. NOTHING here may assert it.
//
// There is {@link wasAdvisedAgainstBySdk} and deliberately no
// `wasCallPrevented`, because there is no honest implementation of one. And the
// pre-flight decides A DESCRIPTION, NOT AN ACT (ADR-009 §7.7): nothing binds the
// tool name a caller passed to the call it subsequently makes. That gap is
// unclosable from inside a library, and it is why the recorded run is the only
// thing that can ever contradict the description.
//
// Negative tests asserting all of the above — via `@ts-expect-error`, which
// fails the build if any conflation ever BECOMES legal — live at
// `tests/unit/policy_satisfaction_barrier.test.ts`,
// `tests/unit/policy_claim_boundary.test.ts` and
// `tests/unit/policy_cli_exit_codes.test.ts`.
// ---------------------------------------------------------------------------

// ===========================================================================
// PART A — THE DEFINITION. A statement of what must not happen.
// ===========================================================================

/**
 * WHAT A POLICY FORBIDS.
 *
 * ---------------------------------------------------------------------------
 * THE OPTIONAL LIST IS THE LOAD-BEARING PART, NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 *
 * `deniedTools` ABSENT means "may not call ANY tool". `deniedHosts` ABSENT
 * means "may not egress AT ALL". Those are not shorthand for a long list: they
 * are THE ONLY FORM UNDER WHICH AN EXTERNALISED PAYLOAD STILL PROVES A
 * VIOLATION.
 *
 * When a rule names specific tools, an externalised `tool.call` is
 * `not_evaluable` — the name is gone and the call might have been permitted.
 * When the rule denies the operation, THE EVENT TYPE ALONE DECIDES IT, and the
 * type survives externalisation (`ExternalizedPayload.originalType`). Which
 * tool it was cannot change the answer, because nothing is permitted.
 *
 * This is ADR-008's `{ declared: 'none' }` insight reached from the other side:
 * a COMPLETE claim converts an absence into a decidable fact. So some policies
 * are evaluable over exactly the runs that defeat others, and the two kinds of
 * policy have genuinely different coverage.
 *
 * THE BOUNDARY IS `deniedTools === undefined`, NEVER "some tools are denied".
 * Against a rule naming even one tool the engine must still decline on an
 * externalised payload. A contributor who widens
 * {@link ruleIsDecidableFromEventTypeAlone} to cover partial lists has
 * manufactured proofs.
 */
export type PolicyRule =
  | {
      readonly kind: "tool_denied";
      /** ABSENT means every tool is denied — see this type's header. Present means exactly these. */
      readonly deniedTools?: readonly string[];
    }
  | {
      readonly kind: "egress_denied";
      /**
       * ABSENT means all egress is denied. Present means these hosts and their
       * subdomains — matched by {@link hostFallsUnder}, which checks the LABEL
       * BOUNDARY, because raw suffix matching is how `myevil.example` slips
       * past a rule about `evil.example`.
       */
      readonly deniedHosts?: readonly string[];
    };

/** The frozen rule vocabulary, as a runtime array, for a schema validator to be BUILT FROM rather than retyped. */
export const POLICY_RULE_KINDS = ["tool_denied", "egress_denied"] as const;

export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];

/**
 * WHERE THE ANSWER LIVES IN THE RECORD, for one rule kind.
 *
 * A TOTAL `Record`, so a new rule kind is a COMPILE ERROR here until somebody
 * has said what in the record would establish it. A prohibition with no deciding
 * evidence evaluates to `not_evaluable` forever, which reads as a broken product
 * rather than as the unfinished feature it is.
 */
export const RULE_DECIDING_EVIDENCE: Record<
  PolicyRuleKind,
  { readonly eventType: string; readonly payloadField: string }
> = {
  tool_denied: { eventType: "tool.call", payloadField: "name" },
  egress_denied: { eventType: "http.request", payloadField: "url" },
};

/**
 * CAN THIS RULE BE DECIDED FROM THE EVENT TYPE ALONE — i.e. even when Event Log
 * Rule 3 has externalised the payload?
 *
 * TRUE ONLY FOR A RULE THAT DENIES THE OPERATION ITSELF. See {@link PolicyRule}
 * for why the boundary is exactly `undefined` and not "a short list", and
 * ADR-009 §4.3 for the rule and its limit stated together.
 *
 * MUST NEVER THROW: it runs on a stored row nothing has vouched for.
 *
 * @param rule - anything at all; `false` is the safe answer.
 * @returns whether an externalised payload of the right event type still proves
 *   a violation of this rule.
 */
export function ruleIsDecidableFromEventTypeAlone(rule: PolicyRule): boolean {
  if (!isRecordLike(rule)) return false;
  if (rule.kind === "tool_denied") return rule.deniedTools === undefined;
  if (rule.kind === "egress_denied") return rule.deniedHosts === undefined;
  return false;
}

/**
 * WHO A POLICY APPLIES TO. Always resolved WITHIN one org — there is no
 * cross-org subject (CLAUDE.md Tenancy Rules).
 *
 * `environment` IS A LABEL THE CLIENT CHOSE, NOT A TRUST BOUNDARY (ADR-009
 * §7.3). ADR-002 defines it as a free-form string, stamped from the API key or
 * supplied by the caller, opaque to the backend. A rule scoped to
 * `environment: "production"` is scoped to a SELF-REPORT, and an agent that
 * mislabels its environment is outside every rule scoped that way with nothing
 * detecting it. Any surface rendering "no violations in production" is really
 * rendering "no violations among runs that SAID they were production", and
 * {@link policyVerdictStatement} says so rather than leaving each surface to
 * remember.
 */
export type PolicySubject =
  | { readonly appliesTo: "org" }
  | { readonly appliesTo: "project"; readonly projectId: string }
  | { readonly appliesTo: "agent"; readonly agentId: string }
  | { readonly appliesTo: "environment"; readonly environment: string };

/** The frozen subject vocabulary, as a runtime array. */
export const POLICY_SUBJECT_KINDS = ["org", "project", "agent", "environment"] as const;

/**
 * A POLICY. A DEFINITION, NOT A MEASUREMENT.
 *
 * It says nothing about what happened — that is a {@link PolicyOutcome}.
 *
 * DEFINITIONS ARE PRIVILEGED WRITES OWNED BY `convex/`. This shape exists so the
 * CLI, the web UI and the Convex mutation are built from one vocabulary; nothing
 * in the SDK or CLI may write a policy except by calling the admin-gated,
 * audited route (CLAUDE.md Event Log Rule 6).
 */
export interface PolicyDefinition {
  readonly policyId: string;
  readonly orgId: string;
  readonly name: string;
  /**
   * Bumped on every rule/subject change, and STAMPED ON EVERY OUTCOME.
   *
   * A finding that does not name the revision it was judged under is a finding
   * nobody can reproduce: the rule may have been three tools wider last Tuesday,
   * and "this run was clean" is a different claim under each version of it.
   */
  readonly revision: number;
  readonly rule: PolicyRule;
  readonly subject: PolicySubject;
  /**
   * REQUIRED: why this act is forbidden, in prose. "SOC2 CC6.1 — no shell
   * execution from customer-facing agents."
   *
   * Carried into every outcome this policy produces, so a violation on a screen
   * at 3am states its own justification rather than a policy id somebody has to
   * go look up. Same forcing function as `ApproximateSpend.approximateBecause`.
   */
  readonly rationale: string;
  /**
   * A disabled policy governs nothing. NOT the same as a policy that was
   * evaluated and satisfied, and an evaluation must not list it among those it
   * checked.
   */
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** Bound on how many policies one org may define. Beyond this, a scan is not a scan. */
export const MAX_POLICIES_PER_ORG = 50;

/** Bound on an evaluation's outcome list. */
export const MAX_POLICY_OUTCOMES = 200;

// ===========================================================================
// PART B — THE INSTRUMENTATION CLAIM. The one fact reading cannot supply.
// ===========================================================================

/**
 * WHAT AN AGENT CLAIMS ABOUT ITS OWN INSTRUMENTATION.
 *
 * ---------------------------------------------------------------------------
 * THE POINT OF THIS TYPE, WHICH IS NOT OBVIOUS AND IS THE DEEPEST THING IN THE
 * FEATURE
 * ---------------------------------------------------------------------------
 *
 * Every other field in {@link PolicyCoverageProof} is a property of THE READ:
 * we read the whole log, the run finished, no payload was externalised, no rows
 * were contaminated, nothing forbidden was found. ALL FIVE ARE SATISFIABLE OVER
 * A RUN THAT EGRESSED TO A FORBIDDEN HOST THROUGH AN UNINSTRUMENTED `fetch`.
 * `Events.httpRequest` and `Events.toolCall` are manual builders; there is no
 * interception anywhere in `packages/sdk/src`.
 *
 * So a complete read of an incomplete recording proves nothing about the world,
 * and NO AMOUNT OF READING HARDER FIXES IT — the missing fact was never
 * written. This is the budget lesson one level out: there the sum was exact and
 * only COVERAGE was short; here the log read can be perfect and the
 * INSTRUMENTATION short, and unlike coverage that shortfall is invisible from
 * inside the log entirely.
 *
 * THE ONLY REPAIR IS A CLAIM. ADR-008 §5.1b established the device for exactly
 * this shape: `{ declared: 'none' }` turns an empty tool list from an absence
 * into a checkable assertion. An agent that declares "every HTTP call I make
 * goes through the recorder" has said something FALSIFIABLE — one recorded
 * egress outside the declared path contradicts it, and somebody can point at
 * that. An agent that says nothing has not made a claim, and absence in its log
 * means nothing at all.
 *
 * `undeclared` IS THE DEFAULT AND IT IS NOT A FAILURE. It is the honest state
 * of every agent in this product today, and it makes `satisfied` unreachable —
 * exactly as `couldUnderstateBy: null` makes `provably_under` unreachable for a
 * counter-backed budget. The right response is for agents to declare, not for
 * this type to soften.
 *
 * NOTE WHAT IS UNAFFECTED: `violated`. A recorded forbidden call proves a breach
 * regardless of what else went unrecorded, and no instrumentation claim is
 * required to establish one. That asymmetry is what makes this liveable —
 * invariant 0 keeps working while invariant 1 stays honest.
 */
export type InstrumentationClaim =
  /**
   * THE AGENT CLAIMS COMPLETE RECORDING FOR THE NAMED OPERATION CLASSES.
   *
   * Falsifiable, attributable, and dated. A claim is about an AGENT VERSION
   * (immutable per CLAUDE.md Core Entities), because "we route all egress
   * through the recorder" is a property of a build, not of an org.
   */
  | {
      readonly claims: "complete";
      /**
       * WHICH OPERATION CLASSES THE CLAIM COVERS. A claim about tool calls says
       * nothing about egress, and licensing an `egress_denied` satisfaction from
       * a tool-call claim is the conflation this field exists to prevent —
       * audited by {@link evaluationClaimContradictions}, because a JSON body is
       * not typechecked.
       *
       * NON-EMPTY BY TYPE: a claim that covers nothing is not a claim.
       */
      readonly coversOperations: readonly [PolicyRuleKind, ...PolicyRuleKind[]];
      /**
       * REQUIRED: HOW. "All outbound HTTP goes through `recordedFetch()`;
       * `node:http` is not imported outside it." The sentence a reviewer checks
       * the claim against, and the sentence a falsification quotes back.
       */
      readonly mechanism: string;
      /** The immutable agent version making the claim. */
      readonly claimedByAgentVersionId: string;
      readonly claimedAt: number;
    }
  /**
   * NOTHING HAS BEEN CLAIMED. The default, the current state of every agent, and
   * NOT a claim of incompleteness — it is the absence of a claim, which is a
   * different and weaker thing.
   */
  | { readonly claims: "undeclared" };

/**
 * The one arm of {@link InstrumentationClaim} that can license a coverage proof.
 *
 * Named as its own type so {@link PolicyCoverageProof} can require it
 * structurally: an `undeclared` claim is not assignable here, so a coverage
 * proof for an agent that has declared nothing DOES NOT COMPILE.
 */
export type CompleteInstrumentationClaim = Extract<InstrumentationClaim, { claims: "complete" }>;

/**
 * Does this claim cover the operation class this rule is about?
 *
 * THE CHECK THAT KEEPS A TOOL-CALL DECLARATION FROM LICENSING AN EGRESS
 * ALL-CLEAR. The type system requires A claim; only this function establishes it
 * is the RIGHT one, and the wire audit runs it because a JSON body can pair any
 * claim with any rule.
 *
 * MUST NEVER THROW.
 *
 * @param claim - anything at all; `false` is a valid answer.
 * @param rule - the rule whose satisfaction is being licensed.
 * @returns whether the claim speaks to this rule's operation class.
 */
export function instrumentationCovers(claim: InstrumentationClaim, rule: PolicyRule): boolean {
  if (!isRecordLike(claim) || !isRecordLike(rule)) return false;
  if (claim.claims !== "complete") return false;
  const covers = claim.coversOperations;
  if (!Array.isArray(covers) || covers.length === 0) return false;
  return (covers as readonly unknown[]).includes(rule.kind);
}

// ===========================================================================
// PART C — EVIDENCE. Cheap in the positive direction, and it should be.
// ===========================================================================

/** A stored row this engine can point at. Every field is checkable by opening the event. */
export interface PolicyEventCitation {
  readonly runId: string;
  readonly eventId: string;
  /**
   * Ordering within the run (CLAUDE.md Event Log Rule 4).
   *
   * ON AN OTEL-DERIVED RUN THIS IS ARRIVAL ORDER, NOT OCCURRENCE ORDER
   * (ADR-007). Anywhere a policy result cites a POSITION, that caveat must be
   * forwarded rather than swallowed — see {@link PolicyScanCoverage.orderingCaveat}.
   */
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly recordedAt: number;
}

/**
 * WHICH OF THE THREE ROUTES ESTABLISHED THIS VIOLATION.
 *
 * Recorded rather than inferred, because the three have different strengths and
 * a reader who cannot tell them apart cannot judge the finding:
 *
 *   `inline_payload`     the deciding field was read from the event's own
 *                        payload. The ordinary case and the strongest.
 *   `event_type_alone`   the rule denies the OPERATION, so the event type
 *                        decides it and the payload was never needed. The case
 *                        that survives externalisation — see
 *                        {@link ruleIsDecidableFromEventTypeAlone}.
 *   `verified_artifact`  the payload was externalised and the evaluator FETCHED
 *                        the artifact and verified its SHA-256. Expensive, and
 *                        therefore optional — skipping it costs a
 *                        `not_evaluable`, never a false `satisfied`.
 */
export type ViolationDecidedBy = "inline_payload" | "event_type_alone" | "verified_artifact";

/**
 * ONE RECORDED FACT THAT VIOLATES THE RULE.
 *
 * `observedValue` is the discriminating value read out of the payload, or `null`
 * IN THE DENY-THE-OPERATION CASE where the event type alone is sufficient.
 * `null` rather than a placeholder string, precisely so a reader cannot mistake
 * a sentinel for a tool name — the `null`-is-not-`0` discipline this codebase
 * has now applied in five files.
 *
 * WHY THIS TYPE IS CHEAP TO CONSTRUCT, DELIBERATELY: invariant 0. A violation
 * that were as hard to establish as a satisfaction would be a violation nobody
 * reports, and the whole point of a flight recorder is that the breach is the
 * record's most valuable row.
 */
export interface PolicyViolationProof {
  readonly proves: "forbidden_operation_recorded";
  readonly citedEvent: PolicyEventCitation;
  /** The value read, or `null` when the event TYPE alone decided it. Never a sentinel string. */
  readonly observedValue: string | null;
  readonly decidedBy: ViolationDecidedBy;
  /**
   * REQUIRED, and only for `decidedBy: "verified_artifact"`: the SHA-256 the
   * evaluator VERIFIED (CLAUDE.md Event Log Rule 3). A violation read out of a
   * blob nobody checksummed is a violation read out of whatever that storage key
   * happens to hold today. Audited at the wire.
   */
  readonly verifiedChecksum?: string;
  /** Past tense, about a stored row, openable and checkable. */
  readonly recordedFact: string;
}

/**
 * THE ONLY CONSTRUCTOR OF A `satisfied` OUTCOME, AND IT IS DELIBERATELY HARD TO
 * BUILD.
 *
 * ---------------------------------------------------------------------------
 * FIVE LITERAL TYPES, EACH A DIFFERENT WAY OF NOT HAVING LOOKED — AND ONE FIELD
 * THAT IS NOT ABOUT LOOKING AT ALL
 * ---------------------------------------------------------------------------
 *
 *   logReadComplete: true          we read the whole run, not a page of it
 *   payloadsAllReadable: true      no deciding field was externalised past the
 *                                  10 KB threshold (Event Log Rule 3). ONE
 *                                  externalised tool name makes this
 *                                  unspellable, which is the correct and
 *                                  frequent outcome — unless the rule denies the
 *                                  operation, in which case the type sufficed
 *                                  and nothing was lost.
 *   runIsTerminal: true            the run FINISHED (Event Log Rule 5). A run
 *                                  still in flight may yet do the forbidden
 *                                  thing; "no violation so far" is not a
 *                                  finding, it is a stopwatch.
 *   crossOrgRowsSkipped: 0         the read touched no row it could not account
 *                                  for (CLAUDE.md Tenancy Rules).
 *   forbiddenOperationsFound: 0    nothing matched. A proof that found something
 *                                  cannot establish satisfaction, and will not
 *                                  compile.
 *
 * `false` is not assignable to `true` and `1` is not assignable to `0`, so each
 * of those is a COMPILE ERROR rather than a validator someone can forget.
 *
 * AND THEN `instrumentation`, WHICH IS NOT LIKE THE OTHERS. It is the only field
 * that is not a property of the read, and it is here because all five of the
 * others are satisfiable over a run that egressed through an uninstrumented
 * `fetch`. See {@link InstrumentationClaim} — this is the whole argument, and
 * this field is where it becomes a type error rather than a paragraph.
 *
 * `undeclared` is not assignable to {@link CompleteInstrumentationClaim}, so
 * TODAY THIS PROOF IS UNCONSTRUCTIBLE FOR EVERY AGENT IN THE PRODUCT. That is
 * the honest answer, not a defect.
 */
export interface PolicyCoverageProof {
  readonly proves: "complete_log_read_found_nothing";
  readonly runId: string;
  /** The policy this read was performed for. A read that decided a different rule proves nothing about this one. */
  readonly forPolicyId: string;
  /** LITERAL `true`. A paged or truncated read cannot be spelled here. */
  readonly logReadComplete: true;
  /** LITERAL `true`. An externalised deciding field cannot be spelled here. */
  readonly payloadsAllReadable: true;
  /** LITERAL `true`. An in-flight run cannot be spelled here. */
  readonly runIsTerminal: true;
  /** LITERAL `0`. A read that touched unaccountable rows cannot be spelled here. */
  readonly crossOrgRowsSkipped: 0;
  /** LITERAL `0`. A proof that found a violation cannot establish satisfaction. */
  readonly forbiddenOperationsFound: 0;
  /**
   * THE SIXTH FIELD, AND THE ONLY ONE READING CANNOT SUPPLY. Requires the
   * COMPLETE arm — an agent that has declared nothing cannot be given an
   * all-clear. See {@link InstrumentationClaim}.
   */
  readonly instrumentation: CompleteInstrumentationClaim;
  /** How many events were examined. Reporting only; the literals above are what license the claim. */
  readonly eventsExamined: number;
  readonly scannedAt: number;
}

/**
 * THE LICENCE FOR SATISFACTION — A ONE-MEMBER UNION, ON PURPOSE.
 *
 * ---------------------------------------------------------------------------
 * WHY A UNION WITH ONE MEMBER IS NOT THE SAME AS AN ALIAS
 * ---------------------------------------------------------------------------
 *
 * Mechanically it behaves like one. What it does that an alias does not is make
 * the EXTENSION POINT a single, visible, greppable line. There is exactly one
 * way to establish that a policy was satisfied; the day somebody believes there
 * is a second — a signed attestation from an external scanner, a sampled read
 * with stated coverage, a proof over a fetched artifact — they must add a member
 * HERE, in the file whose header explains why satisfaction is nearly unprovable,
 * and every consumer narrowing on `proves` becomes a compile error until it
 * handles the new member.
 *
 * The alternative is what happens without it: a second proof shape appears
 * elsewhere, structurally compatible, and starts licensing `satisfied` without
 * anybody re-reading the argument for why that is hard.
 *
 * NOTHING ELSE MAY BE PASSED WHERE A LICENCE IS REQUIRED, and
 * {@link PolicyViolationProof} in particular is not assignable: `proves:
 * "forbidden_operation_recorded"` is not `proves:
 * "complete_log_read_found_nothing"`, so the cheap positive proof cannot be
 * recycled into the expensive negative one.
 */
export type SatisfactionLicence = PolicyCoverageProof;

// ===========================================================================
// PART D — THE THREE OUTCOMES, PER RUN. Field-disjoint, so no template
// handles two.
// ===========================================================================

/** Why a policy's status could not be established for a run. Facts about the EVALUATION, never about the agent. */
export type PolicyNotEvaluableKind =
  /**
   * THE INSTRUMENTATION IS UNDECLARED, so absence in this log means nothing.
   *
   * THE NEW ONE, AND TODAY THE UNIVERSAL ONE. Not a defect in the scan: the scan
   * may have been perfect. See {@link InstrumentationClaim} — this is what an
   * unstated assumption of complete recording looks like once it is stated.
   */
  | "instrumentation_undeclared"
  /**
   * A payload carrying the discriminating field was externalised past 10 KB
   * (Event Log Rule 3), and the evaluator did not fetch the artifact.
   *
   * NOT REACHED for a rule that denies the operation itself — there the event
   * type sufficed. See {@link ruleIsDecidableFromEventTypeAlone}.
   */
  | "evidence_externalized"
  /**
   * THE DECIDING FIELD IS PRESENT AND UNINTERPRETABLE. A `host` this contract
   * cannot normalise, a URL that does not parse, a `name` that is not a string.
   *
   * ITS OWN KIND, SEPARATE FROM `evidence_externalized` AND FROM ABSENCE,
   * because the three have different remedies — fetch the artifact, fix the
   * emitter, fix the SDK version — and because collapsing any of them into "we
   * read it and it was fine" is the exact shape ADR-009 §5 is about. A VALUE
   * PRESENT BUT UNREADABLE IS EVIDENCE WE COULD NOT READ, NOT EVIDENCE OF
   * COMPLIANCE.
   *
   * This kind exists because it was missing and the absence was a live false
   * all-clear: an unparseable URL counted as a legible field, matched against
   * nothing, and cleared the run.
   */
  | "deciding_field_unreadable"
  /**
   * THE POLICY IS DISABLED, so it governs nothing and nothing about this run can
   * be graded against it.
   *
   * `not_evaluable` RATHER THAN A SILENT SKIP, and the direction matters in both
   * senses. A disabled policy must never produce a VIOLATION — a false violation
   * is ACTED ON: somebody rolls back, or blocks a deploy, on a rule that was
   * explicitly turned off. And it must never produce an ALL-CLEAR either, or a
   * scan could be made to pass by disabling the policies it was failing. Landing
   * on `not_evaluable` is the only band that is wrong in neither direction.
   *
   * A disabled policy should not be in scope at all; this kind exists for when
   * one reaches the evaluator anyway, because "the guarantee holds because the
   * one caller in tree happens to be careful" is not a guarantee.
   */
  | "policy_disabled"
  /** The scan stopped on a ceiling before observing the end of the log. */
  | "log_not_read_to_end"
  /** The run has not reached a terminal event: it may still record the violation. */
  | "run_in_flight"
  /** The run itself could not be read. Deleted under retention (ADR-001), or another org — indistinguishable. */
  | "run_unreadable"
  /** The scan read rows it could not account for. */
  | "scan_contaminated"
  /** The cross-run scan never opened this run at all. */
  | "run_not_opened"
  /**
   * NO RUN IS IN SCOPE AT ALL. Nothing was evaluated over.
   *
   * NOT `satisfied`. An empty set satisfies every prohibition vacuously, and a
   * scan pointed at the wrong project produces exactly that. Its own kind so an
   * operator sees "nothing to evaluate" rather than a green tick.
   */
  | "no_runs_in_scope"
  /** The policy row was read but is malformed — a rule this contract cannot interpret. */
  | "policy_unreadable"
  /** Fallthrough: nothing positive was established. */
  | "coverage_unestablished";

/** The frozen not-evaluable vocabulary, as a runtime array, so the wire check is BUILT FROM the type. */
export const POLICY_NOT_EVALUABLE_KINDS: readonly PolicyNotEvaluableKind[] = [
  "instrumentation_undeclared",
  "evidence_externalized",
  "deciding_field_unreadable",
  "policy_disabled",
  "log_not_read_to_end",
  "run_in_flight",
  "run_unreadable",
  "scan_contaminated",
  "run_not_opened",
  "no_runs_in_scope",
  "policy_unreadable",
  "coverage_unestablished",
];

/**
 * A POLICY WAS BROKEN, AND THE RECORD SHOWS IT.
 *
 * IT CLAIMS: the operation the rule forbids appears in the recorded log, at the
 * events in `provenBy`.
 *
 * IT DOES NOT CLAIM that the act was prevented, that anybody was notified, or
 * that the agent was stopped. See invariant 3.
 *
 * Never assignable to or from the other two outcomes: distinct `outcome`
 * literal, and NO FIELD IN COMMON with either.
 */
export interface PolicyViolated {
  /** Discriminant. The structural barriers are `violatedPolicyId` and `provenBy`. */
  readonly outcome: "violated";
  /** DELIBERATELY NOT NAMED `policyId` — the other two bands spell it differently. */
  readonly violatedPolicyId: string;
  /** The revision judged under. A finding that does not name it cannot be reproduced. */
  readonly violatedPolicyRevision: number;
  readonly violatedRule: PolicyRule;
  readonly violatedInRunId: string;
  /** NON-EMPTY BY TYPE. A violation with no citation is an assertion, not a finding. */
  readonly provenBy: readonly [PolicyViolationProof, ...PolicyViolationProof[]];
  /** Violations observed. A FLOOR whenever the read was bounded — see the flag below. */
  readonly violationCount: number;
  /**
   * True when the scan stopped early: THERE MAY BE MORE, NEVER FEWER.
   *
   * A floor rendered as a total is the `hopsBeforeLoss`-versus-`hopsToOrigin`
   * defect in `causality.ts`, and here it points the safe way — under-counting a
   * breach is bad, but it can never turn a breach into an all-clear.
   */
  readonly violationCountIsFloor: boolean;
  readonly violatedBecause: string;
}

/**
 * A POLICY WAS EVALUATED OVER A FINISHED RUN, READ END TO END, WHOSE AGENT HAS
 * DECLARED COMPLETE INSTRUMENTATION FOR THIS OPERATION CLASS, AND NO VIOLATION
 * APPEARS.
 *
 * READ THE PRECONDITIONS, BECAUSE THEY ARE THE CLAIM. This is not "we did not
 * find a problem". `establishedBy` is a {@link SatisfactionLicence}, whose six
 * fields — five literal-typed, one a falsifiable agent claim — do not compile
 * otherwise.
 *
 * NOTE WHAT `satisfiedBecause` MAY AND MAY NOT SAY. It is guarded at the wire by
 * {@link FORBIDDEN_COMPLIANCE_CLAIM_FIELDS}' sibling check on prose: a producer
 * that writes "compliant" into it has smuggled the badge back in through the one
 * field no type checks.
 *
 * Never assignable to or from the other two outcomes.
 */
export interface PolicySatisfied {
  /** Discriminant. The structural barriers are `satisfiedPolicyId` and `establishedBy`. */
  readonly outcome: "satisfied";
  /** DELIBERATELY NOT NAMED `policyId` — see {@link PolicyViolated}. */
  readonly satisfiedPolicyId: string;
  readonly satisfiedPolicyRevision: number;
  readonly satisfiedInRunId: string;
  /** THE LICENCE. See {@link PolicyCoverageProof}; it is the whole of the claim. */
  readonly establishedBy: SatisfactionLicence;
  /** Past tense, naming the limit inline. Never a word from {@link FORBIDDEN_COMPLIANCE_CLAIM_FIELDS}. */
  readonly satisfiedBecause: string;
}

/**
 * THE POLICY'S STATUS COULD NOT BE ESTABLISHED FOR THIS RUN.
 *
 * The third band, for the same reason `divergence.ts`, `fleet_health.ts`,
 * `causality.ts` and `budgets.ts` each have one — and here it is THE UNIVERSAL
 * BAND TODAY, because no agent declares its instrumentation.
 *
 * IT IS NOT `satisfied`. That conflation is the failure this file exists to
 * prevent, and it is worse here than anywhere it has appeared before: "we could
 * not look" rendered as "no violations" is a sentence somebody forwards to an
 * auditor.
 */
export interface PolicyNotEvaluable {
  /** Discriminant. The structural barriers are `undecidedPolicyId`, `notEvaluableBecause` and `wouldBeEvaluableBy`. */
  readonly outcome: "not_evaluable";
  /** DELIBERATELY NOT NAMED `policyId` — see {@link PolicyViolated}. */
  readonly undecidedPolicyId: string;
  readonly undecidedPolicyRevision: number;
  readonly forRunId: string;
  readonly kind: PolicyNotEvaluableKind;
  /** REQUIRED. Guarded at the wire: it may not read as an all-clear. */
  readonly notEvaluableBecause: string;
  /**
   * REQUIRED: what would decide it, as an action — "declare complete egress
   * instrumentation on this agent version", "fetch artifact art_31 and
   * re-evaluate", "wait for run_9 to reach a terminal event".
   *
   * The difference between a product that says "I cannot tell" and one that says
   * "I cannot tell YET, and here is what to do". A band that reads as a shrug is
   * one people learn to configure around, and configuring around this one means
   * turning it into a green tick.
   */
  readonly wouldBeEvaluableBy: string;
}

/**
 * One policy's status over one run.
 *
 * A single-slot union of three FIELD-DISJOINT types, safe for the reason
 * `ChainTerminus` and `BreakerState` are: it types one slot rather than a list,
 * and it is USELESS UNNARROWED — there is no `policyId`, no run id and no
 * message common to the three, so every access whatsoever forces an `outcome`
 * check, and `o.satisfiedPolicyId ?? o.undecidedPolicyId` is a COMPILE ERROR
 * rather than a code review catch.
 */
export type PolicyOutcome = PolicyViolated | PolicySatisfied | PolicyNotEvaluable;

/**
 * WHICH OUTCOMES ARE AN ALL-CLEAR FOR THEIR OWN POLICY AND RUN, DECLARED ONCE.
 *
 * TOTAL OVER THE UNION'S DISCRIMINANTS, so a fourth band is a compile error here
 * until somebody decides, in one place, whether it is an all-clear. Defaulting
 * by omission is exactly how a new kind of not-having-looked would quietly buy a
 * green tick.
 */
const CLEAN_OUTCOMES: Record<PolicyOutcome["outcome"], boolean> = {
  violated: false,
  satisfied: true,
  not_evaluable: false,
};

/**
 * Was this policy established satisfied for this run?
 *
 * FAILS CLOSED ON AN UNRECOGNISED DISCRIMINANT.
 *
 * DELIBERATELY NOT CALLED `isCompliant`, `isClean` or `passed`. The short words
 * are the ones that end up on badges, and `compliant` is a conclusion about an
 * organisation rather than a fact about one policy over one run.
 *
 * @param outcome - anything at all; `false` is a valid answer.
 * @returns whether this single outcome is an established satisfaction. NEVER throws.
 */
export function isEstablishedSatisfied(outcome: PolicyOutcome): boolean {
  const band = (outcome as { outcome?: unknown })?.outcome;
  return typeof band === "string" && CLEAN_OUTCOMES[band as PolicyOutcome["outcome"]] === true;
}

/**
 * THE SENTENCE A HUMAN READS FOR AN OUTCOME, COMPOSED RATHER THAN TRANSMITTED.
 *
 * The `satisfied` branch STATES ITS OWN PRECONDITIONS in the same sentence —
 * including the instrumentation claim it rests on and the mechanism that claim
 * names — because an operator reading "satisfied" will not supply them, and a
 * compliance reviewer six months later certainly will not.
 *
 * EXHAUSTIVE OVER THE UNION BY CONSTRUCTION: the final branch is reached through
 * a `never` check, so a fourth band without a sentence is a compile error here
 * rather than an unlabelled row on a compliance screen.
 *
 * @param outcome - the outcome to render.
 * @returns a statement about the policy and the record. Never a statement about
 *   prevention, in any branch.
 */
export function policyOutcomeStatement(outcome: PolicyOutcome): string {
  switch (outcome.outcome) {
    case "violated": {
      const first = outcome.provenBy[0];
      const count = outcome.violationCountIsFloor
        ? `at least ${outcome.violationCount}`
        : `${outcome.violationCount}`;
      return (
        `VIOLATED — ${outcome.violatedBecause} Run ${outcome.violatedInRunId} records ${count} matching ` +
        `operation(s); the first is ${JSON.stringify(first?.observedValue)} at event ` +
        `${String(first?.citedEvent?.eventId)}, sequence ${String(first?.citedEvent?.sequenceNumber)} ` +
        `(decided by ${String(first?.decidedBy)}). This states that the act WAS RECORDED. It does not state ` +
        `that anything was prevented, and nothing in this product could have prevented it.`
      );
    }
    case "satisfied": {
      const licence = outcome.establishedBy;
      const claim = licence?.instrumentation;
      return (
        `NO VIOLATION FOUND in run ${outcome.satisfiedInRunId} — ${String(licence?.eventsExamined)} event(s) ` +
        `examined, log read to the end, run terminal, every deciding field legible. THIS RESTS ON A CLAIM THE ` +
        `AGENT MADE, NOT ON SOMETHING WE OBSERVED: agent version ${String(claim?.claimedByAgentVersionId)} ` +
        `declares complete recording for ${String(claim?.coversOperations?.join(", "))} — ` +
        `"${String(claim?.mechanism)}". If that declaration is wrong, this result is wrong, and nothing in the ` +
        `log would show it. ${outcome.satisfiedBecause}`
      );
    }
    case "not_evaluable":
      return (
        `NOT EVALUABLE [${outcome.kind}] — policy ${outcome.undecidedPolicyId} was NOT checked over run ` +
        `${outcome.forRunId}, and this is NOT an all-clear. ${outcome.notEvaluableBecause} To decide it: ` +
        `${outcome.wouldBeEvaluableBy}`
      );
    default: {
      // Exhaustiveness: a fourth band must be given a sentence here.
      const unreachable: never = outcome;
      return String(unreachable);
    }
  }
}

// ===========================================================================
// PART E — THE ROLL-UP. Where the honesty is spent, per ADR-009 §4.2.
// ===========================================================================

/**
 * COUNTS PER STATE, AND ALL THREE ARE REQUIRED FIELDS.
 *
 * ---------------------------------------------------------------------------
 * THIS INTERFACE EXISTS TO MAKE A BARE `satisfiedCount` UNCONSTRUCTIBLE
 * ---------------------------------------------------------------------------
 *
 * A count is the one form in which this vocabulary leaves the type system. The
 * proof does not aggregate, the prose does not aggregate, the instrumentation
 * disclaimer does not aggregate — THE WORD DOES. `satisfiedCount: 12` in an API
 * response or pasted into a security questionnaire is the attestation figure
 * with every safeguard above it stripped off.
 *
 * So there is no type in this contract that carries a satisfied count alone, and
 * no function that returns one. `notEvaluable` and `violated` are REQUIRED
 * siblings, so the figure cannot be emitted without the two numbers that make it
 * legible — and in this product today, `notEvaluable` is the large one.
 *
 * WHAT THIS TYPE CANNOT DO, AND WHAT NO LAYER ABOVE IT MAY ADD: a rate, a
 * percentage, or a ratio with `notEvaluable` in the denominator. Those spellings
 * are refused at the wire by {@link FORBIDDEN_COMPLIANCE_CLAIM_FIELDS}. A rollup
 * may report counts per state; it may never report a VERDICT WORD meaning
 * "compliant", because no such verdict is derivable from the states beneath it.
 */
export interface PolicyOutcomeCounts {
  readonly violated: number;
  readonly satisfied: number;
  /** REQUIRED, and in this product today it is the large one. */
  readonly notEvaluable: number;
}

/**
 * Count the outcomes, all three at once.
 *
 * THE ONLY COUNTING FUNCTION IN THIS CONTRACT, and it returns all three or
 * nothing. There is deliberately no `countSatisfied`.
 *
 * MUST NEVER THROW.
 *
 * @param outcomes - anything at all; unreadable elements are counted in none of
 *   the three, which is why {@link PolicyEvaluationScan} carries its own totals.
 * @returns the three counts.
 */
export function countPolicyOutcomes(outcomes: readonly PolicyOutcome[]): PolicyOutcomeCounts {
  let violated = 0;
  let satisfied = 0;
  let notEvaluable = 0;
  for (const outcome of soundElements<PolicyOutcome>(outcomes)) {
    if (outcome.outcome === "violated") violated += 1;
    else if (outcome.outcome === "satisfied") satisfied += 1;
    else if (outcome.outcome === "not_evaluable") notEvaluable += 1;
  }
  return { violated, satisfied, notEvaluable };
}

/**
 * What the evaluation actually covered.
 *
 * Same posture as `CausalScan`, `FleetHealthScan` and `BreakerScan`: the server
 * STATES its incompleteness in a field rather than refusing, and the gate decides
 * that an incomplete evaluation is not an all-clear.
 */
export interface PolicyEvaluationScan {
  /** Echoed. A server that evaluated a different subject answered a different question. */
  readonly subject: PolicySubject;
  /** How many ENABLED policies govern this subject. */
  readonly policiesInScope: number;
  /** How many produced an outcome for every run in scope. */
  readonly policiesEvaluated: number;
  /** How many recorded runs the subject covers within the window asked about. */
  readonly runsInScope: number;
  /** How many were actually opened. Less than `runsInScope` means every `satisfied` is narrower than it looks. */
  readonly runsRead: number;
  /** True when the evaluation stopped on a server ceiling: every count above is a floor. */
  readonly evaluationTruncated: boolean;
  /**
   * THE RETENTION HORIZON, epoch ms, or `null` when the org has no retention
   * window.
   *
   * A COVERAGE FACT AND IT MUST BE NAMED IN THE RESULT (ADR-009 §7.5). ADR-001
   * permits an org's opt-in window to purge runs — the sole sanctioned exception
   * to "events are never deleted" — so a report over a period whose runs have
   * aged out finds nothing, honestly and uselessly. THE STATE WHERE A COMPLIANCE
   * REPORT GOES CLEAN BY ELAPSED TIME is the one that will happen without anyone
   * deciding it, and a horizon nobody printed is how.
   *
   * `null` is NOT `0`: `null` means no window is configured, and a `0` would mean
   * everything has aged out.
   */
  readonly retentionHorizon: number | null;
  /**
   * True when any run in scope was OTel-derived, so `sequenceNumber` on its
   * citations is ARRIVAL order rather than occurrence order (ADR-007).
   *
   * Forwarded rather than swallowed: anywhere a policy result cites a position,
   * this caveat travels with it.
   */
  readonly orderingCaveat: boolean;
}

/**
 * EVERY POLICY GOVERNING A SUBJECT, EVALUATED OVER RECORDED RUNS.
 *
 * DERIVED, NEVER SOURCE OF TRUTH (CLAUDE.md Event Log Rule 2): computed at query
 * time from policies and the event log. Recompute it; do not store it back. A
 * stored compliance result is one that keeps being true after the log it
 * summarised has changed.
 */
export interface PolicyEvaluation {
  /** Server clock when the policies were evaluated, epoch ms. */
  readonly evaluatedAt: number;
  /** One outcome per (policy, run) pair evaluated. Bounded by {@link MAX_POLICY_OUTCOMES}. */
  readonly outcomes: readonly PolicyOutcome[];
  /** REQUIRED. What the evaluation covered — see {@link PolicyEvaluationScan}. */
  readonly scan: PolicyEvaluationScan;
}

/**
 * THE VERDICT OVER A WHOLE EVALUATION. FOUR-VALUED, AND THE NAMES ARE THE
 * BARRIER.
 *
 * A boolean here would be the compliance badge this file exists to prevent. Even
 * three values would not be enough, because "no policy governs this subject" and
 * "every policy was checked and none was broken" are what a misconfigured scan
 * and a real all-clear produce, and they must never be the same value.
 */
export type PolicyVerdict =
  /** At least one policy was broken, and the record shows it. */
  | "violations_found"
  /**
   * NO POLICY GOVERNS THIS SUBJECT. Nothing was checked because there was
   * nothing to check.
   *
   * ITS OWN BAND, for the reason `AllowedNoBudgetGoverns` is: this is what a
   * DELETED, DISABLED OR MIS-SCOPED policy set looks like, and an org that lost
   * its policies in a bad migration would otherwise show a clean, growing
   * all-clear count while having no coverage whatsoever.
   */
  | "no_policy_governs_this_subject"
  /**
   * SOMETHING WAS NOT LOOKED AT. Any `not_evaluable` outcome, any unevaluated
   * policy, any unread run, a truncated scan, or a body that could not be
   * trusted.
   *
   * THE UNIVERSAL VERDICT TODAY, because no agent declares its instrumentation.
   */
  | "evaluation_incomplete"
  /**
   * THE GOOD OUTCOME, AND ITS NAME IS LONG ON PURPOSE.
   *
   * There is no shorter spelling available anywhere in this contract, because
   * every shorter spelling is a word somebody would put on a badge, and a badge
   * does not carry "over the runs we read, in the window we asked about, on the
   * agent's own declaration that it records what it does".
   */
  | "no_violation_and_every_policy_was_evaluable";

/**
 * WHICH VERDICT IS AN ALL-CLEAR, DECLARED ONCE.
 *
 * TOTAL OVER {@link PolicyVerdict}, so a fifth verdict is a compile error until
 * classified. Exactly one entry is `true`, and it is the one with the long name.
 */
const ALL_CLEAR_VERDICTS: Record<PolicyVerdict, boolean> = {
  violations_found: false,
  no_policy_governs_this_subject: false,
  evaluation_incomplete: false,
  no_violation_and_every_policy_was_evaluable: true,
};

/**
 * Is this verdict the one an attestation could rest on?
 *
 * FAILS CLOSED ON AN UNRECOGNISED VERDICT.
 *
 * @param verdict - anything at all; `false` is a valid answer.
 * @returns whether every policy in scope was evaluated and none was broken.
 *   NEVER throws.
 */
export function isAllClear(verdict: PolicyVerdict): boolean {
  return typeof verdict === "string" && ALL_CLEAR_VERDICTS[verdict] === true;
}

/**
 * THE VERDICT RULE, IN ONE PLACE, FOR EVERY SURFACE THAT REPORTS ONE.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE, AND WHY EACH STEP IS WHERE IT IS
 * ---------------------------------------------------------------------------
 *
 *  1. AN ESTABLISHED VIOLATION WINS OVER EVERYTHING, INCLUDING A DEFECT
 *     ELSEWHERE IN THE BODY. Checked FIRST, and this ordering is INVARIANT 0 in
 *     executable form: a violation is a positive fact and nothing makes it less
 *     true. Gating it on whole-body trustworthiness would mean a typo in an
 *     unrelated field ERASES a real breach — the most expensive possible way to
 *     be careful. See {@link establishedViolations}.
 *
 *  2. AN UNTRUSTWORTHY BODY IS `evaluation_incomplete`. Not an all-clear, and
 *     not a violation either — we know nothing.
 *
 *  3. ANY `not_evaluable`, ANY UNEVALUATED POLICY, ANY UNREAD RUN, OR A
 *     TRUNCATED SCAN -> `evaluation_incomplete`.
 *
 *  4. ZERO POLICIES IN SCOPE -> `no_policy_governs_this_subject`. Checked AFTER
 *     incompleteness, because "we could not read the policy list" and "the
 *     policy list is empty" are different and only the second is this band.
 *
 *  5. OTHERWISE the all-clear — which by construction means every policy
 *     produced a `satisfied` outcome over every run, each licensed by a
 *     {@link PolicyCoverageProof} carrying an agent's instrumentation claim.
 *
 * MUST NEVER THROW: an exception in a compliance path is a result nobody wrote a
 * meaning for.
 *
 * @param evaluation - anything at all.
 * @returns one of four verdicts. Pair with {@link isAllClear} and
 *   {@link policyVerdictStatement}.
 */
export function computePolicyVerdict(evaluation: PolicyEvaluation): PolicyVerdict {
  try {
    // STEP 1 — a violation survives a defect anywhere else. Invariant 0.
    if (establishedViolations(evaluation).length > 0) return "violations_found";

    if (!isRecordLike(evaluation)) return "evaluation_incomplete";
    if (policyEvaluationRefusals(evaluation).length > 0) return "evaluation_incomplete";

    const scan = evaluation.scan as unknown as Record<string, unknown>;
    const outcomes = soundElements<PolicyOutcome>(evaluation.outcomes);

    // A malformed element is not an absent one; it is the strongest ground there
    // is for refusing to call this a complete answer.
    if (indexedElements<PolicyOutcome>(evaluation.outcomes).some((o) => o === null)) {
      return "evaluation_incomplete";
    }
    if (scan["evaluationTruncated"] !== false) return "evaluation_incomplete";
    for (const key of ["policiesInScope", "policiesEvaluated", "runsInScope", "runsRead"] as const) {
      if (!isCount(scan[key])) return "evaluation_incomplete";
    }
    if (scan["policiesEvaluated"] !== scan["policiesInScope"]) return "evaluation_incomplete";
    // AN UNREAD RUN NARROWS EVERY `satisfied` IN THE BODY. The outcomes may each
    // be individually well-licensed and the evaluation still not cover the
    // subject somebody asked about.
    if (scan["runsRead"] !== scan["runsInScope"]) return "evaluation_incomplete";
    if (outcomes.some((o) => !isEstablishedSatisfied(o))) return "evaluation_incomplete";

    // STEP 4 — nothing governs this. Distinguished from step 3 above.
    if (scan["policiesInScope"] === 0) return "no_policy_governs_this_subject";
    // Policies in scope but no outcome for any of them is a contradiction the
    // refusals should have caught. Fails closed rather than trusting that.
    if (outcomes.length === 0) return "evaluation_incomplete";

    return "no_violation_and_every_policy_was_evaluable";
  } catch {
    return "evaluation_incomplete";
  }
}

/**
 * THE VIOLATIONS A REPORT MAY RELY ON, EVEN IN A BODY WITH DEFECTS ELSEWHERE.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPING IS ONE-DIRECTIONAL, AND THE ASYMMETRY IS INVARIANT 0
 * ---------------------------------------------------------------------------
 *
 * `budgets.ts` learned this as `establishedTrip`: gating on the WHOLE refusal
 * list means one malformed sibling field erases a genuine, evidence-backed
 * finding. Here the finding being erased is A BREACH.
 *
 * So only the VIOLATION outcome survives a defect elsewhere:
 *
 *   A VIOLATION survives, because reporting a well-evidenced breach is never the
 *   permissive reading. The worst case is that we report a breach while some
 *   other part of the evaluation was garbage — and the breach is still in the
 *   log.
 *
 *   SATISFACTION DOES NOT survive. A `satisfied` outcome in a body with any
 *   refusal still fails the verdict, because "this policy says there is nothing
 *   here and something else in the response is malformed" is exactly the
 *   situation where the malformed part might be the violation.
 *
 * A violation is impugned by a finding whose PATH POINTS INSIDE ITS OWN OUTCOME,
 * or by a claim contradiction naming its policy. A truncated scan, a sibling
 * outcome, and the retention horizon are none of those.
 *
 * MUST NEVER THROW.
 *
 * @param evaluation - anything at all.
 * @returns every violated outcome a report may rely on. Possibly empty.
 */
export function establishedViolations(evaluation: PolicyEvaluation | null): PolicyViolated[] {
  try {
    if (!isRecordLike(evaluation)) return [];
    const unusable = evaluationUnusableFields(evaluation as PolicyEvaluation);
    const contradictions = evaluationClaimContradictions(evaluation as PolicyEvaluation);
    const established: PolicyViolated[] = [];
    for (const [index, outcome] of indexedElements<PolicyOutcome>(
      (evaluation as PolicyEvaluation).outcomes
    ).entries()) {
      if (outcome === null || outcome.outcome !== "violated") continue;
      const policyId = outcome.violatedPolicyId;
      if (typeof policyId !== "string" || policyId.length === 0) continue;
      // Non-empty by type in our code; a JSON body can still ship an empty
      // array, and a violation citing nothing is an accusation.
      if (soundElements<PolicyViolationProof>(outcome.provenBy).length === 0) continue;
      const impugned =
        unusable.some((f) => impugnsOutcomeAt(f.path, index)) ||
        contradictions.some((f) => f.at.includes(policyId));
      if (!impugned) established.push(outcome);
    }
    return established;
  } catch {
    return [];
  }
}

/** Does this finding's path point INSIDE `outcomes[index]`, rather than merely mentioning it? */
function impugnsOutcomeAt(path: string, index: number): boolean {
  const anchor = `outcomes[${index}]`;
  // Exact, or a property/element BELOW it. Substring-matching the bare anchor
  // would make `outcomes[1]` impugn `outcomes[10]`.
  return path === anchor || path.includes(`${anchor}.`) || path.includes(`${anchor}[`);
}

/**
 * THE SENTENCE A HUMAN READS FOR A VERDICT, COMPOSED RATHER THAN TRANSMITTED.
 *
 * The all-clear branch STATES ITS OWN SCOPE — how many policies, how many runs,
 * the retention horizon, and that `environment` is a self-report — in the same
 * sentence, because that scope is the difference between a true statement and an
 * attestation nobody can support.
 *
 * EXHAUSTIVE OVER THE UNION BY CONSTRUCTION.
 *
 * @param verdict - the verdict to render.
 * @param evaluation - the evaluation it was computed from, for the counts.
 * @returns a statement that carries its own preconditions.
 */
export function policyVerdictStatement(verdict: PolicyVerdict, evaluation: PolicyEvaluation): string {
  const scan = (evaluation as { scan?: PolicyEvaluationScan })?.scan;
  const unreadable = "an unreadable number of";
  const inScope = isCount(scan?.policiesInScope) ? scan.policiesInScope : unreadable;
  const evaluated = isCount(scan?.policiesEvaluated) ? scan.policiesEvaluated : unreadable;
  const runsInScope = isCount(scan?.runsInScope) ? scan.runsInScope : unreadable;
  const runsRead = isCount(scan?.runsRead) ? scan.runsRead : unreadable;
  const counts = countPolicyOutcomes((evaluation as { outcomes?: readonly PolicyOutcome[] })?.outcomes ?? []);
  const horizon =
    scan?.retentionHorizon === null || scan?.retentionHorizon === undefined
      ? "no retention window is configured, so nothing has aged out"
      : `runs before ${new Date(scan.retentionHorizon).toISOString()} have been purged under the org's retention ` +
        `window (ADR-001) and are in NO result here`;
  const selfReport =
    scan?.subject?.appliesTo === "environment"
      ? ` NOTE: \`environment\` is a label the client chose, not a trust boundary — this covers runs that SAID ` +
        `they were "${scan.subject.environment}".`
      : "";

  switch (verdict) {
    case "violations_found":
      return (
        `VIOLATIONS FOUND. ${establishedViolations(evaluation).length} outcome(s) record a forbidden operation in ` +
        `the log. This is a statement about what WAS RECORDED; it is not a statement that anything was prevented, ` +
        `and it remains true regardless of anything else in this evaluation that could not be read.`
      );
    case "no_policy_governs_this_subject":
      return (
        `NO POLICY GOVERNS THIS SUBJECT — nothing was checked, because there was nothing to check. THIS IS NOT AN ` +
        `ALL-CLEAR. It is also what a deleted, disabled or mis-scoped policy set looks like; if you expected ` +
        `coverage here, the policies are not attached to ${JSON.stringify(scan?.subject ?? null)}.`
      );
    case "evaluation_incomplete":
      return (
        `EVALUATION INCOMPLETE — ${evaluated} of ${inScope} policies evaluated, over ${runsRead} of ` +
        `${runsInScope} runs in scope; ${counts.violated} violated, ${counts.satisfied} satisfied, ` +
        `${counts.notEvaluable} NOT EVALUABLE. SOMETHING WAS NOT LOOKED AT, so this cannot support a statement ` +
        `that no violation occurred. Read the per-run outcomes: each not-evaluable one states what would decide ` +
        `it, and today the most common answer is that the agent has not declared its instrumentation.${selfReport}`
      );
    case "no_violation_and_every_policy_was_evaluable":
      return (
        `NO VIOLATION FOUND, and every one of the ${inScope} policies governing this subject was evaluable over ` +
        `all ${runsInScope} run(s) in scope, each read end to end, each on an agent version that DECLARES ` +
        `complete recording for the relevant operations. THIS CLAIM IS EXACTLY AS WIDE AS THAT SCOPE AND NO ` +
        `WIDER. It rests on the agents' own declarations, which this product cannot verify — if an agent ` +
        `egresses outside its recorded path, nothing here would show it. Coverage: ${horizon}.${selfReport} ` +
        `Quote the scope with the result or do not quote the result.`
      );
    default: {
      const unreachable: never = verdict;
      return String(unreachable);
    }
  }
}

// ===========================================================================
// PART F — THE WIRE GATE. What a body may not carry, and may not contradict.
// ===========================================================================

/**
 * FIELD NAMES A POLICY WIRE BODY MAY NEVER CARRY — THE PREVENTION CLAIMS.
 *
 * Every one asserts something about a process this system does not control: that
 * a call was blocked, that an act was prevented, that a policy was enforced. The
 * type system makes them unspellable in OUR code; a JSON body is not typechecked
 * by anyone, and a backend that adds `prevented: true` in one keystroke would
 * have its claim rendered by every surface that spreads the object.
 *
 * See invariant 3, and `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS` in `budgets.ts`.
 */
export const FORBIDDEN_PREVENTION_CLAIM_FIELDS: readonly string[] = [
  "prevented",
  "wasPrevented",
  "actPrevented",
  "callPrevented",
  "blocked",
  "wasBlocked",
  "callBlocked",
  "denied",
  "wasDenied",
  "enforced",
  "wasEnforced",
  "policyEnforced",
  "stopped",
  "agentStopped",
  "halted",
  "killed",
  "terminated",
  "aborted",
  "refused",
];

/**
 * FIELD NAMES A POLICY WIRE BODY MAY NEVER CARRY — THE COMPLIANCE CLAIMS.
 *
 * ---------------------------------------------------------------------------
 * THE SHORT WORDS ARE THE DANGEROUS ONES, AND SO IS THE BARE COUNT
 * ---------------------------------------------------------------------------
 *
 * This contract has no `clean` and no `compliant`, because the good outcome
 * carries preconditions and a one-word field does not. `compliant: true` in a
 * response body would defeat every barrier in this file in a single keystroke: it
 * renders, it screenshots, it goes into a questionnaire, and no consumer has to
 * have forgotten anything.
 *
 * `attested` and `certified` are here for a sharper reason. Those are words with
 * legal weight and NOTHING IN THIS PRODUCT CAN CONFER THEM.
 *
 * AND `satisfiedCount` AND ITS RATE SPELLINGS ARE HERE FOR THE REASON ADR-009
 * §4.2 FOUND: the proof does not aggregate, the prose does not aggregate, the
 * instrumentation disclaimer does not aggregate — the WORD does. A satisfied
 * figure travelling alone is the attestation figure with every safeguard
 * stripped. In this contract it is unconstructible ({@link PolicyOutcomeCounts}
 * requires all three), and here it is unspellable on the wire as well.
 */
export const FORBIDDEN_COMPLIANCE_CLAIM_FIELDS: readonly string[] = [
  "compliant",
  "isCompliant",
  "nonCompliant",
  "certified",
  "attested",
  "attestation",
  "clean",
  "isClean",
  "cleanCount",
  "allClear",
  "passed",
  "passRate",
  "auditPassed",
  "noViolations",
  "violationFree",
  "verifiedCompliant",
  // The aggregate leak. See this list's header and ADR-009 §4.2.
  "satisfiedCount",
  "satisfiedPercent",
  "satisfiedRate",
  "complianceRate",
  "complianceScore",
];

/**
 * FIELD NAMES A POLICY WIRE BODY MAY NEVER CARRY — THE SUPPRESSION FIELDS.
 *
 * ---------------------------------------------------------------------------
 * INVARIANT 0, ENFORCED AT THE ONE PLACE THE TYPE SYSTEM CANNOT REACH
 * ---------------------------------------------------------------------------
 *
 * This contract gives a policy no way to say "and then drop the event": no
 * action field, no hook, no ingest coupling. That closes the door in OUR code. A
 * JSON body can open it again — a server returning `suppressViolation: true`
 * alongside an outcome would be obeyed by any consumer that spread the object
 * into its own config, and the result is the one outcome this feature must never
 * produce: THE BREACH GOES UNRECORDED.
 *
 * The refusal is not a warning: a body carrying one is not evaluated on at all.
 */
export const FORBIDDEN_SUPPRESSION_FIELDS: readonly string[] = [
  "suppressEvent",
  "suppressViolation",
  "dropEvent",
  "doNotRecord",
  "skipRecording",
  "omitFromLog",
  "blockIngest",
  "redactViolation",
  "excludeFromLog",
];

/**
 * Every field name a policy wire body may not carry, as one list, so the walk has
 * a single source rather than three call sites somebody keeps in step.
 */
export const FORBIDDEN_POLICY_WIRE_FIELDS: readonly string[] = [
  ...FORBIDDEN_PREVENTION_CLAIM_FIELDS,
  ...FORBIDDEN_COMPLIANCE_CLAIM_FIELDS,
  ...FORBIDDEN_SUPPRESSION_FIELDS,
];

/**
 * WORDS A PRODUCER MAY NOT PUT IN PROSE.
 *
 * The prose fields — `notEvaluableBecause`, `satisfiedBecause`, `violatedBecause`
 * — are the one place a producer can smuggle the badge back in past every field
 * name check. "Run was compliant" is a contract-valid string, it renders, and
 * during a review that sentence is what somebody acts on.
 *
 * Matched case-insensitively on WORD BOUNDARIES, so `compliant` is caught and
 * `non-compliance-window` is not mangled into a false positive.
 */
export const FORBIDDEN_COMPLIANCE_PROSE = /\b(compliant|compliance|certified|attested|audit[- ]?passed|all[- ]?clear)\b/i;

/**
 * The forbidden claim in this prose, or `null`.
 *
 * @param text - anything at all.
 * @returns the offending word, or `null` when the prose is clean of them.
 */
export function complianceClaimIn(text: string): string | null {
  if (typeof text !== "string") return null;
  const match = FORBIDDEN_COMPLIANCE_PROSE.exec(text);
  return match === null ? null : match[0];
}

/** Why a field's contents cannot be used. Facts about the VALUE, never about any agent. */
export type PolicyUnusableReason =
  /** Missing entirely, or present as something that is not a non-negative integer. */
  | "not_a_count"
  /** Present but not a finite number. */
  | "not_a_finite_number"
  /** A flag that is not a boolean. Fails CLOSED: a dropped flag must never read as `false`. */
  | "not_a_boolean"
  /** A closed-vocabulary field carrying a value this contract does not define. */
  | "not_a_known_value"
  /** An array element that is not an object at all. */
  | "malformed_element"
  /** A required prose field that is absent or empty. A producer that will not state its reason has not got one. */
  | "missing_required_reason"
  /**
   * A COVERAGE PROOF THAT IS NOT ONE. THE CHECK THIS FEATURE EXISTS FOR, AT THE
   * WIRE.
   *
   * The type system makes an unlicensed `satisfied` unspellable in OUR code; a
   * JSON body is not typechecked, and a `outcome: "satisfied"` whose proof
   * carries `logReadComplete: false` — or omits the instrumentation claim
   * entirely — is A PARTIAL READ OF AN UNDECLARED AGENT WEARING AN EXHAUSTIVE
   * PROOF'S CLOTHES. It is the one input that can produce a false all-clear.
   */
  | "unusable_coverage_proof"
  /** A violation citation that names no run, no event, or an artifact route with no verified checksum. */
  | "unusable_violation_proof"
  /**
   * THE FORBIDDEN-FIELD WALK RAN OUT OF BUDGET before it covered the body, so
   * "no forbidden field found" would be a statement about the SCAN rather than
   * about the body. Fails CLOSED — an unauditable body is not evaluated on.
   */
  | "forbidden_field_scan_truncated"
  /** The body asserts a call was prevented. See {@link FORBIDDEN_PREVENTION_CLAIM_FIELDS} and invariant 3. */
  | "forbidden_prevention_claim"
  /** The body asserts compliance in one word or one number. See invariant 2. */
  | "forbidden_compliance_claim"
  /** A prose field reads as an all-clear. See {@link FORBIDDEN_COMPLIANCE_PROSE}. */
  | "compliance_claim_in_prose"
  /**
   * THE BODY ASKS US NOT TO RECORD SOMETHING. See
   * {@link FORBIDDEN_SUPPRESSION_FIELDS} and INVARIANT 0. The most serious
   * refusal in this file.
   */
  | "forbidden_suppression_directive";

/** One unusable field, addressed by a path a human can act on. */
export interface PolicyUnusableFieldFinding {
  /** e.g. `"scan.runsRead"`, `"outcomes[0].establishedBy.instrumentation"`. */
  readonly path: string;
  readonly reason: PolicyUnusableReason;
}

/** Node budget for the forbidden-field walk. A malformed body must not make a validator expensive. */
const MAX_FIELD_SCAN_NODES = 20_000;
/**
 * Depth budget for the forbidden-field walk. Comfortably deeper than any legal
 * evaluation and bounded against a hostile one. IT ANNOUNCES ITSELF WHEN IT
 * BITES.
 */
const MAX_FIELD_SCAN_DEPTH = 24;

/** Which refusal a forbidden field name earns. A single lookup, so a new list cannot arrive unclassified. */
function forbiddenFieldReason(key: string): PolicyUnusableReason | null {
  if (FORBIDDEN_SUPPRESSION_FIELDS.includes(key)) return "forbidden_suppression_directive";
  if (FORBIDDEN_COMPLIANCE_CLAIM_FIELDS.includes(key)) return "forbidden_compliance_claim";
  if (FORBIDDEN_PREVENTION_CLAIM_FIELDS.includes(key)) return "forbidden_prevention_claim";
  return null;
}

/**
 * EVERY forbidden field, and every compliance claim in prose, ANYWHERE IN THE
 * BODY.
 *
 * TOTAL OVER THE BODY, not over branches somebody listed. `budgets.ts` learned
 * this the expensive way: a hand-picked set of call sites let `agentStopped:
 * true` hide inside the very object whose job was to carry a proof. Coverage here
 * is a property of the traversal rather than of whoever last edited a call site,
 * so a new nested type is covered the day it is added.
 *
 * BOUNDED AND CYCLE-SAFE, and IT ANNOUNCES ITS OWN CEILING — a claim planted
 * below a silent bound produces zero findings and zero explanation, which reads
 * exactly like a clean body. NEVER THROWS.
 */
function forbiddenContentIn(value: unknown, at: string): PolicyUnusableFieldFinding[] {
  const found: PolicyUnusableFieldFinding[] = [];
  const seen = new Set<object>();
  let visited = 0;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): void => {
    if (visited >= MAX_FIELD_SCAN_NODES || depth > MAX_FIELD_SCAN_DEPTH) {
      if (!truncated) {
        truncated = true;
        found.push({ path, reason: "forbidden_field_scan_truncated" });
      }
      return;
    }
    if (typeof node === "string") {
      // THE PROSE CHANNEL. Checked on every string in the body, not only on the
      // three fields somebody remembered, for the same reason the field walk is
      // total.
      if (complianceClaimIn(node) !== null) {
        found.push({ path, reason: "compliance_claim_in_prose" });
      }
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    visited += 1;

    if (Array.isArray(node)) {
      for (const [index, element] of node.entries()) walk(element, `${path}[${index}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const reason = forbiddenFieldReason(key);
      if (reason !== null) found.push({ path: `${path}.${key}`, reason });
      walk((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
  };

  try {
    walk(value, at, 0);
  } catch {
    return [{ path: at, reason: "forbidden_field_scan_truncated" }];
  }
  return found;
}

/**
 * IS THIS A COVERAGE PROOF, AT THE WIRE?
 *
 * The runtime half of the five literal types plus the instrumentation claim.
 * TypeScript makes an inexhaustive read unspellable in our code and stops at the
 * wire; this is the same rule re-checked on a body nothing has vouched for, and
 * it is the single most important validator in this file — it is what stands
 * between a partial read of an undeclared agent and a false all-clear.
 *
 * NOTE THE `===` CHECKS AND WHY THEY ARE NOT TRUTHINESS. `"false"` is truthy,
 * `undefined` is not `0`, and either would otherwise license an all-clear.
 *
 * MUST NEVER THROW.
 *
 * @param proof - anything at all; `false` is a valid answer.
 * @param rule - the rule whose satisfaction is being licensed, so the
 *   instrumentation claim can be checked against the right operation class.
 * @returns whether this object may license a `satisfied` outcome.
 */
export function isCoverageProof(proof: SatisfactionLicence, rule: PolicyRule): boolean {
  if (!isRecordLike(proof)) return false;
  const p = proof as unknown as Record<string, unknown>;
  const structurallyOk =
    p["proves"] === "complete_log_read_found_nothing" &&
    isNonEmptyString(p["runId"]) &&
    isNonEmptyString(p["forPolicyId"]) &&
    p["logReadComplete"] === true &&
    p["payloadsAllReadable"] === true &&
    p["runIsTerminal"] === true &&
    p["crossOrgRowsSkipped"] === 0 &&
    p["forbiddenOperationsFound"] === 0 &&
    isCount(p["eventsExamined"]) &&
    isFiniteNumber(p["scannedAt"]);
  if (!structurallyOk) return false;

  // THE SIXTH FIELD. A proof without a COMPLETE claim that covers this rule's
  // operation class is a proof about the read and not about the world.
  const claim = p["instrumentation"] as InstrumentationClaim;
  if (!isRecordLike(claim)) return false;
  if (!instrumentationCovers(claim, rule)) return false;
  const complete = claim as CompleteInstrumentationClaim;
  return (
    isNonEmptyString(complete.mechanism) &&
    isNonEmptyString(complete.claimedByAgentVersionId) &&
    isFiniteNumber(complete.claimedAt)
  );
}

/** Is this a usable violation citation? A violation naming no run or no event is an accusation. */
function isUsableViolationProof(proof: PolicyViolationProof): boolean {
  if (!isRecordLike(proof)) return false;
  const p = proof as unknown as Record<string, unknown>;
  if (p["proves"] !== "forbidden_operation_recorded") return false;
  const cited = p["citedEvent"] as PolicyEventCitation;
  if (!isRecordLike(cited)) return false;
  if (!isNonEmptyString(cited.runId) || !isNonEmptyString(cited.eventId)) return false;
  if (!isCount(cited.sequenceNumber) || !isNonEmptyString(cited.eventType)) return false;
  if (!isNonEmptyString(p["recordedFact"])) return false;
  const decidedBy = p["decidedBy"];
  if (decidedBy !== "inline_payload" && decidedBy !== "event_type_alone" && decidedBy !== "verified_artifact") {
    return false;
  }
  // `observedValue: null` is LEGAL and meaningful ONLY on the type-alone route.
  // A `null` on an inline read is a citation that read nothing.
  if (decidedBy !== "event_type_alone" && !isNonEmptyString(p["observedValue"])) return false;
  // An artifact route with no verified checksum cites whatever that key holds
  // today (CLAUDE.md Event Log Rule 3).
  if (decidedBy === "verified_artifact" && !isNonEmptyString(p["verifiedChecksum"])) return false;
  return true;
}

/**
 * Every field in an evaluation whose contents cannot be used.
 *
 * THE ONE FUNCTION A BOUNDARY SHOULD CALL, and it must run BEFORE
 * {@link evaluationClaimContradictions} and before any verdict is computed —
 * both compare, and a comparison against a string does not throw, it takes a
 * branch.
 *
 * MUST NEVER THROW.
 *
 * @param evaluation - anything at all.
 * @returns every unusable field, in a stable order. Empty means the body is
 *   readable — NOT that its claims are true.
 */
export function evaluationUnusableFields(evaluation: PolicyEvaluation): PolicyUnusableFieldFinding[] {
  const found: PolicyUnusableFieldFinding[] = [];
  if (!isRecordLike(evaluation)) return [{ path: "(evaluation)", reason: "malformed_element" }];

  if (!isFiniteNumber(evaluation.evaluatedAt)) {
    found.push({ path: "evaluatedAt", reason: "not_a_finite_number" });
  }

  // ONE TOTAL SWEEP OVER THE WHOLE BODY — fields and prose both.
  found.push(...forbiddenContentIn(evaluation, "(evaluation)"));

  const scan: Record<string, unknown> | null = isRecordLike(evaluation.scan)
    ? (evaluation.scan as unknown as Record<string, unknown>)
    : null;
  if (scan === null) {
    found.push({ path: "scan", reason: "malformed_element" });
  } else {
    for (const key of ["policiesInScope", "policiesEvaluated", "runsInScope", "runsRead"] as const) {
      if (!isCount(scan[key])) found.push({ path: `scan.${key}`, reason: "not_a_count" });
    }
    for (const key of ["evaluationTruncated", "orderingCaveat"] as const) {
      if (typeof scan[key] !== "boolean") found.push({ path: `scan.${key}`, reason: "not_a_boolean" });
    }
    // `null` IS LEGAL AND IS NOT `0`: no retention window configured. A missing
    // field is not — a coverage fact nobody stated is the state where a report
    // goes clean by elapsed time.
    if (scan["retentionHorizon"] !== null && !isFiniteNumber(scan["retentionHorizon"])) {
      found.push({ path: "scan.retentionHorizon", reason: "not_a_finite_number" });
    }
    if (!isRecordLike(scan["subject"])) found.push({ path: "scan.subject", reason: "malformed_element" });
  }

  for (const [index, outcome] of indexedElements<PolicyOutcome>(evaluation.outcomes).entries()) {
    const at = `outcomes[${index}]`;
    if (outcome === null) {
      found.push({ path: at, reason: "malformed_element" });
      continue;
    }
    if (outcome.outcome === "violated") {
      if (!isNonEmptyString(outcome.violatedPolicyId)) {
        found.push({ path: `${at}.violatedPolicyId`, reason: "not_a_known_value" });
      }
      if (!isCount(outcome.violatedPolicyRevision)) {
        found.push({ path: `${at}.violatedPolicyRevision`, reason: "not_a_count" });
      }
      if (typeof outcome.violationCountIsFloor !== "boolean") {
        found.push({ path: `${at}.violationCountIsFloor`, reason: "not_a_boolean" });
      }
      if (!isNonEmptyString(outcome.violatedBecause)) {
        found.push({ path: `${at}.violatedBecause`, reason: "missing_required_reason" });
      }
      const proofs = indexedElements<PolicyViolationProof>(outcome.provenBy);
      if (proofs.length === 0) {
        found.push({ path: `${at}.provenBy`, reason: "unusable_violation_proof" });
      }
      for (const [j, proof] of proofs.entries()) {
        if (proof === null || !isUsableViolationProof(proof)) {
          found.push({ path: `${at}.provenBy[${j}]`, reason: "unusable_violation_proof" });
        }
      }
    } else if (outcome.outcome === "satisfied") {
      if (!isNonEmptyString(outcome.satisfiedPolicyId)) {
        found.push({ path: `${at}.satisfiedPolicyId`, reason: "not_a_known_value" });
      }
      if (!isCount(outcome.satisfiedPolicyRevision)) {
        found.push({ path: `${at}.satisfiedPolicyRevision`, reason: "not_a_count" });
      }
      if (!isNonEmptyString(outcome.satisfiedBecause)) {
        found.push({ path: `${at}.satisfiedBecause`, reason: "missing_required_reason" });
      }
      // THE CENTRAL WIRE CHECK. A satisfied outcome carries no rule of its own,
      // so the claim is checked against the rule the CLAIM ITSELF names — a
      // proof whose instrumentation covers nothing is refused regardless.
      const claim = (outcome.establishedBy as { instrumentation?: InstrumentationClaim } | undefined)
        ?.instrumentation;
      // The claim names which operation classes it covers; the proof is checked
      // against each of them, so a tool-call declaration cannot license an
      // egress all-clear. A claim naming a kind this contract does not define is
      // filtered out rather than trusted — an uninterpretable operation class
      // licenses nothing.
      const declaredCover: unknown =
        isRecordLike(claim) && (claim as { claims?: unknown }).claims === "complete"
          ? (claim as CompleteInstrumentationClaim).coversOperations
          : undefined;
      const covered: PolicyRuleKind[] = Array.isArray(declaredCover)
        ? (declaredCover.filter((kind): kind is PolicyRuleKind =>
            (POLICY_RULE_KINDS as readonly unknown[]).includes(kind)
          ))
        : [];
      const licensed = covered.some((kind) => isCoverageProof(outcome.establishedBy, { kind }));
      if (!licensed) {
        found.push({ path: `${at}.establishedBy`, reason: "unusable_coverage_proof" });
      }
    } else if (outcome.outcome === "not_evaluable") {
      if (!isNonEmptyString(outcome.undecidedPolicyId)) {
        found.push({ path: `${at}.undecidedPolicyId`, reason: "not_a_known_value" });
      }
      if (!POLICY_NOT_EVALUABLE_KINDS.includes(outcome.kind)) {
        found.push({ path: `${at}.kind`, reason: "not_a_known_value" });
      }
      if (!isNonEmptyString(outcome.notEvaluableBecause)) {
        found.push({ path: `${at}.notEvaluableBecause`, reason: "missing_required_reason" });
      }
      if (!isNonEmptyString(outcome.wouldBeEvaluableBy)) {
        found.push({ path: `${at}.wouldBeEvaluableBy`, reason: "missing_required_reason" });
      }
    } else {
      // Fails closed rather than being read as one of the three. A fourth band is
      // not a deployment to guess at, and the wrong guess is `satisfied`.
      found.push({ path: `${at}.outcome`, reason: "not_a_known_value" });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// SELF-CLAIMS — every assertion an evaluation makes, checked against the
// evidence it ships with.
//
// THE CLASS, from `causality.ts` and `budgets.ts`:
//
//   VERIFYING THAT A CLAIM IS PRESENT AND INTERNALLY WELL-FORMED IS NOT
//   VERIFYING THAT IT AGREES WITH THE DATA BESIDE IT.
//
// Driven by a TOTAL table over the claim kinds, so a new self-claim is a compile
// error until it has an audit. Nothing chooses which claims to check at a call
// site.
// ---------------------------------------------------------------------------

/** A kind of assertion an evaluation makes about itself. Each one has a mandatory audit. */
export type PolicyClaim =
  /** A satisfied outcome asserts its proof is for its own policy and run. */
  | "proof_is_for_this_policy_and_run"
  /** A violated outcome asserts its citations come from the event type the rule is about. */
  | "citation_matches_the_rule"
  /**
   * A violation decided by `event_type_alone` asserts the rule denies the
   * OPERATION. Against a rule naming even one target, the type does not decide
   * it — see {@link ruleIsDecidableFromEventTypeAlone}.
   */
  | "type_alone_only_for_operation_denial"
  /** The scan asserts how many policies were evaluated. Audited against the outcome list. */
  | "scan_count_matches_outcomes"
  /** Every (policy, run) pair asserts one outcome. Two is a body that disagrees with itself. */
  | "outcomes_are_distinct";

/** How a claim contradicted the data beside it. */
export type PolicyClaimContradiction =
  /** A coverage proof whose `forPolicyId` or `runId` is not the outcome's. It proves a different thing. */
  | "proof_for_a_different_policy_or_run"
  /**
   * A violation citing an event type that is not the one
   * {@link RULE_DECIDING_EVIDENCE} names for the rule — a `tool_denied` policy
   * evidenced by an `llm.request`. The act may have happened; this body does not
   * show it.
   */
  | "citation_from_the_wrong_event_type"
  /**
   * A violation established from the event type alone against a rule that names
   * specific targets. THE MANUFACTURED PROOF ADR-009 §4.3 warns about: the type
   * says a tool was called, and the rule only forbids some tools.
   */
  | "type_alone_against_a_targeted_rule"
  /** `scan.policiesEvaluated` disagrees with the number of distinct policies in the outcome list. */
  | "outcome_count_disagrees_with_scan"
  /** Two outcomes for the same policy and run. Which one governs? */
  | "duplicate_outcome";

/** One contradiction, and what it was found in. */
export interface PolicyClaimFinding {
  readonly claim: PolicyClaim;
  readonly contradiction: PolicyClaimContradiction;
  /** e.g. `"outcomes(satisfied:policy_7/run_3)"`. */
  readonly at: string;
}

/** The evaluation, indexed once, so no audit re-walks the outcome list. */
interface EvaluationIndex {
  readonly violated: PolicyViolated[];
  readonly satisfied: PolicySatisfied[];
  readonly outcomes: PolicyOutcome[];
}

/**
 * The (policy, run) pair an outcome is about, whichever band it is.
 *
 * INTERNAL AND DELIBERATELY NOT EXPORTED, exactly like `budgets.ts`'s
 * `stateBudgetId` and `causality.ts`'s `terminusRunId`. The whole point of
 * `violatedPolicyId` / `satisfiedPolicyId` / `undecidedPolicyId` being different
 * names is that no renderer can print one under another's heading; a shared
 * accessor handed to consumers would re-open precisely that. This is an internal
 * audit that needs the pair purely to check set membership.
 */
function outcomeKey(outcome: PolicyOutcome): string | undefined {
  if (outcome?.outcome === "violated") return `${outcome.violatedPolicyId}/${outcome.violatedInRunId}`;
  if (outcome?.outcome === "satisfied") return `${outcome.satisfiedPolicyId}/${outcome.satisfiedInRunId}`;
  if (outcome?.outcome === "not_evaluable") return `${outcome.undecidedPolicyId}/${outcome.forRunId}`;
  return undefined;
}

/**
 * EVERY CLAIM KIND, WITH ITS MANDATORY AUDIT.
 *
 * A TOTAL `Record` over {@link PolicyClaim}, so a new claim an evaluation can
 * make about itself is a COMPILE ERROR here until somebody writes the check that
 * audits it against the data beside it.
 */
const POLICY_CLAIM_AUDITS: Record<PolicyClaim, (index: EvaluationIndex) => PolicyClaimFinding[]> = {
  proof_is_for_this_policy_and_run: (index) =>
    index.satisfied.flatMap((outcome): PolicyClaimFinding[] => {
      const proof = outcome.establishedBy;
      if (!isRecordLike(proof)) return [];
      if (proof.forPolicyId === outcome.satisfiedPolicyId && proof.runId === outcome.satisfiedInRunId) return [];
      return [
        {
          claim: "proof_is_for_this_policy_and_run",
          contradiction: "proof_for_a_different_policy_or_run",
          at:
            `outcomes(satisfied:${outcome.satisfiedPolicyId}/${outcome.satisfiedInRunId}) carries a proof for ` +
            `${String(proof.forPolicyId)}/${String(proof.runId)}`,
        },
      ];
    }),

  citation_matches_the_rule: (index) =>
    index.violated.flatMap((outcome): PolicyClaimFinding[] => {
      const kind = outcome.violatedRule?.kind;
      if (!(POLICY_RULE_KINDS as readonly string[]).includes(kind)) return [];
      const expected = RULE_DECIDING_EVIDENCE[kind].eventType;
      const at = `outcomes(violated:${outcome.violatedPolicyId}/${outcome.violatedInRunId})`;
      return soundElements<PolicyViolationProof>(outcome.provenBy)
        .filter((proof) => isRecordLike(proof.citedEvent) && proof.citedEvent.eventType !== expected)
        .map((proof) => ({
          claim: "citation_matches_the_rule" as const,
          contradiction: "citation_from_the_wrong_event_type" as const,
          at: `${at} cites ${String(proof.citedEvent?.eventType)}, expected ${expected}`,
        }));
    }),

  type_alone_only_for_operation_denial: (index) =>
    index.violated.flatMap((outcome): PolicyClaimFinding[] => {
      if (ruleIsDecidableFromEventTypeAlone(outcome.violatedRule)) return [];
      const at = `outcomes(violated:${outcome.violatedPolicyId}/${outcome.violatedInRunId})`;
      return soundElements<PolicyViolationProof>(outcome.provenBy)
        .filter((proof) => proof.decidedBy === "event_type_alone")
        .map(() => ({
          claim: "type_alone_only_for_operation_denial" as const,
          contradiction: "type_alone_against_a_targeted_rule" as const,
          at:
            `${at} establishes a violation from the event type alone, but the rule names specific targets — the ` +
            `type does not decide which one was used`,
        }));
    }),

  // The only audit that needs the SCAN COUNT rather than the outcome list, so it
  // is run by {@link evaluationClaimContradictions} after the table. It has an
  // entry here regardless, because the table is what makes coverage total — a
  // claim kind with no key would be a claim nobody audits.
  scan_count_matches_outcomes: () => [],

  outcomes_are_distinct: (index) => {
    const seen = new Set<string>();
    const findings: PolicyClaimFinding[] = [];
    for (const outcome of index.outcomes) {
      const key = outcomeKey(outcome);
      if (typeof key !== "string") continue;
      if (seen.has(key)) {
        findings.push({ claim: "outcomes_are_distinct", contradiction: "duplicate_outcome", at: `outcomes(${key})` });
        continue;
      }
      seen.add(key);
    }
    return findings;
  },
};

/**
 * Every claim this evaluation makes that the data beside it contradicts.
 *
 * THE ONE FUNCTION A GATE SHOULD CALL FOR SELF-CONSISTENCY, alongside
 * {@link evaluationUnusableFields}. It indexes the body once and runs every entry
 * in the audit table, so coverage is a property of the table rather than of
 * whoever last edited a gate.
 *
 * MUST NEVER THROW.
 *
 * @param evaluation - anything at all.
 * @returns every contradiction, in a stable order. Empty means the body's claims
 *   agree with its own evidence — NOT that the evidence is right.
 */
export function evaluationClaimContradictions(evaluation: PolicyEvaluation): PolicyClaimFinding[] {
  if (!isRecordLike(evaluation)) return [];
  const outcomes = soundElements<PolicyOutcome>(evaluation.outcomes);
  const index: EvaluationIndex = {
    outcomes,
    violated: outcomes.filter((o): o is PolicyViolated => o?.outcome === "violated" && isRecordLike(o.violatedRule)),
    satisfied: outcomes.filter((o): o is PolicySatisfied => o?.outcome === "satisfied"),
  };
  const contradictions = (Object.keys(POLICY_CLAIM_AUDITS) as PolicyClaim[]).flatMap((claim) =>
    POLICY_CLAIM_AUDITS[claim](index)
  );

  const scan = isRecordLike(evaluation.scan) ? (evaluation.scan as unknown as Record<string, unknown>) : null;
  const evaluated = scan?.["policiesEvaluated"];
  if (isCount(evaluated)) {
    const distinctPolicies = new Set(
      outcomes.map((o) => outcomeKey(o)?.split("/")[0]).filter((id): id is string => typeof id === "string")
    );
    if (distinctPolicies.size !== evaluated) {
      contradictions.push({
        claim: "scan_count_matches_outcomes",
        contradiction: "outcome_count_disagrees_with_scan",
        at: `scan.policiesEvaluated=${evaluated} vs ${distinctPolicies.size} distinct policy/policies in outcomes`,
      });
    }
  }
  return contradictions;
}

/**
 * EVERY REASON AN EVALUATION MUST NOT BE REPORTED ON.
 *
 * THE PRIMITIVE, so every caller of the verdict rule is gated — not just the one
 * that remembered to call a gate. `budgets.ts` shipped that hole and had it
 * found: the SDK guard was gated and `decideBudget` underneath it was not, so the
 * CLI enforced on a claim with nothing behind it. REDUNDANCY ABOVE A HOLE IS WHAT
 * HIDES THE HOLE.
 *
 * NOTE THE DIRECTION. An untrustworthy body does NOT become an all-clear: it
 * becomes `evaluation_incomplete`, and any well-evidenced violation inside it
 * still stands (see {@link establishedViolations}).
 *
 * MUST NEVER THROW.
 *
 * @param evaluation - anything at all.
 * @returns every refusal reason. Empty means the body may be reported on.
 */
export function policyEvaluationRefusals(evaluation: PolicyEvaluation): string[] {
  try {
    if (!isRecordLike(evaluation)) return ["the evaluation is not an object"];
    return [
      // USABILITY FIRST. Every check below is a comparison, and a comparison
      // against a string does not throw — it takes a branch.
      ...evaluationUnusableFields(evaluation).map((f) => `${f.path}: ${f.reason}`),
      ...evaluationClaimContradictions(evaluation).map((f) => `${f.at}: ${f.contradiction} (claim ${f.claim})`),
    ];
  } catch (err) {
    return [`the evaluation could not be inspected (${err instanceof Error ? err.message : String(err)})`];
  }
}

// ===========================================================================
// PART G — THE PRE-FLIGHT ASK. Synchronous, in-process, advisory.
// ===========================================================================

/**
 * An act an agent is ABOUT to perform, offered to the preflight.
 *
 * `value` is the raw thing: the tool name or the URL. Normalisation (host
 * extraction, case) happens in {@link actIsForbiddenBy}, ONCE, so the SDK and the
 * backend evaluator cannot disagree about whether `HTTPS://Evil.example/x`
 * matches `evil.example`. Two implementations of one predicate is the shape this
 * repo has produced defects from repeatedly.
 *
 * THIS DESCRIBES A CALL; IT DOES NOT BIND ONE (ADR-009 §7.7). Nothing connects
 * the name passed here to the call subsequently made, and nothing re-checks. That
 * is an ordinary time-of-check/time-of-use gap and it is unclosable from inside a
 * library — which is exactly why the RECORDED RUN is the only thing that can ever
 * contradict the description.
 */
export interface ProposedAct {
  readonly kind: PolicyRuleKind;
  readonly value: string;
}

/**
 * EVERY POLICY GOVERNING A SUBJECT, WITH A STATED SHELF LIFE.
 *
 * A LIST OF DEFINITIONS rather than a list of answers — unlike `BreakerSnapshot`,
 * which carries evaluated states. Deliberate: a policy question is decidable IN
 * THE CLIENT from the definition and the proposed act, so the SDK asks the server
 * once per shelf life and answers locally, for free, for every act. A breaker
 * needs the server because only the server can sum spend; a prohibition does not.
 *
 * DERIVED, NEVER SOURCE OF TRUTH (CLAUDE.md Event Log Rule 2).
 */
export interface PolicySnapshot {
  /** Server clock when the policy set was read, epoch ms. */
  readonly evaluatedAt: number;
  /**
   * SERVER-STATED SHELF LIFE AS A DURATION, in ms.
   *
   * A duration rather than an instant, for both reasons `budgets.ts` writes up at
   * `BreakerSnapshot.shelfLifeMs`: it is SKEW-INVARIANT, so a wrong server clock
   * cannot buy extra permission or decline a whole fleet; and it does not
   * silently spend its margin on transit, which is what synchronises a fleet's
   * refreshes into a storm at the moment the deployment is slowest.
   *
   * STILL CLAMPED CLIENT-SIDE by {@link MAX_POLICY_ANSWER_FRESHNESS_MS}. An
   * unbounded shelf life is a bypass.
   */
  readonly shelfLifeMs: number;
  /** Echoed. A server that listed a different subject's policies answered a different question. */
  readonly subject: PolicySubject;
  /** Every ENABLED policy governing the subject. */
  readonly policies: readonly PolicyDefinition[];
  /** How many govern the subject. */
  readonly policiesInScope: number;
  /**
   * True when the listing stopped on a server ceiling.
   *
   * A TRUNCATED LISTING CANNOT ANSWER "no policy forbids this", and that is why
   * this flag is separate from `policiesInScope`: the policy that forbids the act
   * is exactly as likely to be in the unread tail as in the read head.
   */
  readonly listingTruncated: boolean;
}

/** How long a client may honour a policy listing, whatever the server says. Ten minutes. */
export const MAX_POLICY_ANSWER_FRESHNESS_MS = 600_000;

/** The longest a caller may configure {@link PolicyUnavailablePolicy}'s grace window. */
export const MAX_POLICY_GRACE_MS = 300_000;

/**
 * WHAT TO DO WHEN THE POLICY SET CANNOT BE CONSULTED.
 *
 * REQUIRED, EXPLICIT, AND NOT A DEFAULT IN A CATCH BLOCK — the same shape and the
 * same argument as `BudgetUnavailablePolicy`. A preflight that fails OPEN on an
 * unreachable server is not a preflight: anyone who wants to bypass it causes a
 * network error, and "the check errored" is the easiest condition in computing to
 * arrange. One that fails CLOSED advises against every act during an outage of
 * OURS. Both costs are real, they fall on different people, and no library gets
 * to pick on their behalf.
 *
 * Two of the three arms require the caller to write down `acceptedRisk` in prose.
 * You may weaken the preflight; you may not do it silently.
 */
export type PolicyUnavailablePolicy =
  /** FAIL CLOSED. No usable listing means advise against. */
  | { readonly onUnavailable: "deny" }
  /**
   * FAIL CLOSED, WITH A BOUNDED GRACE ON A LISTING WE ALREADY HAD. Honours the
   * last COMPLETE listing for `graceMs` past its shelf life, then advises against.
   */
  | {
      readonly onUnavailable: "grace";
      /** Milliseconds past expiry. Bounded by {@link MAX_POLICY_GRACE_MS}. */
      readonly graceMs: number;
      /** REQUIRED: what you are accepting, in prose. */
      readonly acceptedRisk: string;
    }
  /**
   * FAIL OPEN. No listing means proceed. The answer is still RECORDED as
   * {@link ProceededWithoutPolicyAnswer} — a distinct band that can never be
   * counted as "no policy forbids this".
   */
  | {
      readonly onUnavailable: "allow";
      /** REQUIRED: what you are accepting, in prose. */
      readonly acceptedRisk: string;
    };

/**
 * A LISTED POLICY FORBIDS THIS ACT.
 *
 * The band that means the preflight did its job. Note the name and the fields:
 * the SDK ADVISED AGAINST the act. It did not block it, prevent it, or stop
 * anything. See invariant 3.
 */
export interface AdvisedAgainstByPolicy {
  readonly answer: "advised_against_by_policy";
  readonly advisingPolicyId: string;
  readonly advisingPolicyRevision: number;
  /** The policy's own rationale, carried through so the caller's log line explains itself. */
  readonly advisingRationale: string;
  /** What was proposed, echoed, so the log line is actionable. */
  readonly proposedValue: string;
  readonly advisedAt: number;
  /**
   * LITERAL `true`, ON EVERY BAND. INVARIANT 0 in the return value an integrator
   * reads: whatever you do next, RECORD IT. If you proceed, the breach must be in
   * the log; if you do not, the fact that you were advised against must be.
   */
  readonly recordRegardless: true;
}

/**
 * THE POLICY SET WAS CONSULTED IN FULL AND NONE OF ITS MEMBERS FORBIDS THIS ACT.
 *
 * NOT "this act is allowed". Scoped in its own name to THE RULES AND FIELDS
 * INVOLVED, per ADR-009 §4.3: this band is reachable only from a COMPLETE listing
 * (`listingTruncated: false`, every policy listed), because a partial listing
 * cannot answer a negative question — the policy that forbids the act is as
 * likely to be in the unread tail as anywhere else. And an act nobody wrote a
 * policy for is UNLISTED, not permitted.
 *
 * Never assignable to or from the other bands: no shared field but the
 * discriminant and `recordRegardless`.
 */
export interface NoListedPolicyForbidsThisAct {
  readonly answer: "no_listed_policy_forbids_this_act";
  /** Every policy consulted, by id. NON-EMPTY: with zero policies this is a different band. */
  readonly consultedPolicyIds: readonly [string, ...string[]];
  /** When the listing expires on the CLIENT's clock, epoch ms — already capped. */
  readonly listingGoodUntil: number;
  readonly recordRegardless: true;
}

/**
 * NO POLICY GOVERNS THIS SUBJECT.
 *
 * ITS OWN BAND, for the reason `AllowedNoBudgetGoverns` is: "no policy applies"
 * and "the policies were checked and none forbids this" are different facts with
 * different remedies, and the first is what a DELETED, DISABLED OR MIS-SCOPED
 * policy set looks like.
 *
 * `policiesInScope` IS THE LITERAL TYPE `0`, so this band cannot be constructed
 * for a subject that does have policies.
 */
export interface NoPolicyGovernsThisSubject {
  readonly answer: "no_policy_governs_this_subject";
  /** LITERAL `0`. A subject with policies cannot be spelled here. */
  readonly policiesInScope: 0;
  /** Echoed, so a misconfiguration is greppable: which subject has no policy? */
  readonly ungovernedSubject: PolicySubject;
  readonly ungovernedAt: number;
  readonly recordRegardless: true;
}

/**
 * THE LISTING EXPIRED, THE SERVER IS UNREACHABLE, AND WE ARE INSIDE THE
 * CONFIGURED GRACE.
 *
 * Still not fail-open: a COMPLETE listing we RECEIVED is being honoured slightly
 * past its stated shelf life. It cannot be reached without one.
 */
export interface ProceededWithinGrace {
  readonly answer: "proceeded_within_grace";
  /** When the honoured listing expired, epoch ms. */
  readonly honouredListingExpiredAt: number;
  /** When the grace runs out and this becomes an advisory against, epoch ms. */
  readonly graceEndsAt: number;
  /** REQUIRED: why the server could not be re-asked. */
  readonly unreachableBecause: string;
  /** Echoed from the policy, so the sentence somebody wrote down travels with the answer. */
  readonly graceAcceptedRisk: string;
  readonly recordRegardless: true;
}

/**
 * THERE WAS NO USABLE LISTING, AND THE POLICY SAYS ADVISE AGAINST.
 *
 * The fail-closed outcome. NOT a claim that a policy forbids the act — we do not
 * know that, and saying so would be dishonest in the other direction. It is a
 * claim about our own ignorance and what we did with it.
 */
export interface AdvisedAgainstWithoutAnswer {
  readonly answer: "advised_against_without_answer";
  /** LITERAL `"deny"` or `"grace"`. Unreachable under `allow`. */
  readonly advisedByPolicy: "deny" | "grace";
  /** REQUIRED: why there was no usable listing. */
  readonly noAnswerBecause: string;
  /** REQUIRED: what would produce one, as an action. */
  readonly wouldBeAnsweredBy: string;
  readonly advisedAt: number;
  readonly recordRegardless: true;
}

/**
 * WE NEVER GOT A LISTING, AND THE POLICY SAYS PROCEED ANYWAY.
 *
 * THE BAND THIS CONTRACT EXISTS TO KEEP VISIBLE. "I could not ask" is being
 * treated as "nothing forbids this", deliberately, by a caller who wrote down
 * why. A legitimate operational choice and also the exact shape of a bypass, so
 * it gets its own type, its own name, and no field in common with the band that
 * means the policy set was actually consulted.
 *
 * An org whose preflight answers are entirely this band has no preflight at all,
 * and that must be readable from the answer itself — not from a flag anybody has
 * to remember to check.
 */
export interface ProceededWithoutPolicyAnswer {
  readonly answer: "proceeded_without_policy_answer";
  /** LITERAL `"allow"`. This band is unreachable under any other policy. */
  readonly proceededByPolicy: "allow";
  /** REQUIRED: why there was no listing. */
  readonly unansweredBecause: string;
  /** Echoed from the policy. The sentence somebody wrote down travels with every answer it licensed. */
  readonly allowAcceptedRisk: string;
  readonly unansweredAt: number;
  readonly recordRegardless: true;
}

/**
 * What the pre-flight answered, and on what basis.
 *
 * SIX BANDS, SHARING NO FIELD BUT THE DISCRIMINANT AND `recordRegardless` — not a
 * policy id, not a timestamp name, not a message, and above all NOT an `ok:
 * true`. Every access forces a narrow, and having narrowed, a consumer holds a
 * type whose field names state which claim it is making.
 *
 * FOUR OF THE SIX MEAN PROCEED and they are not interchangeable:
 * {@link NoListedPolicyForbidsThisAct} is the preflight working;
 * {@link NoPolicyGovernsThisSubject} is the preflight having nothing to do;
 * {@link ProceededWithinGrace} is degraded; {@link ProceededWithoutPolicyAnswer}
 * is off. A single boolean would make all four the same number on the same graph,
 * and an org whose answers are 100% "could not ask" would look identical to one
 * with a working preflight.
 */
export type PolicyPreflightAnswer =
  | AdvisedAgainstByPolicy
  | NoListedPolicyForbidsThisAct
  | NoPolicyGovernsThisSubject
  | ProceededWithinGrace
  | AdvisedAgainstWithoutAnswer
  | ProceededWithoutPolicyAnswer;

/**
 * INVARIANT 0 AS A TOTAL TABLE.
 *
 * Every band records regardless. There is no band under which the caller is told
 * it may skip recording, and this table is what makes that a compile-time
 * property rather than six independent field initialisers somebody could get
 * wrong once. A seventh band is a compile error here until it says `true` too.
 *
 * IT IS DELIBERATELY NOT A FUNCTION RETURNING `boolean`. A function could return
 * `false`; this table's VALUE TYPE is the literal `true`, so "do not record"
 * cannot be expressed even by a future edit that meant well.
 */
export const PREFLIGHT_STILL_RECORDS: Record<PolicyPreflightAnswer["answer"], true> = {
  advised_against_by_policy: true,
  no_listed_policy_forbids_this_act: true,
  no_policy_governs_this_subject: true,
  proceeded_within_grace: true,
  advised_against_without_answer: true,
  proceeded_without_policy_answer: true,
};

/**
 * WHICH ANSWERS MEAN PROCEED, DECLARED ONCE.
 *
 * TOTAL OVER THE UNION'S DISCRIMINANTS, so a seventh band is a compile error here
 * until classified. Defaulting to "proceed" by omission is how a new kind of
 * not-having-asked would quietly buy a green light.
 */
const PROCEED_ANSWERS: Record<PolicyPreflightAnswer["answer"], boolean> = {
  advised_against_by_policy: false,
  no_listed_policy_forbids_this_act: true,
  no_policy_governs_this_subject: true,
  proceeded_within_grace: true,
  advised_against_without_answer: false,
  proceeded_without_policy_answer: true,
};

/**
 * The boolean a control-flow site needs.
 *
 * FAILS CLOSED ON AN UNRECOGNISED DISCRIMINANT.
 *
 * @param answer - anything at all; `false` is a valid answer.
 * @returns whether the SDK is declining to advise against. NEVER throws.
 */
export function mayProceedWithAct(answer: PolicyPreflightAnswer): boolean {
  const band = (answer as { answer?: unknown })?.answer;
  return typeof band === "string" && PROCEED_ANSWERS[band as PolicyPreflightAnswer["answer"]] === true;
}

/**
 * Did the SDK advise against this act?
 *
 * NOTE WHAT THIS FUNCTION IS NOT CALLED, AND WHAT DOES NOT EXIST BESIDE IT. There
 * is no `wasCallPrevented`, no `wasActBlocked`, no `wasPolicyEnforced` — not
 * because nobody wrote them, but because there is no honest implementation of
 * one. The SDK observes its own return value and nothing else. See invariant 3.
 *
 * @param answer - the answer to read.
 * @returns whether THE SDK advised against. Says nothing about what the caller
 *   did next, because nothing here can know that.
 */
export function wasAdvisedAgainstBySdk(answer: PolicyPreflightAnswer): boolean {
  return !mayProceedWithAct(answer);
}

/**
 * THE SENTENCE A HUMAN READS FOR A PREFLIGHT ANSWER, COMPOSED RATHER THAN
 * TRANSMITTED.
 *
 * Every advisory branch names THE SDK as the subject and then says, in the same
 * breath, what that does not mean — because an operator reading "policy enforced"
 * at 3am will not supply the caveat for themselves.
 *
 * EXHAUSTIVE OVER THE UNION BY CONSTRUCTION.
 *
 * @param answer - the answer to render.
 * @returns a statement about the policy set and about the SDK. Never a statement
 *   about prevention, in any branch.
 */
export function preflightStatement(answer: PolicyPreflightAnswer): string {
  switch (answer.answer) {
    case "advised_against_by_policy":
      return (
        `POLICY ${answer.advisingPolicyId} (rev ${answer.advisingPolicyRevision}) FORBIDS ` +
        `${JSON.stringify(answer.proposedValue)} — ${answer.advisingRationale} — and THE SDK ADVISED AGAINST IT. ` +
        `Those are the two facts here. The SDK returns an answer; it does not intercept a call, and nothing in ` +
        `this record establishes that the act was prevented. WHATEVER HAPPENS NEXT, RECORD IT — if the act ` +
        `proceeds, that event is the most valuable one in the log.`
      );
    case "no_listed_policy_forbids_this_act":
      return (
        `The SDK is not advising against: all ${answer.consultedPolicyIds.length} policy/policies governing this ` +
        `subject were listed in full and none forbids this act AS DESCRIBED. Good until ` +
        `${new Date(answer.listingGoodUntil).toISOString()}. Two limits travel with this: an act nobody wrote a ` +
        `policy for is UNLISTED, not permitted; and this decides the call you described, not the call you make.`
      );
    case "no_policy_governs_this_subject":
      return (
        `The SDK is not advising against, but NO POLICY GOVERNS THIS SUBJECT — there was nothing to check. This is ` +
        `what a deleted, disabled or mis-scoped policy set also looks like; if you expected coverage here, the ` +
        `policies are not attached to ${JSON.stringify(answer.ungovernedSubject)}.`
      );
    case "proceeded_within_grace":
      return (
        `The SDK is not advising against ON AN EXPIRED LISTING. The last complete listing forbade nothing; it ` +
        `expired at ${new Date(answer.honouredListingExpiredAt).toISOString()} and the server could not be ` +
        `re-asked (${answer.unreachableBecause}). The configured grace ends at ` +
        `${new Date(answer.graceEndsAt).toISOString()}, after which this becomes an advisory against. Accepted ` +
        `risk: ${answer.graceAcceptedRisk}`
      );
    case "advised_against_without_answer":
      return (
        `THE SDK ADVISED AGAINST because the policy set could not be consulted (${answer.noAnswerBecause}), under ` +
        `the '${answer.advisedByPolicy}' policy. NOTE WHAT THIS IS NOT: it is not a statement that a policy ` +
        `forbids this act — we do not know that — and it is not a statement that anything was prevented. To get a ` +
        `real answer: ${answer.wouldBeAnsweredBy}`
      );
    case "proceeded_without_policy_answer":
      return (
        `THE POLICY SET WAS NOT CONSULTED AND THE SDK IS NOT ADVISING AGAINST. There was no listing ` +
        `(${answer.unansweredBecause}) and the configured policy is to proceed regardless. This answer was given ` +
        `WITHOUT any statement from the policy set — it is not evidence that the act is permitted, and it must ` +
        `not be counted as one. Accepted risk: ${answer.allowAcceptedRisk}`
      );
    default: {
      // Exhaustiveness: a seventh band must be given a sentence here.
      const unreachable: never = answer;
      return String(unreachable);
    }
  }
}

/**
 * DOES `observed` FALL UNDER THE DENIED HOST `denied`?
 *
 * CHECKS THE LABEL BOUNDARY. `evil.example` covers `evil.example` and
 * `a.evil.example`, and does NOT cover `myevil.example` — raw suffix matching on
 * strings is how a rule about `evil.example` is slipped past.
 *
 * @param observed - a hostname, already extracted and lowercased.
 * @param denied - the configured host.
 * @returns whether the observed host is the denied host or below it.
 */
export function hostFallsUnder(observed: string, denied: string): boolean {
  if (typeof observed !== "string" || typeof denied !== "string") return false;
  const host = observed.toLowerCase().replace(/\.$/, "");
  const suffix = denied.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  if (host.length === 0 || suffix.length === 0) return false;
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * DOES THIS POLICY FORBID THIS ACT? The matching rule, in ONE place, for the SDK
 * preflight and the backend evaluator both.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NORMALISATION LIVES HERE AND NOT AT TWO CALL SITES
 * ---------------------------------------------------------------------------
 *
 * The pre-flight answers "may I call this" from a raw URL a caller is holding;
 * the evaluator answers "did this happen" from an `http.request` payload's `url`.
 * If those normalise differently — one lowercases, one does not; one handles
 * userinfo, one does not — then an act the preflight permitted is later reported
 * as a violation, or worse, the reverse.
 *
 * The `URL` parser is used rather than a regex, so `https://evil.example@safe.example/`
 * resolves to the host a request would actually REACH, which is `safe.example`.
 * Getting that backwards is a real bypass in both directions.
 *
 * A RULE MATCHES A STRING, NOT A CAPABILITY (ADR-009 §7.8). A renamed tool with
 * an identical implementation escapes the rule; two unrelated implementations
 * sharing a name are conflated; a tool invoked indirectly through another tool is
 * invisible. Nothing here closes that, and nothing can.
 *
 * MUST NEVER THROW.
 *
 * @param policy - the policy to test. Anything at all; `false` is a valid answer.
 * @param act - the proposed or recorded act.
 * @returns whether the policy forbids it. A disabled policy forbids nothing.
 */
export function actIsForbiddenBy(policy: PolicyDefinition, act: ProposedAct): boolean {
  try {
    if (!isRecordLike(act)) return false;
    // THE SAME GOVERNANCE READING THE RETROSPECTIVE EVALUATOR USES — disabled,
    // and uninterpretable, in one place rather than two. This function used to
    // check `enabled` itself while the evaluator structurally could not see it,
    // which is the split {@link policyGovernanceFailure} exists to close.
    //
    // A policy that governs nothing forbids nothing HERE, and is reported as
    // `not_evaluable` THERE. Neither is a permission: the pre-flight has no
    // third band, so an unmatched act lands on
    // `no_listed_policy_forbids_this_act`, whose own name scopes it to the rules
    // and fields involved rather than claiming the act is allowed.
    if (!policyGoverns(policy)) return false;
    const rule = policy.rule;
    if (rule.kind !== act.kind) return false;
    const observed = act.value;
    if (!isNonEmptyString(observed)) return false;

    if (rule.kind === "tool_denied") {
      // ABSENT LIST = EVERY TOOL. See {@link PolicyRule}.
      if (rule.deniedTools === undefined) return true;
      return rule.deniedTools.includes(observed);
    }
    if (rule.kind === "egress_denied") {
      if (rule.deniedHosts === undefined) return true;
      // THE SAME NORMALISER THE RETROSPECTIVE EVALUATOR USES, and it accepts
      // both a full URL and a bare host. A pre-flight that parsed only URLs
      // while the evaluator also accepted `host` is exactly how the two came to
      // disagree about the same egress — see {@link hostForMatching}.
      const host = hostForMatching(observed);
      // `null` is "we could not interpret what the caller passed". The
      // pre-flight has no third band, so it declines to claim a match — and it
      // claims no permission either: an unmatched act lands on
      // `no_listed_policy_forbids_this_act`, whose own name scopes it to the
      // rules and fields involved, never to "this act is allowed".
      if (host === null) return false;
      return rule.deniedHosts.some((denied) => hostFallsUnder(host, String(denied)));
    }
    // A rule kind this contract does not define is not one to guess at. For a
    // PROHIBITION the safe guess is `false` — asserting a violation from an
    // uninterpretable rule would put an accusation in a compliance report. The
    // evaluator reports such a policy as `policy_unreadable`, which is
    // `not_evaluable` and therefore never an all-clear either.
    return false;
  } catch {
    return false;
  }
}

/**
 * THE HOST A VALUE NAMES, NORMALISED FOR MATCHING — or `null` when it names
 * none.
 *
 * ---------------------------------------------------------------------------
 * THIS ACCEPTS BOTH A FULL URL AND A BARE HOST, AND THAT IS THE WHOLE FIX
 * ---------------------------------------------------------------------------
 *
 * `hostFallsUnder` takes an ALREADY-EXTRACTED hostname. Extraction used to live
 * somewhere else, in another module, with another vocabulary — and the two
 * diverged in the way two separately-maintained things always do:
 *
 *   an `http.request` payload carrying `url: "https://evil.example/x"` was
 *   extracted as a raw URL, and the matcher parsed it. MATCHED.
 *
 *   the same payload carrying `host: "evil.example"` was extracted as a bare
 *   hostname, handed to a matcher that only parsed full URLs, and MATCHED
 *   NOTHING — so a recorded, inline, fully legible forbidden egress was counted
 *   as a legible field, matched against nothing, and cleared the run.
 *
 * THAT IS A FALSE ALL-CLEAR, WHICH IS THE ONE OUTCOME THIS FEATURE EXISTS TO
 * PREVENT, and it did not come from a missing case in the matcher. It came from
 * extraction and matching being two things that had to agree about what a host
 * is. Teaching the matcher a second spelling would have left two places that
 * must agree — the same arrangement, one case later.
 *
 * So there is ONE normaliser, here, in the module that owns
 * {@link hostFallsUnder}, and it is reached only through
 * {@link matchRecordedEventAgainstPolicy} and {@link actIsForbiddenBy} — the two
 * functions that do extraction and matching TOGETHER. No caller can perform half
 * of it, because no exported function does half of it.
 *
 * A VALUE IT CANNOT NORMALISE RETURNS `null`, AND `null` IS NOT "no host, so
 * nothing is denied". Callers turn it into `deciding_field_unreadable`, which is
 * `not_evaluable`. A value present but uninterpretable is evidence we could not
 * read, not evidence of compliance.
 *
 * @param value - a URL or a bare host, as an emitter wrote it. Anything at all.
 * @returns the lowercased host, port and userinfo removed, or `null`.
 */
export function hostForMatching(value: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // A value carrying a scheme is a URL; anything else is treated as an
  // authority. `includes("://")` rather than a scheme regex because a value with
  // a scheme we do not recognise is still a URL, and reading its path as a host
  // is the mistake this function exists to stop.
  const authority = trimmed.includes("://") ? authorityOf(trimmed) : trimmed;
  if (authority === null) return null;
  return normaliseAuthority(authority);
}

/**
 * The authority component of a URL — everything between the scheme and the
 * first `/`, `?` or `#`.
 */
function authorityOf(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd <= 0) return null;
  let authority = url.slice(schemeEnd + 3);
  for (const terminator of ["/", "?", "#"]) {
    const at = authority.indexOf(terminator);
    if (at >= 0) authority = authority.slice(0, at);
  }
  return authority;
}

/**
 * An authority reduced to the host a request would actually reach.
 *
 * THE USERINFO STEP IS THE ONE THAT MATTERS.
 * `https://evil.example@safe.example/` reaches `safe.example`, and getting that
 * backwards is a real bypass IN BOTH DIRECTIONS: a denied egress reported as
 * permitted, and a permitted egress reported as a violation — the second putting
 * a false accusation in a compliance report.
 *
 * The platform `URL` parser would do this and is deliberately NOT used:
 * `packages/contracts` has zero runtime dependencies and no guaranteed `lib`, so
 * it must compile for a Convex isolate, a Lambda, an edge worker and a browser
 * alike. The steps here are the ones `URL` performs that matter to a host
 * comparison, and nothing more.
 */
function normaliseAuthority(input: string): string | null {
  let authority = input.trim();
  if (authority.length === 0) return null;
  // A bare value may still carry a path (`evil.example/x`). It names that host.
  for (const terminator of ["/", "?", "#"]) {
    const at = authority.indexOf(terminator);
    if (at >= 0) authority = authority.slice(0, at);
  }
  // USERINFO — everything up to and including the LAST `@` is credentials.
  const lastAt = authority.lastIndexOf("@");
  if (lastAt >= 0) authority = authority.slice(lastAt + 1);
  // IPv6 literals are bracketed and their colons are not a port separator.
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    const literal = authority.slice(0, close + 1).toLowerCase();
    return /^\[[0-9a-f:.]+\]$/.test(literal) ? literal : null;
  }
  const colon = authority.indexOf(":");
  if (colon >= 0) authority = authority.slice(0, colon);
  // A trailing root dot is the same host (`evil.example.` === `evil.example`).
  const host = authority.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return null;
  // ANYTHING THAT IS NOT SHAPED LIKE A HOST IS `null`, NOT A HOST THAT MATCHES
  // NOTHING. A space, a quote, a stray bracket — an emitter producing one has
  // produced a value we cannot interpret, and the caller must report that rather
  // than clear the run.
  return /^[a-z0-9._-]+$/.test(host) ? host : null;
}

/**
 * WHAT ONE RECORDED EVENT SAYS ABOUT ONE RULE.
 *
 * FOUR-VALUED, and the fourth band is the one this type exists for. A boolean
 * would force "the deciding value was not readable" into "this event does not
 * violate the rule", and over a whole run that is a false all-clear — the
 * outcome ADR-009 §5 is about, arriving through a return type rather than
 * through a bug.
 */
export type RuleMatch =
  /** Wrong event type. This event is SILENT on this rule; it neither clears nor implicates. */
  | { readonly match: "not_relevant" }
  /** The forbidden operation is recorded here. */
  | {
      readonly match: "forbidden";
      /** The value read, or `null` when the event TYPE alone decided it. Never a sentinel string. */
      readonly observedValue: string | null;
      readonly decidedBy: ViolationDecidedBy;
    }
  /** The deciding value was READ, and this rule does not forbid it. The only band that clears anything. */
  | { readonly match: "permitted_by_this_rule"; readonly observedValue: string }
  /**
   * The right kind of event, and the deciding value could not be read. NOT a
   * pass. Carries the `not_evaluable` kind the run-level outcome should take.
   */
  | {
      readonly match: "undecidable";
      readonly kind: PolicyNotEvaluableKind;
      readonly because: string;
      readonly wouldBeEvaluableBy: string;
    };

/** Is this payload the `ExternalizedPayload` envelope Event Log Rule 3 leaves behind? */
export function isExternalizedPayload(payload: unknown): boolean {
  return isRecordLike(payload) && (payload as { type?: unknown }).type === "_externalized";
}

/**
 * IS THIS RULE INTERPRETABLE AT ALL?
 *
 * An EMPTY denied list is not a deny-all and it is not a valid narrow rule — it
 * is a misconfiguration that forbids nothing while looking exactly like a rule
 * that checked. `undefined` means "the operation itself"; `[]` means "these
 * specific ones" with none named, and grading a run against it would clear the
 * run on the strength of a rule that could never have matched.
 *
 * FAILS CLOSED at EVALUATION time, not only at write time: a row written before
 * this check existed, or by another client, must not grade runs clean.
 *
 * @param rule - anything at all; `false` is a valid answer.
 * @returns whether this rule can decide anything.
 */
export function isInterpretableRule(rule: PolicyRule): boolean {
  if (!isRecordLike(rule)) return false;
  if (rule.kind === "tool_denied") {
    return rule.deniedTools === undefined || (Array.isArray(rule.deniedTools) && rule.deniedTools.length > 0);
  }
  if (rule.kind === "egress_denied") {
    return rule.deniedHosts === undefined || (Array.isArray(rule.deniedHosts) && rule.deniedHosts.length > 0);
  }
  return false;
}

/** One recorded event, as this predicate needs it. */
export interface RecordedActEvent {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * DOES THIS POLICY GOVERN ANYTHING AT ALL? THE ONE PLACE THE QUESTION IS ASKED,
 * for the pre-flight and the retrospective evaluator both.
 *
 * ---------------------------------------------------------------------------
 * WHY ENABLEMENT LIVES HERE AND NOT AT EACH CALLER
 * ---------------------------------------------------------------------------
 *
 * This function exists because of a defect with the same shape as the one
 * {@link matchRecordedEventAgainstPolicy} was built to fix, one level up. The
 * evaluator used to take a `PolicyRule`, so it STRUCTURALLY COULD NOT see
 * `enabled`, while {@link actIsForbiddenBy} took the whole policy and did check
 * it. TWO HALVES OF ONE PREDICATE ASKING DIFFERENT QUESTIONS ABOUT THE SAME
 * SUBJECT — the pre-flight honoured a disabled policy's silence and the
 * evaluator reported violations of it.
 *
 * THAT DIRECTION IS WORSE THAN D6's, AND THE ASYMMETRY IS WORTH NAMING: a false
 * all-clear is believed, but A FALSE VIOLATION IS ACTED ON. Somebody rolls back,
 * or blocks a deploy, on a rule that was explicitly turned off.
 *
 * It was survivable only because the backend's loader happened to filter
 * disabled rows before calling. "The guarantee holds because the one caller in
 * tree happens to be careful" is not a guarantee, and it is precisely the
 * defence-in-depth that hid D6 for a cycle. So the two halves were given ONE
 * SUBJECT — the policy — and this is the single reading of what that subject
 * licenses.
 *
 * BOTH FAILURES ARE `undecidable`, NEVER A CLEARANCE AND NEVER A MATCH. A
 * disabled or uninterpretable policy is wrong in both directions if it produces
 * either, and `not_evaluable` is the only band that is wrong in neither: it
 * cannot manufacture a violation, and it cannot be counted as an all-clear, so
 * a failing scan cannot be made to pass by switching its policies off.
 *
 * MUST NEVER THROW.
 *
 * @param policy - anything at all.
 * @returns the `undecidable` band to return, or `null` when the policy governs.
 */
function policyGovernanceFailure(policy: PolicyDefinition): RuleMatch | null {
  if (!isRecordLike(policy)) {
    return {
      match: "undecidable",
      kind: "policy_unreadable",
      because: `the policy is not an object (${JSON.stringify(policy ?? null)})`,
      wouldBeEvaluableBy: "pass a stored PolicyDefinition row",
    };
  }
  // ENABLEMENT FIRST. A disabled policy's rule does not matter, and reporting an
  // uninterpretable rule on a policy nobody has switched on would send an
  // operator to fix the wrong thing.
  if (policy.enabled !== true) {
    return {
      match: "undecidable",
      kind: "policy_disabled",
      because:
        `policy ${String(policy.policyId)} is disabled, so it governs nothing — it can neither be violated nor ` +
        `satisfied by this run`,
      wouldBeEvaluableBy: "re-enable the policy, or drop it from the scan's scope",
    };
  }
  if (!isInterpretableRule(policy.rule)) {
    return {
      match: "undecidable",
      kind: "policy_unreadable",
      because:
        `the rule is not interpretable (${JSON.stringify(policy.rule ?? null)}) — an empty denied list forbids ` +
        `nothing while looking exactly like a rule that checked`,
      wouldBeEvaluableBy: "name at least one target, or omit the list entirely to deny the operation itself",
    };
  }
  return null;
}

/**
 * Does this policy govern anything — is it enabled, and is its rule
 * interpretable?
 *
 * The boolean form of {@link policyGovernanceFailure}, exported so a loader or a
 * scan can filter on the SAME reading the matcher uses rather than on its own
 * `enabled === true`. A second spelling of "does this policy count" is how the
 * two came to disagree in the first place.
 *
 * @param policy - anything at all; `false` is a valid answer.
 * @returns whether this policy can decide anything. NEVER throws.
 */
export function policyGoverns(policy: PolicyDefinition): boolean {
  try {
    return policyGovernanceFailure(policy) === null;
  } catch {
    return false;
  }
}

/**
 * DOES THIS RECORDED EVENT VIOLATE THIS RULE? EXTRACTION AND MATCHING TOGETHER,
 * IN ONE FUNCTION, BECAUSE SEPARATING THEM IS THE DEFECT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TAKES THE WHOLE EVENT RATHER THAN A FIELD SOMEBODY ALREADY READ
 * ---------------------------------------------------------------------------
 *
 * The obvious factoring is a reader (`readEgressHost`) that hands a string to a
 * matcher (`hostFallsUnder`). It was the factoring, and it produced a live false
 * all-clear: the reader accepted `host`/`hostname` as well as `url`, the matcher
 * only understood full URLs, and a payload carrying `host: "evil.example"` was
 * examined, counted fully legible, matched against nothing, and cleared. The
 * matcher was right, the reader was right, and the pair was wrong — which is
 * what "separately maintained" means.
 *
 * A NARROWER FIX — teaching the matcher to also accept a bare host — leaves two
 * places that must agree about what a host is, and the next spelling
 * (`endpoint`, an IPv6 literal, a port) reopens it. So the pair is not
 * maintained separately: THERE IS NO EXPORTED FUNCTION THAT DOES HALF OF THIS.
 * {@link hostForMatching} is reachable, but every band of the answer is produced
 * here, so a caller cannot obtain a host and then decide for itself what not
 * finding a match means.
 *
 * THE FIELD CANDIDATES ARE HERE AND NOT IN THE BACKEND for the same reason: a
 * spelling the emitter uses and the evaluator does not is a forbidden call
 * nobody sees, and that list must be one list.
 *
 * MUST NEVER THROW: it runs over stored rows nothing has vouched for, in a loop.
 *
 * @param event - a recorded event's type and payload. Anything at all.
 * @param rule - the rule to test it against.
 * @returns one of four bands. `undecidable` is NOT `permitted_by_this_rule`, and
 *   a caller that conflates them has rebuilt the defect this function replaced.
 */
export function matchRecordedEventAgainstPolicy(event: RecordedActEvent, policy: PolicyDefinition): RuleMatch {
  try {
    const ungoverned = policyGovernanceFailure(policy);
    if (ungoverned !== null) return ungoverned;
    const rule = policy.rule;
    const deciding = RULE_DECIDING_EVIDENCE[rule.kind];
    const eventType = (event as { type?: unknown })?.type;
    if (typeof eventType !== "string" || eventType !== deciding.eventType) {
      // SILENT, NOT CLEAN. An `llm.request` says nothing about a tool policy, and
      // a run made only of them has not been shown to comply — it has been shown
      // to contain no relevant events, which is a different sentence and is the
      // caller's to make.
      return { match: "not_relevant" };
    }

    // THE ONE CASE WHERE AN EXTERNALIZED PAYLOAD STILL PROVES A VIOLATION. The
    // type survives Event Log Rule 3; which target it was cannot change the
    // answer, because nothing is permitted. Checked BEFORE the payload is read,
    // since the payload is exactly what may be missing.
    if (ruleIsDecidableFromEventTypeAlone(rule)) {
      return { match: "forbidden", observedValue: null, decidedBy: "event_type_alone" };
    }

    const payload: unknown = (event as { payload?: unknown })?.payload;
    if (isExternalizedPayload(payload)) {
      return {
        match: "undecidable",
        kind: "evidence_externalized",
        because:
          `the ${deciding.eventType} payload was externalised past 10 KB (Event Log Rule 3), so ` +
          `\`${deciding.payloadField}\` is not in the event record`,
        wouldBeEvaluableBy: "fetch the artifact, verify its checksum, and re-evaluate",
      };
    }

    const raw = readDecidingValue(payload, rule.kind);
    if (raw === null) {
      return {
        match: "undecidable",
        kind: "deciding_field_unreadable",
        because:
          `the ${deciding.eventType} payload carries no readable \`${deciding.payloadField}\` ` +
          `(${JSON.stringify(payload ?? null).slice(0, 120)})`,
        wouldBeEvaluableBy: `emit \`${deciding.payloadField}\` as a non-empty string on ${deciding.eventType}`,
      };
    }

    if (rule.kind === "tool_denied") {
      const denied = rule.deniedTools as readonly string[];
      return denied.includes(raw)
        ? { match: "forbidden", observedValue: raw, decidedBy: "inline_payload" }
        : { match: "permitted_by_this_rule", observedValue: raw };
    }

    // EGRESS. Extraction and matching in the same breath — see this function's
    // header for the false all-clear that separating them produced.
    const host = hostForMatching(raw);
    if (host === null) {
      // PRESENT AND UNINTERPRETABLE IS NOT PERMITTED. This branch used to be
      // absent, and its absence cleared runs on values nobody could read.
      return {
        match: "undecidable",
        kind: "deciding_field_unreadable",
        because: `the recorded egress target ${JSON.stringify(raw)} could not be interpreted as a host`,
        wouldBeEvaluableBy:
          "emit `url` as an absolute URL, or `host` as a bare hostname, on http.request",
      };
    }
    const deniedHosts = rule.deniedHosts as readonly string[];
    return deniedHosts.some((denied) => hostFallsUnder(host, String(denied)))
      ? { match: "forbidden", observedValue: host, decidedBy: "inline_payload" }
      : { match: "permitted_by_this_rule", observedValue: host };
  } catch (err) {
    // A hostile payload is an undecidable event, never an exception. An
    // exception in an evaluation loop is an outcome nobody chose, and a caller
    // that wraps this in a try/catch would choose the permissive one.
    return {
      match: "undecidable",
      kind: "deciding_field_unreadable",
      because: `the event could not be inspected (${err instanceof Error ? err.message : String(err)})`,
      wouldBeEvaluableBy: "re-emit this event from a supported SDK version",
    };
  }
}

/**
 * The raw deciding value from a payload, or `null` when there is none.
 *
 * INTERNAL AND DELIBERATELY NOT EXPORTED. Exporting it would re-create the
 * reader/matcher pair whose divergence produced a false all-clear — a caller
 * holding a raw value would have to decide for itself what "no match" means, and
 * the honest answer depends on whether the value normalised, which only
 * {@link matchRecordedEventAgainstPolicy} knows.
 *
 * THE CANDIDATE SPELLINGS ARE THE UNION OF WHAT EMITTERS ACTUALLY WRITE. A
 * spelling an emitter uses and the evaluator does not is a forbidden call nobody
 * sees, so this list is the one list, and it lives beside the matcher rather
 * than in a backend module that could drift from it.
 */
function readDecidingValue(payload: unknown, kind: PolicyRuleKind): string | null {
  if (!isRecordLike(payload)) return null;
  const p = payload as Record<string, unknown>;
  const nested = isRecordLike(p["function"]) ? (p["function"] as Record<string, unknown>) : undefined;
  const candidates: unknown[] =
    kind === "tool_denied"
      ? [p["name"], p["tool"], p["tool_name"], p["toolName"], nested?.["name"]]
      : [p["url"], p["uri"], p["endpoint"], p["host"], p["hostname"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}


/** The inputs {@link decidePreflight} needs. */
export interface PolicyPreflightInput {
  /**
   * The listing in hand, or `null` FOR NONE.
   *
   * `null` rather than a fabricated empty listing, and the difference is the
   * whole of the unavailability policy: an empty listing is a server saying "no
   * policy governs this", and a `null` is us saying "we never got an answer". A
   * caller that manufactures the former from the latter has forged a permission.
   */
  readonly snapshot: PolicySnapshot | null;
  /** The act being proposed. */
  readonly act: ProposedAct;
  /** REQUIRED when `snapshot` is `null` or unusable: why. Carried into the answer. */
  readonly unavailableBecause?: string;
  /**
   * WHEN THE CLIENT RECEIVED THE LISTING, ON THE CLIENT'S OWN CLOCK, epoch ms.
   *
   * The honouring ceiling is anchored HERE and not on the server's `evaluatedAt`
   * — see `BudgetDecisionInput.receivedAt` in `budgets.ts` for the two-sided
   * failure that anchoring on a server timestamp produces (a server ahead buys
   * extra permission; a server behind declines a whole fleet). REQUIRED rather
   * than optional: an optional field with a fallback is the same defect behind a
   * `??`.
   */
  readonly receivedAt: number;
  /** Client clock now, epoch ms. Injected rather than read, so this function is pure and testable. */
  readonly now: number;
  readonly policy: PolicyUnavailablePolicy;
}

/** The reason string used when a caller declined to supply one. Never silently blank. */
const UNSTATED_REASON = "no reason was supplied by the caller";

/**
 * EVERY REASON A POLICY LISTING MUST NOT BE ANSWERED FROM.
 *
 * MUST NEVER THROW.
 *
 * @param snapshot - anything at all.
 * @returns every refusal reason. Empty means the listing may be answered from.
 */
export function policySnapshotRefusals(snapshot: PolicySnapshot): string[] {
  try {
    if (!isRecordLike(snapshot)) return ["the policy listing is not an object"];
    const refusals: string[] = [];
    const s = snapshot as unknown as Record<string, unknown>;
    if (!isFiniteNumber(s["evaluatedAt"])) refusals.push("evaluatedAt is not a finite number");
    if (!isCount(s["shelfLifeMs"]) || s["shelfLifeMs"] <= 0) {
      refusals.push("shelfLifeMs is not a positive whole number of milliseconds");
    }
    if (!isCount(s["policiesInScope"])) refusals.push("policiesInScope is not a count");
    if (typeof s["listingTruncated"] !== "boolean") refusals.push("listingTruncated is not a boolean");
    if (!isRecordLike(s["subject"])) refusals.push("the listing carried no subject to check against the request");
    if (!Array.isArray(s["policies"])) refusals.push("policies is not an array");
    for (const [index, policy] of indexedElements<PolicyDefinition>(s["policies"]).entries()) {
      if (policy === null) {
        refusals.push(`policies[${index}] is not an object`);
        continue;
      }
      if (!isNonEmptyString(policy.policyId)) refusals.push(`policies[${index}].policyId is missing`);
      if (!isCount(policy.revision)) refusals.push(`policies[${index}].revision is not a count`);
      // FAILS CLOSED. A rule kind we cannot interpret is not one to skip:
      // skipping it is how a listing that forbids the act reads as one that does
      // not.
      if (!isRecordLike(policy.rule) || !(POLICY_RULE_KINDS as readonly string[]).includes(policy.rule.kind)) {
        refusals.push(
          `policies[${index}].rule is not a known rule kind ` +
            `(${JSON.stringify((policy.rule as { kind?: unknown })?.kind ?? null)})`
        );
      }
      if (!isNonEmptyString(policy.rationale)) {
        refusals.push(`policies[${index}].rationale is missing — a prohibition with no stated reason`);
      }
      if (typeof policy.enabled !== "boolean") refusals.push(`policies[${index}].enabled is not a boolean`);
    }
    // The same total sweep the evaluation gets. A listing is a wire body too, and
    // `suppressViolation` planted on a policy definition is the worst possible
    // place for it — see invariant 0.
    for (const finding of forbiddenContentIn(snapshot, "(listing)")) {
      refusals.push(`${finding.path}: ${finding.reason}`);
    }
    return refusals;
  } catch (err) {
    return [`the policy listing could not be inspected (${err instanceof Error ? err.message : String(err)})`];
  }
}

/**
 * THE PRE-FLIGHT RULE, in one place, for every surface that asks one.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE, AND WHY EACH STEP IS WHERE IT IS
 * ---------------------------------------------------------------------------
 *
 *  1. AN UNTRUSTWORTHY LISTING IS NO LISTING. Gated in the primitive, so every
 *     caller is gated rather than the one that remembered a gate.
 *
 *  2. A MATCHING POLICY ADVISES AGAINST, EVEN ON A STALE OR TRUNCATED LISTING.
 *     Checked BEFORE freshness, and the ordering is load-bearing for the same
 *     reason a trip is checked before freshness in `budgets.ts`: A PROHIBITION
 *     DOES NOT LAPSE BY AGEING. If the last thing we heard was "this tool is
 *     forbidden" and we cannot re-ask, the honest reading is that it still is.
 *     Freshness first would let an agent call anything for as long as it could
 *     keep the server unreachable.
 *
 *  3. A TRUNCATED OR SHORT LISTING CANNOT ANSWER A NEGATIVE QUESTION. Folded
 *     into "no usable answer" and adjudicated by the caller's policy. NOTE THE
 *     ASYMMETRY with step 2: a positive match is established regardless of what
 *     else went unread; a negative one is not.
 *
 *  4. NO USABLE LISTING -> THE POLICY DECIDES.
 *
 *  5. A COMPLETE, FRESH LISTING WITH ZERO POLICIES ->
 *     `no_policy_governs_this_subject`, never `no_listed_policy_forbids_this_act`.
 *
 * MUST NEVER THROW. It sits in the hot path of somebody's agent loop, on a body
 * nothing has vouched for, and an exception here is an outcome nobody wrote a
 * meaning for — which inside a `try/catch` around a tool call means "proceed".
 *
 * @param input - listing (or `null`), the act, clocks, and the explicit
 *   unavailability policy.
 * @returns one of six bands. Use {@link mayProceedWithAct} for the boolean.
 */
export function decidePreflight(input: PolicyPreflightInput): PolicyPreflightAnswer {
  const now = isFiniteNumber(input?.now) ? input.now : Number.NaN;
  const receivedAt = isFiniteNumber(input?.receivedAt) ? input.receivedAt : Number.NaN;
  const policy = input?.policy;
  const act = input?.act;
  let because =
    isNonEmptyString(input?.unavailableBecause) ? input.unavailableBecause : UNSTATED_REASON;

  let snapshot = isRecordLike(input?.snapshot) ? (input.snapshot as PolicySnapshot) : null;

  // STEP 1 — the gate, in the primitive.
  if (snapshot !== null) {
    const refusals = policySnapshotRefusals(snapshot);
    if (refusals.length > 0) {
      because = `the policy listing cannot be answered from: ${refusals.join("; ")}`;
      snapshot = null;
    }
  }

  const mode = (policy as { onUnavailable?: unknown })?.onUnavailable;
  const proposedValue = typeof act?.value === "string" ? act.value : "";

  // A policy this contract does not define is not one to guess at. Fails CLOSED —
  // a caller bug in an advisory path reads as "advise against".
  if (mode !== "deny" && mode !== "grace" && mode !== "allow") {
    return {
      answer: "advised_against_without_answer",
      advisedByPolicy: "deny",
      noAnswerBecause: `no valid PolicyUnavailablePolicy was supplied (got ${JSON.stringify(mode ?? null)})`,
      wouldBeAnsweredBy:
        "construct the preflight with an explicit { onUnavailable: 'deny' | 'grace' | 'allow' } policy — there is " +
        "deliberately no default, because failing open and failing closed have different costs paid by different " +
        "people",
      advisedAt: isFiniteNumber(now) ? now : 0,
      recordRegardless: true,
    };
  }

  // A malformed act cannot be checked against anything. Fails closed, INCLUDING
  // under `allow`: `allow` means "proceed when the SERVER could not answer", not
  // "proceed when the caller passed nonsense".
  if (!isRecordLike(act) || !(POLICY_RULE_KINDS as readonly string[]).includes(act.kind) || proposedValue === "") {
    return {
      answer: "advised_against_without_answer",
      advisedByPolicy: mode === "allow" ? "deny" : mode,
      noAnswerBecause:
        `the proposed act is not one this contract can check ` +
        `(kind=${JSON.stringify((act as { kind?: unknown })?.kind ?? null)}, value=${JSON.stringify(proposedValue)})`,
      wouldBeAnsweredBy:
        `pass { kind, value } where kind is one of ${POLICY_RULE_KINDS.join(", ")} and value is the tool name or URL`,
      advisedAt: isFiniteNumber(now) ? now : 0,
      recordRegardless: true,
    };
  }

  // STEP 2 — A MATCH ADVISES AGAINST, REGARDLESS OF FRESHNESS OR TRUNCATION.
  if (snapshot !== null) {
    const forbidding = soundElements<PolicyDefinition>(snapshot.policies).find((p) => actIsForbiddenBy(p, act));
    if (forbidding !== undefined) {
      return {
        answer: "advised_against_by_policy",
        advisingPolicyId: forbidding.policyId,
        advisingPolicyRevision: forbidding.revision,
        advisingRationale: forbidding.rationale,
        proposedValue,
        advisedAt: isFiniteNumber(now) ? now : 0,
        recordRegardless: true,
      };
    }
  }

  const unavailable = (reason: string, remedy: string): PolicyPreflightAnswer => {
    if (mode === "allow") {
      return {
        answer: "proceeded_without_policy_answer",
        proceededByPolicy: "allow",
        unansweredBecause: reason,
        allowAcceptedRisk: (policy as { acceptedRisk?: string }).acceptedRisk ?? UNSTATED_REASON,
        unansweredAt: isFiniteNumber(now) ? now : 0,
        recordRegardless: true,
      };
    }
    return {
      answer: "advised_against_without_answer",
      advisedByPolicy: mode,
      noAnswerBecause: reason,
      wouldBeAnsweredBy: remedy,
      advisedAt: isFiniteNumber(now) ? now : 0,
      recordRegardless: true,
    };
  };

  if (!isFiniteNumber(now)) {
    return unavailable(
      "the client clock supplied to decidePreflight was not a finite number, so freshness could not be evaluated",
      "pass a real epoch-ms timestamp as `now`"
    );
  }
  if (snapshot === null) {
    return unavailable(because, "call FlightReader.getPolicySnapshot() for this subject");
  }
  if (!isFiniteNumber(receivedAt)) {
    return unavailable(
      "no client-observed `receivedAt` was supplied, so the honouring ceiling could not be anchored on a clock this " +
        "process controls",
      "record the client clock at the moment the listing arrives and pass it as `receivedAt`"
    );
  }
  if (receivedAt > now) {
    // Two CLIENT instants in an order one clock cannot produce — either the
    // arrival was stamped from a different clock, or the clock moved backward
    // between receipt and check. Fails closed, like everything else this function
    // cannot make sense of.
    return unavailable(
      `the listing's arrival (${receivedAt}) is later than the moment of this check (${now}), which no single ` +
        `clock can produce`,
      "stamp `receivedAt` and `now` from the SAME clock, as PolicyPreflight does, and re-request the listing"
    );
  }

  // STEP 3 — a truncated or short listing cannot answer a NEGATIVE question.
  // Reached only after step 2 established that nothing READ forbids the act.
  const listed = soundElements<PolicyDefinition>(snapshot.policies).length;
  if (snapshot.listingTruncated === true || listed !== snapshot.policiesInScope) {
    return unavailable(
      `the policy listing is incomplete (${listed} of ${snapshot.policiesInScope} policies listed` +
        `${snapshot.listingTruncated ? ", listing truncated" : ""}), and an incomplete listing cannot establish ` +
        `that nothing forbids this act — the policy that does is as likely to be in the unread tail as anywhere ` +
        `else`,
      "re-request the policy listing; if the server keeps truncating, the subject is governed by more policies " +
        "than the listing ceiling allows"
    );
  }

  const effectiveGoodUntil = receivedAt + Math.min(snapshot.shelfLifeMs, MAX_POLICY_ANSWER_FRESHNESS_MS);

  if (now <= effectiveGoodUntil) {
    // STEP 5 — nothing governs this subject. Its own band.
    if (snapshot.policiesInScope === 0) {
      return {
        answer: "no_policy_governs_this_subject",
        policiesInScope: 0,
        ungovernedSubject: snapshot.subject,
        ungovernedAt: now,
        recordRegardless: true,
      };
    }
    const consulted = soundElements<PolicyDefinition>(snapshot.policies)
      .map((p) => p.policyId)
      .filter((id): id is string => isNonEmptyString(id));
    if (consulted.length === 0) {
      return unavailable(
        "the listing reports policies in scope but carries no readable policy id for any of them",
        "re-request the policy listing"
      );
    }
    return {
      answer: "no_listed_policy_forbids_this_act",
      consultedPolicyIds: consulted as [string, ...string[]],
      listingGoodUntil: effectiveGoodUntil,
      recordRegardless: true,
    };
  }

  // STALE. Grace honours a COMPLETE listing we actually received, for a bounded
  // window. It never invents one, and it cannot be reached without a listing that
  // was complete at step 3.
  if (mode === "grace") {
    const graceMs = Math.min((policy as { graceMs: number }).graceMs, MAX_POLICY_GRACE_MS);
    const graceEndsAt = effectiveGoodUntil + (isCount(graceMs) ? graceMs : 0);
    if (now <= graceEndsAt) {
      return {
        answer: "proceeded_within_grace",
        honouredListingExpiredAt: effectiveGoodUntil,
        graceEndsAt,
        unreachableBecause: because,
        graceAcceptedRisk: (policy as { acceptedRisk?: string }).acceptedRisk ?? UNSTATED_REASON,
        recordRegardless: true,
      };
    }
  }

  return unavailable(
    `the policy listing expired at ${new Date(effectiveGoodUntil).toISOString()} and could not be refreshed ` +
      `(${because})`,
    "call FlightReader.getPolicySnapshot() again"
  );
}

// ===========================================================================
// PART H — PRIVILEGED MUTATIONS. The write path, owned by `convex/`.
//
// ADMIN operations, audited server-side into the append-only admin audit log
// (CLAUDE.md Event Log Rule 6). These shapes live here so the CLI, the web UI
// and the Convex mutation are built from one vocabulary; nothing in the SDK or
// CLI may define a policy except by calling the admin-gated route.
// ===========================================================================

/**
 * Create or replace a policy definition. Admin-gated and audited server-side.
 *
 * NOTE WHAT IS ABSENT AND CANNOT BE ADDED WITHOUT REOPENING INVARIANT 0: there is
 * no `action`, no `onViolation`, no `severity` that gates recording. A policy
 * says what must not happen. It does not say what to do to the event that shows
 * it happened, because the answer is always the same — record it.
 */
export interface UpsertPolicyRequest {
  /** Omit to create; supply to replace. The revision is bumped server-side. */
  readonly policyId?: string;
  readonly name: string;
  readonly rule: PolicyRule;
  readonly subject: PolicySubject;
  /** REQUIRED, non-empty. Travels into every outcome this policy produces. */
  readonly rationale: string;
  readonly enabled: boolean;
}

/**
 * Disable a policy.
 *
 * SEPARATE FROM `UpsertPolicyRequest`, deliberately: changing what a policy
 * forbids and switching it off are different acts with different blast radii, and
 * an operator who wanted the second should not be able to do the first by
 * supplying one extra field. Same argument as `ManualResetRequest` in
 * `budgets.ts`.
 *
 * THERE IS NO DELETE. A policy that governed recorded runs is part of how those
 * runs were judged; removing the row would make past outcomes uninterpretable —
 * `violatedPolicyRevision` would point at nothing. Disabling is the operation,
 * and it is audited.
 */
export interface DisablePolicyRequest {
  readonly policyId: string;
  /** REQUIRED, non-empty. Written to the admin audit log. */
  readonly reason: string;
}

/** The result of a privileged policy mutation. `auditLogId` is the receipt. */
export interface PolicyMutationResult {
  readonly policyId: string;
  readonly revision: number;
  /** The append-only admin audit log entry this mutation wrote. The receipt an operator can cite. */
  readonly auditLogId: string;
  readonly appliedAt: number;
}

// ---------------------------------------------------------------------------
// Local predicates. Deliberately duplicated rather than imported from
// `budgets.ts`: contracts has zero runtime dependencies and these are four-line
// predicates, so a cross-module import would couple two vocabularies that must be
// able to change independently.
// ---------------------------------------------------------------------------

/** A count of things: a non-negative integer. Rejects NaN, infinities, strings, null and negatives at once. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A real point in time. Rejects NaN and infinities, which arithmetic silently swallows. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A non-empty string, and nothing else. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** An element that is at least shaped like a record. `null`, arrays and primitives are not. */
function isRecordLike(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Elements that can actually be computed with; malformed ones removed. For consumers. */
function soundElements<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecordLike) as T[];
}

/** Elements with POSITIONS PRESERVED, malformed ones surfaced as `null`. For the reporting functions. */
function indexedElements<T>(value: unknown): (T | null)[] {
  if (!Array.isArray(value)) return [];
  return value.map((element) => (isRecordLike(element) ? (element as T) : null));
}
