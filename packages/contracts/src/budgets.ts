// ---------------------------------------------------------------------------
// BUDGET CIRCUIT BREAKERS — "may this agent spend any more?"
//
// This is the first feature in this product where the SDK does something other
// than record, and the risk profile is not the one the rest of this codebase
// was built for. A recording bug loses data. AN ENFORCEMENT BUG STOPS A
// COMPANY'S AGENTS FROM WORKING. Everything below is shaped by that asymmetry.
//
// The backend can compute that a breaker is tripped. Only the SDK sits in the
// agent's process and can DECLINE TO PROCEED. Those are two different facts
// owned by two different parties, and this file's whole job is to keep them —
// and a third thing nobody owns — apart.
//
// ---------------------------------------------------------------------------
// INVARIANT 1 — WE RECORD, WE DECLINE, WE DO NOT STOP
// ---------------------------------------------------------------------------
//
// THE SDK CANNOT STOP A PROCESS THAT IGNORES IT. It returns a decision. A
// caller that reads the decision and proceeds anyway is not a bug in this
// contract, it is the only thing that could ever have happened — the SDK is a
// library inside someone else's loop, not a supervisor above it.
//
// So there are exactly two facts here that we own, and one we never do:
//
//   OWNED   "The breaker is tripped."  A fact about the BREAKER, established by
//                                      the server from spend it summed.
//   OWNED   "The SDK declined."        A fact about THE SDK's own return value,
//                                      established by the code below.
//   NEVER   "The agent halted."        A fact about a process we do not control
//                                      and cannot observe. NOTHING in this
//                                      contract may assert it.
//
// The third one is the dangerous one, and it is dangerous in a specific,
// operational way: a field named `enforced`, `blocked`, `halted`, `stopped` or
// `prevented` becomes a line in an incident review, a number on a dashboard,
// and eventually a compliance claim — "spend was capped" — that nobody can
// support. The gap between "we returned deny" and "the spend did not happen" is
// invisible on every screen that renders such a field, and it is exactly the
// gap an auditor is asking about.
//
// THE BARRIER IS THE SAME ONE THIS CODEBASE HAS NOW BUILT FOUR TIMES (proven vs
// speculative in `divergence.ts`, observed vs hypothesised in
// `fleet_health.ts`, recorded vs inferred in `causality.ts`, told-yes vs
// not-asked here):
//
//   1. NO TYPE, FIELD OR HELPER NAMES THE AGENT AS ITS SUBJECT. Every band
//      below is named for the breaker or for the SDK. There is
//      {@link wasDeclinedBySdk} and there is deliberately no `wasAgentStopped`,
//      because there is no honest implementation of one.
//   2. THE VOCABULARY IS ENUMERATED AND CHECKED AT THE WIRE.
//      {@link FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS} is the list a server body may
//      not carry. A backend that adds `enforced: true` is refused by the SDK
//      gate rather than rendered — the same treatment `SuspectedLink`'s banned
//      prose headline gets, and for the same reason: every other barrier stops
//      a CONSUMER over-claiming by forgetting something, and a transmitted
//      field lets the PRODUCER do it in one keystroke.
//   3. THE SENTENCE IS COMPOSED, NEVER TRANSMITTED. {@link decisionStatement}
//      is the only prose a surface should render, and its decline branches say
//      what the SDK did and then say, in the same breath, what that does not
//      mean.
//
// ---------------------------------------------------------------------------
// INVARIANT 2 — "I WAS TOLD YES" AND "I COULD NOT ASK" ARE DIFFERENT TYPES
// ---------------------------------------------------------------------------
//
// A breaker that fails OPEN when it cannot reach the server is not a breaker:
// anyone who wants to bypass it causes a network error. A breaker that fails
// CLOSED halts honest work during an outage of OURS. Both costs are real, they
// are paid by different people, and no library gets to pick on their behalf.
//
// So the choice is a REQUIRED, EXPLICIT parameter — {@link BudgetUnavailablePolicy}
// — and not a default buried in a catch block. Two of its three arms
// additionally require the caller to write down `acceptedRisk` in prose, which
// is the same forcing function as `SuspectedLink.notAnEdgeBecause`: you may
// weaken the breaker, and you may not do it silently.
//
// WHATEVER IS CHOSEN, THE OUTCOME IS NEVER LAUNDERED. There are three ways this
// contract can say "proceed" and they are three different types sharing no
// field:
//
//   {@link AllowedByArmedBreaker}   we ASKED and were told there is headroom.
//   {@link AllowedWithinGrace}      the last yes EXPIRED, the server is
//                                   unreachable, and we are inside a bounded
//                                   grace the caller configured.
//   {@link AllowedWithoutAnswer}    we never got an answer and the policy says
//                                   proceed anyway.
//
// A single `allowed: true` would have made those one thing on every dashboard
// that counts them. They are not one thing: the third is an unenforced call,
// and an org whose "allowed" count is 100% third-band has no budget control at
// all while its graphs look identical to an org that has.
//
// ---------------------------------------------------------------------------
// INVARIANT 3 — AN APPROXIMATE FIGURE IS NOT A SMALL EXACT ONE
// ---------------------------------------------------------------------------
//
// ADR-002 is explicit that `usage_counters` is approximate and NOT billing
// grade: single-unit increments are flushed roughly one time in ten and scaled
// by ten when they are. That is a sampled estimator. It is not a floor and it
// is not a ceiling — IT CAN BE WRONG IN EITHER DIRECTION.
//
// A hard limit built on such a figure is a lie unless the approximation is IN
// THE TYPE, and the stakes are the concrete ones: an APPROXIMATE spend of $99
// against a $100 limit and an EXACT spend of $99 against a $100 limit are not
// the same claim, and the difference decides whether somebody's production
// agents stop.
//
// This is `FleetShareMeasurement`'s `null`-versus-`0` lesson with money
// attached, and it gets the strongest form of the barrier:
//
//   1. TWO TYPES, MUTUALLY UNASSIGNABLE, SHARING NO FIELD.
//      {@link ReconciledSpend} carries `reconciledAmount`;
//      {@link ApproximateSpend} carries `estimatedAmount`. There is no
//      `amount`, no `spent`, no `total`. `spend.amount >= limit.limitAmount`
//      DOES NOT COMPILE against either type, so the comparison every consumer
//      would otherwise write by hand cannot be written at all.
//   2. THE COMPARISON IS THREE-VALUED AND LIVES IN ONE FUNCTION.
//      {@link compareSpendToLimit} returns `provably_at_or_over`,
//      `provably_under` or `not_decidable`. An approximate figure that
//      STRADDLES the limit given its own stated error bounds returns
//      `not_decidable` — it does not round toward either, and it certainly
//      does not round toward "under".
//   3. THE ERROR BOUNDS ARE `number | null`, AND `null` IS NOT `0`.
//      `couldUnderstateBy: null` means UNBOUNDED — nobody measured how wrong
//      this can be — and it makes `provably_under` UNREACHABLE. An estimator
//      with no stated bound can never establish headroom, however comfortable
//      the number looks. `couldUnderstateBy: 0` would be the claim that the
//      figure cannot be low, which is a claim `usage_counters` cannot make.
//   4. AN APPROXIMATE FIGURE CAN STILL TRIP A BREAKER, and that asymmetry is
//      deliberate. Establishing "provably at or over" from an estimate requires
//      the estimate MINUS its overstatement bound to still clear the limit —
//      a harder test than the naive comparison, but a reachable one. Spend that
//      is provably over should stop; spend that merely might be under should
//      not be certified as headroom. The two directions have different costs
//      and the type does not pretend otherwise.
//
// A negative test asserting all three invariants (via `@ts-expect-error`, which
// fails the build if any conflation ever BECOMES legal) lives at
// `tests/unit/budget_claim_boundary.test.ts` and
// `tests/unit/budget_exactness.test.ts`.
//
// See `packages/sdk/src/budget-guard.ts` for the enforcement seam and
// `packages/sdk/src/reader.ts` (`getBudgetSnapshot`) for the wire gate: the
// same segregation re-checked at runtime, because a server is not typechecked
// by us and TypeScript's guarantee stops at the wire.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The limit itself
// ---------------------------------------------------------------------------

/**
 * What a budget governs.
 *
 * CLOSED SET, and a stored value — a Convex index over budgets keeps this
 * string in its `scope` column, so contracts is the authority on the spelling
 * (CLAUDE.md, Repo Conventions -> Types) and a backend that spells one
 * differently is a migration, not a variant.
 */
export type BudgetScope = "org" | "project" | "agent" | "agent_version" | "run";

/** The frozen scope vocabulary, as a runtime array, for a schema validator to be BUILT FROM rather than retyped. */
export const BUDGET_SCOPES: readonly BudgetScope[] = ["org", "project", "agent", "agent_version", "run"];

/** The window a budget's meter resets over. `run` is per-execution; `lifetime` never resets. */
export type BudgetPeriod = "run" | "hour" | "day" | "month" | "lifetime";

/** The frozen period vocabulary, as a runtime array. */
export const BUDGET_PERIODS: readonly BudgetPeriod[] = ["run", "hour", "day", "month", "lifetime"];

/**
 * What is being counted.
 *
 * `cost_minor_units` IS AN INTEGER COUNT OF THE CURRENCY'S SMALLEST UNIT
 * (cents, pence, yen), never a decimal. Floating-point money is how a limit of
 * 100.00 is compared against a spend of 100.00000000000001 and a company's
 * agents stop for a rounding error — or, in the direction that costs money,
 * how 99.99999999999999 reads as under.
 */
export type BudgetMeter = "cost_minor_units" | "tokens_in" | "tokens_out" | "runs_started" | "events_ingested";

/** The frozen meter vocabulary, as a runtime array. */
export const BUDGET_METERS: readonly BudgetMeter[] = [
  "cost_minor_units",
  "tokens_in",
  "tokens_out",
  "runs_started",
  "events_ingested",
];

/**
 * A ceiling on what an agent may spend.
 *
 * A DEFINITION, not a measurement. It says nothing about what has been spent —
 * that is a {@link SpendFigure}, and the two are compared only by
 * {@link compareSpendToLimit}.
 */
export interface BudgetLimit {
  budgetId: string;
  /** Org-scoping is enforced backend-side (CLAUDE.md Tenancy Rules); carried here so a client can display it. */
  orgId: string;
  scope: BudgetScope;
  /** The id of the entity this budget governs. For `scope: "org"`, the org's own id. */
  scopeId: string;
  meter: BudgetMeter;
  period: BudgetPeriod;
  /**
   * The ceiling, in the meter's own unit. Minor units for `cost_minor_units`;
   * whole counts otherwise. INTEGER — see {@link BudgetMeter}.
   */
  limitAmount: number;
  /** ISO 4217 code for cost meters (`"USD"`). Absent for count meters. */
  currency?: string;
  /** A disabled budget governs nothing. It is NOT the same as a budget with a high limit. */
  enabled: boolean;
  createdAt: number;
}

/** Who or what a breaker question is being asked about. At least one field must be set. */
export interface BudgetSubject {
  orgId?: string;
  projectId?: string;
  agentId?: string;
  agentVersionId?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// SPEND — exact and approximate, as two irreconcilable types
// ---------------------------------------------------------------------------

/**
 * The proof that licenses a {@link ReconciledSpend}, and the only thing that can.
 *
 * `logReadComplete` IS THE LITERAL TYPE `true`, not `boolean`. A summation that
 * stopped on a ceiling CANNOT construct this object — `false` is not assignable
 * to `true` — so a partial sum presented as reconciled is a compile error
 * rather than a convention someone is trusted to keep. Same construction as
 * `OriginProof.inboundReadComplete` in `causality.ts`, for the same reason: the
 * illegal state is not merely unreachable through a validator, it is
 * unspellable.
 */
export interface SpendReconciliation {
  proves: "event_log_summed";
  /** The budget this sum was taken for. Checked against the figure's own budget. */
  budgetId: string;
  /** Runs included in the sum. */
  runsSummed: number;
  /** Events read. The event log is the source of truth (CLAUDE.md Event Log Rule 1). */
  eventsSummed: number;
  /** LITERAL `true`. A truncated read cannot be spelled here. */
  logReadComplete: true;
  reconciledAt: number;
}

/**
 * SPEND SUMMED FROM THE IMMUTABLE EVENT LOG. Exact, as of `reconciledThrough`.
 *
 * Safe to compare directly against a limit. Never assignable to or from
 * {@link ApproximateSpend}: distinct `basis` literal, plus
 * `reconciledAmount`/`reconciledThrough`/`establishedBy` which the other lacks,
 * and NO FIELD IN COMMON WITH IT AT ALL. A renderer cannot write one template
 * that handles both, because there is no property common to both that carries a
 * number.
 */
export interface ReconciledSpend {
  /** Discriminant. The structural barriers are `reconciledAmount` and `establishedBy`. */
  basis: "reconciled";
  /**
   * The sum, in the meter's unit.
   *
   * DELIBERATELY NOT NAMED `amount`, `spent` or `total`.
   * {@link ApproximateSpend} calls its number `estimatedAmount`, so there is no
   * property a consumer can read — or compare to a limit — without first
   * knowing which kind of figure it is holding.
   */
  reconciledAmount: number;
  /** High-water mark of the sum, epoch ms. Spend after this is not included. */
  reconciledThrough: number;
  /** The budget this figure is about. A figure for a different budget proves nothing. */
  forBudgetId: string;
  /** THE PROOF. NON-EMPTY BY TYPE: a reconciled figure with nothing behind it does not compile. */
  establishedBy: [SpendReconciliation, ...SpendReconciliation[]];
}

/** Why a figure is approximate rather than reconciled. Facts about the SOURCE, never about the agent. */
export type SpendApproximationKind =
  /**
   * ADR-002 `usage_counters`: single-unit increments are flushed ~1-in-10 and
   * scaled 10x when they are. A SAMPLED ESTIMATOR — wrong in either direction,
   * by an amount nobody bounded.
   *
   * ---------------------------------------------------------------------------
   * THE JUSTIFICATION IS THE SAMPLING, AND THAT LINK IS LOAD-BEARING
   * ---------------------------------------------------------------------------
   *
   * Every refusal to treat this counter as spend — the backend declining to
   * read it, `couldUnderstateBy: null` defaulting to unbounded, an estimate
   * near a cap comparing `not_decidable` — rests on ONE fact: the counter is
   * sampled. It is not a policy about where numbers come from; it is a
   * consequence of how this particular number is made.
   *
   * SO IF SOMEBODY EVER MAKES `usage_counters` EXACT, EVERY ONE OF THOSE
   * REFUSALS BECOMES UNJUSTIFIED — AND NOTHING HERE WILL FAIL. The types still
   * compile, the tests still pass, and the product quietly keeps declining to
   * read a figure it now has every right to trust, which near a cap means
   * declining deploys it should permit. A defect that arrives by someone
   * IMPROVING an unrelated table is exactly the kind no test written today
   * catches, so the dependency is written down here, at the member that names
   * the counter, rather than only in a review ledger.
   *
   * If ADR-002's sampling changes, this member and its consumers change with
   * it — and a figure from an exact counter is a {@link ReconciledSpend}, not
   * an approximate one wearing a better bound.
   */
  | "sampled_usage_counter"
  /** ADR-002 `daily_rollups`: percentiles and totals over a bounded sample (<= 5,000 runs/agent/day). */
  | "bounded_sample_rollup"
  /** A denormalised running counter on the run record (`tokensIn`/`tokensOut`), monotonic but not re-derived. */
  | "denormalised_run_counter"
  /** Priced from a model rate card rather than a billed invoice. The rate may not be the rate we are charged. */
  | "modelled_from_rate_card";

/**
 * SPEND ESTIMATED FROM A SAMPLED OR DERIVED SOURCE. NOT A MEASUREMENT OF SPEND.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOUNDS ARE `number | null` AND WHY `null` IS NOT `0`
 * ---------------------------------------------------------------------------
 *
 * `couldUnderstateBy: null` says NOBODY MEASURED HOW WRONG THIS CAN BE. It is
 * an honest statement a producer can legitimately make about
 * `usage_counters` — the sampling error is unbounded without knowing how many
 * single-unit increments went unflushed — and it makes `provably_under`
 * UNREACHABLE in {@link compareSpendToLimit}. That is the correct consequence,
 * not a gap: an estimator with no stated bound cannot establish headroom,
 * however comfortable its number looks.
 *
 * `couldUnderstateBy: 0` would be the claim that this figure CANNOT BE LOW.
 * That is a claim about the estimator, it is a claim `usage_counters` cannot
 * support, and it is a completely different sentence from "we did not check".
 * A single `number` field would have collapsed the two, and the collapse points
 * in the direction that certifies headroom.
 *
 * Never assignable to or from {@link ReconciledSpend}.
 */
export interface ApproximateSpend {
  /** Discriminant. The structural barriers are `estimatedAmount`, `couldUnderstateBy` and `approximateBecause`. */
  basis: "approximate";
  kind: SpendApproximationKind;
  /**
   * The estimate, in the meter's unit.
   *
   * DELIBERATELY NOT NAMED `amount` — see {@link ReconciledSpend.reconciledAmount}.
   * THIS NUMBER IS NOT A SPEND. It is what a sampled counter reported, and it
   * may be above or below the truth.
   */
  estimatedAmount: number;
  /**
   * How far BELOW the truth this estimate could be, or `null` for UNBOUNDED —
   * NOT ZERO, and never conflate the two. `null` makes `provably_under`
   * unreachable, which is the point.
   */
  couldUnderstateBy: number | null;
  /** How far ABOVE the truth this estimate could be, or `null` for UNBOUNDED. `null` makes `provably_at_or_over` unreachable. */
  couldOverstateBy: number | null;
  /**
   * REQUIRED: why this is not a reconciled figure. "ADR-002 usage_counters
   * flushes single-unit increments ~1-in-10 and scales by 10x; the residual is
   * not bounded."
   *
   * Forcing the producer to write the limit down at the point of emitting the
   * estimate is what keeps estimates honest — the same discipline as
   * `SuspectedLink.notAnEdgeBecause`.
   */
  approximateBecause: string;
  /**
   * REQUIRED: what would produce an exact figure — "sum `llm.response` events
   * for this run from the event log".
   *
   * The difference between a product that hands someone a number they cannot
   * trust and one that hands them the way to get one they can.
   */
  wouldBeReconciledBy: string;
  /** The budget this figure is about. */
  forBudgetId: string;
  sampledAt: number;
}

/**
 * A spend figure, exact or estimated.
 *
 * THE ONE PLACE THIS FILE EXPORTS A UNION OF THE TWO, and it is safe for
 * exactly the reason `ChainTerminus` is: a figure fills a SINGLE SLOT rather
 * than typing a list, and the two members SHARE NO PROPERTY except the
 * discriminant — not an amount, not a timestamp, not a message — so the union
 * is USELESS UNNARROWED. Every access whatsoever forces a `basis` check. That
 * is a stronger guarantee than omitting the union would give, since the
 * alternative (two optional fields) admits all-absent and all-present.
 */
export type SpendFigure = ReconciledSpend | ApproximateSpend;

/**
 * What a spend figure is FIT FOR.
 *
 * Three-valued for the reason `BaseRateUsability` is: a guard written as a
 * comparison (`x >= limit`) does not reject a non-number, it takes the other
 * branch, and whether that branch is safe is luck. `'188' >= 100` is `true` by
 * JS coercion; `NaN >= 100` is `false` and every check downstream is skipped.
 * Asked directly, once, before any arithmetic.
 */
export type SpendUsability =
  /** Every field is a real number and the bounds are stated. Arithmetic is safe. */
  | "usable"
  /**
   * Honestly declared as unbounded (`null` bounds). Legal, and it says
   * something specific: this figure cannot establish headroom.
   */
  | "unbounded"
  /**
   * MALFORMED: absent, wrong-typed, non-finite, negative, or a reconciled
   * figure with no proof behind it. NOT a statement a producer can legitimately
   * make — the SDK REFUSES a snapshot carrying one rather than quietly reading
   * it as "unbounded".
   */
  | "unusable";

/** A count of currency minor units or of items: a non-negative integer. Rejects NaN, infinities, strings, null and negatives at once. */
function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A real point in time. Rejects NaN and infinities, which arithmetic silently swallows. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

/** A stated error bound: `null` (unbounded, legal) or a non-negative integer. Anything else is malformed. */
function isBound(value: unknown): value is number | null {
  return value === null || isAmount(value);
}

/**
 * Can this figure be compared, and if not, is that because nobody bounded the
 * estimate or because what arrived is not a figure?
 *
 * THE SINGLE DEFINITION, so the SDK gate, the CLI, the web UI and the MCP
 * surface cannot each invent a slightly different notion of "usable".
 *
 * MUST NEVER THROW: it runs at a boundary, on a JSON body nothing has vouched
 * for.
 *
 * @param spend - the figure to inspect. Anything at all; unusable is a valid answer.
 * @returns `usable` when arithmetic against a limit is sound in at least one
 *   direction, `unbounded` when the producer honestly declared no bound, and
 *   `unusable` when what arrived is not a figure.
 */
export function spendUsability(spend: SpendFigure): SpendUsability {
  if (!isRecordLike(spend)) return "unusable";
  const s = spend as unknown as Record<string, unknown>;
  if (typeof s["forBudgetId"] !== "string" || s["forBudgetId"].length === 0) return "unusable";

  if (s["basis"] === "reconciled") {
    if (!isAmount(s["reconciledAmount"])) return "unusable";
    if (!isFiniteNumber(s["reconciledThrough"])) return "unusable";
    // A reconciled figure with no complete-read proof behind it is an
    // APPROXIMATE FIGURE WEARING AN EXACT ONE'S CLOTHES — the money analogue of
    // `unproven_origin`, and the single input that can certify headroom.
    const proofs = soundElements<SpendReconciliation>(s["establishedBy"]);
    if (proofs.length === 0) return "unusable";
    if (!proofs.every((p) => p.logReadComplete === true && p.budgetId === s["forBudgetId"])) return "unusable";
    return "usable";
  }

  if (s["basis"] === "approximate") {
    if (!isAmount(s["estimatedAmount"])) return "unusable";
    if (!isFiniteNumber(s["sampledAt"])) return "unusable";
    if (!isBound(s["couldUnderstateBy"]) || !isBound(s["couldOverstateBy"])) return "unusable";
    // The two prose fields are REQUIRED, and an empty string is not a reason.
    // A producer that will not say why its figure is approximate has not
    // thought about whether it is.
    if (typeof s["approximateBecause"] !== "string" || s["approximateBecause"].length === 0) return "unusable";
    if (typeof s["wouldBeReconciledBy"] !== "string" || s["wouldBeReconciledBy"].length === 0) return "unusable";
    // Both bounds unstated: legal, honest, and it can decide NOTHING.
    if (s["couldUnderstateBy"] === null && s["couldOverstateBy"] === null) return "unbounded";
    return "usable";
  }

  return "unusable";
}

/**
 * What a spend figure supports about a limit. THREE-VALUED ON PURPOSE.
 *
 * A boolean here would force "I cannot tell" to be reported as one of "over" or
 * "under", and both are lies with money attached — the second in the direction
 * that lets spend continue past a cap, the first in the direction that stops a
 * company's agents on an estimator's noise.
 */
export type LimitComparison =
  /** The limit is reached or exceeded, and the figure ESTABLISHES it even at its most favourable reading. */
  | "provably_at_or_over"
  /** There is headroom, and the figure ESTABLISHES it even at its least favourable reading. */
  | "provably_under"
  /**
   * The figure straddles the limit given its own error bounds, states no
   * bounds, is for a different budget, or is not usable at all. NOT "under" —
   * UNDECIDED. This is the answer an approximate $99 against a $100 limit
   * deserves, and it is the whole reason this function exists instead of a
   * `>=`.
   */
  | "not_decidable";

/**
 * THE comparison rule, in one place, for every surface that makes one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FUNCTION EXISTS INSTEAD OF `>=`
 * ---------------------------------------------------------------------------
 *
 * It is not a convenience. It is the ONLY way to compare a spend to a limit,
 * because neither {@link ReconciledSpend} nor {@link ApproximateSpend} has a
 * field a caller could put on the left of a `>=` without first narrowing —
 * `spend.amount` does not compile, on purpose. Having narrowed to
 * `ApproximateSpend`, a caller who writes `estimatedAmount >= limitAmount` has
 * had to type the word `estimated`, and this doc is one hover away.
 *
 * THE ASYMMETRY IS DELIBERATE, and it is the safety argument:
 *
 *   OVER   requires `estimatedAmount - couldOverstateBy >= limitAmount`. Even
 *          if the estimate is as high as it could be wrong, the spend still
 *          clears the limit. A HARDER test than the naive comparison.
 *   UNDER  requires `estimatedAmount + couldUnderstateBy < limitAmount`. Even
 *          if the estimate is as low as it could be wrong, there is still
 *          headroom. ALSO harder than the naive comparison.
 *
 * Both directions are tightened, and neither rounds toward the other. The
 * middle — where the estimate plus or minus its own error crosses the limit —
 * is `not_decidable`, and what a caller does with that is a POLICY question
 * ({@link BudgetUnavailablePolicy}) rather than an arithmetic one.
 *
 * FAILS TO `not_decidable` ON ANYTHING IT CANNOT DO ARITHMETIC WITH, including
 * a figure for a different budget: comparing this month's spend to last
 * month's cap is not a weaker answer, it is a different question.
 *
 * @param spend - the figure. Anything at all; `not_decidable` is a valid answer.
 * @param limit - the ceiling to compare against.
 * @returns one of the three bands. NEVER throws.
 */
export function compareSpendToLimit(spend: SpendFigure, limit: BudgetLimit): LimitComparison {
  if (!isRecordLike(limit)) return "not_decidable";
  const limitAmount = (limit as unknown as Record<string, unknown>)["limitAmount"];
  const budgetId = (limit as unknown as Record<string, unknown>)["budgetId"];
  if (!isAmount(limitAmount) || typeof budgetId !== "string") return "not_decidable";

  const usability = spendUsability(spend);
  if (usability !== "usable") return "not_decidable";
  // A figure for a different budget answers a different question. Checked after
  // usability so a malformed figure is not reported as a mismatch.
  if (spend.forBudgetId !== budgetId) return "not_decidable";

  if (spend.basis === "reconciled") {
    return spend.reconciledAmount >= limitAmount ? "provably_at_or_over" : "provably_under";
  }

  // Approximate. Each direction needs its OWN bound stated; a figure bounded in
  // one direction only can decide in that direction only.
  if (spend.couldOverstateBy !== null && spend.estimatedAmount - spend.couldOverstateBy >= limitAmount) {
    return "provably_at_or_over";
  }
  if (spend.couldUnderstateBy !== null && spend.estimatedAmount + spend.couldUnderstateBy < limitAmount) {
    return "provably_under";
  }
  return "not_decidable";
}

/**
 * THE SENTENCE A HUMAN READS FOR A SPEND FIGURE, COMPOSED RATHER THAN
 * TRANSMITTED.
 *
 * This function exists because it is the only way to make the EXACTNESS of a
 * figure a property of the type rather than of whoever wrote the renderer.
 * Every other barrier here stops a CONSUMER treating an estimate as exact by
 * forgetting to check `basis`. A free-text field on the figure would let the
 * PRODUCER do it — "$99.00 spent of $100.00" is a compiling, contract-valid
 * string, and during a budget review that sentence is what somebody acts on.
 *
 * THE APPROXIMATE BRANCH NEVER STATES A BARE FIGURE. It names the estimate as
 * an estimate, states the bounds (including "unbounded" when they are `null`),
 * and says what the comparison does and does not establish.
 *
 * @param spend - the figure to render.
 * @param limit - the ceiling it is about.
 * @returns a past-tense statement for a reconciled figure; an explicitly
 *   hedged one, naming its bounds, for an approximate figure. The two are never
 *   phrased alike.
 */
export function spendStatement(spend: SpendFigure, limit: BudgetLimit): string {
  const unit = limit?.meter === "cost_minor_units" ? `${limit?.currency ?? "?"} minor units` : String(limit?.meter);
  const comparison = compareSpendToLimit(spend, limit);
  if (spendUsability(spend) === "unusable") {
    return `This spend figure is not usable, so nothing can be concluded about the ${limit?.limitAmount} ${unit} limit.`;
  }
  if (spend.basis === "reconciled") {
    return (
      `${spend.reconciledAmount} of ${limit.limitAmount} ${unit}, SUMMED FROM THE EVENT LOG through ` +
      `${new Date(spend.reconciledThrough).toISOString()} (${comparison.replace(/_/g, " ")}). Spend recorded after ` +
      `that moment is not in this figure.`
    );
  }
  const under = spend.couldUnderstateBy === null ? "an UNBOUNDED amount" : `${spend.couldUnderstateBy}`;
  const over = spend.couldOverstateBy === null ? "an UNBOUNDED amount" : `${spend.couldOverstateBy}`;
  return (
    `APPROXIMATELY ${spend.estimatedAmount} of ${limit.limitAmount} ${unit} — this is an ESTIMATE, not a ` +
    `measurement, and it may understate the truth by ${under} or overstate it by ${over}. ` +
    `${spend.approximateBecause} Against this limit it establishes: ${comparison.replace(/_/g, " ")}. ` +
    `For an exact figure: ${spend.wouldBeReconciledBy}`
  );
}

// ---------------------------------------------------------------------------
// BREAKER STATE — tripped, armed, and NOT ESTABLISHED, as three types
// ---------------------------------------------------------------------------

/** How a breaker came to be tripped. A fact about the trip, never about the agent. */
export type BreakerTripCause =
  /** The meter reached the limit and the backend tripped it. */
  | "limit_reached"
  /** An operator tripped it by hand (privileged, audited server-side per CLAUDE.md Event Log Rule 6). */
  | "manual_trip";

/**
 * THE BREAKER IS TRIPPED. A fact about the BREAKER, established by the server.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT CLAIM
 * ---------------------------------------------------------------------------
 *
 * IT CLAIMS: at `trippedAt`, this budget's limit was reached (or an operator
 * tripped it), on the evidence in `determinedFrom`.
 *
 * IT DOES NOT CLAIM that any agent stopped, that any spend was prevented, or
 * that the limit was in any sense enforced. Those are facts about processes
 * this system does not control. See this file's invariant 1.
 *
 * Never assignable to or from {@link BreakerArmed} or
 * {@link BreakerStateUndetermined}: distinct `state` literal, and NO FIELD IN
 * COMMON with either. `state.budgetId` does not compile on any of the three —
 * they are `trippedBudgetId`, `armedBudgetId` and `undeterminedBudgetId` — so
 * a renderer cannot print one under another's heading by forgetting to narrow.
 */
export interface BreakerTripped {
  /** Discriminant. The structural barriers are `trippedBudgetId`, `trippedAt` and `determinedFrom`. */
  state: "tripped";
  /** DELIBERATELY NOT NAMED `budgetId` — see this interface's header. */
  trippedBudgetId: string;
  /** The limit this breaker is on. Carried so the claim is auditable from the snapshot alone. */
  trippedLimit: BudgetLimit;
  trippedAt: number;
  trippedBy: BreakerTripCause;
  /**
   * REQUIRED: the fact, in the past tense, ABOUT THE BREAKER. "Reconciled spend
   * of 10,400 minor units reached the 10,000 limit for agent_7 on 2026-07-24."
   *
   * NEVER "agent_7 was stopped". See {@link FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS}
   * and this file's invariant 1.
   */
  trippedBecause: string;
  /**
   * THE EVIDENCE. NON-EMPTY BY TYPE: a trip with nothing behind it does not
   * compile. Every figure must compare `provably_at_or_over` against
   * `trippedLimit` for a `limit_reached` trip — audited by
   * {@link snapshotClaimContradictions}, because a JSON body is not typechecked.
   */
  determinedFrom: [SpendFigure, ...SpendFigure[]];
}

/**
 * THE BREAKER IS ARMED — there is headroom, and it was ESTABLISHED.
 *
 * NOT "we did not find a problem". `establishedUnderBy` must contain at least
 * one figure that compares `provably_under` against `armedLimit`, which an
 * approximate figure straddling the limit CANNOT do (see invariant 3). An
 * approximate $99 against a $100 cap does not arm a breaker; it leaves the
 * state undetermined, and the policy decides.
 *
 * Never assignable to or from the other two states.
 */
export interface BreakerArmed {
  /** Discriminant. The structural barriers are `armedBudgetId` and `establishedUnderBy`. */
  state: "armed";
  /** DELIBERATELY NOT NAMED `budgetId` — see {@link BreakerTripped}. */
  armedBudgetId: string;
  armedLimit: BudgetLimit;
  /**
   * THE EVIDENCE FOR HEADROOM. NON-EMPTY BY TYPE.
   *
   * NOTE WHAT IS ABSENT: there is no `headroomRemaining` number. A reconciled
   * figure would make it exact and an approximate one would make it a bound,
   * and a single `number` field would let a bound be summed, averaged and
   * displayed as a total — the `null`-versus-`0` defect in numeric form, which
   * `causality.ts` met as `hopsToOrigin` versus `hopsBeforeLoss`. A consumer
   * that wants a margin narrows a figure and does the arithmetic in the open.
   */
  establishedUnderBy: [SpendFigure, ...SpendFigure[]];
  /** When headroom was established, epoch ms. */
  establishedAt: number;
}

/** Why a breaker's state could not be established. Facts about the EVALUATION, never about the agent. */
export type BreakerUndeterminedKind =
  /** The spend figure available straddles the limit given its own error bounds. THE ADR-002 CASE. */
  | "spend_not_decidable"
  /** No spend figure was available at all for this budget. */
  | "spend_unavailable"
  /** The evaluation ran out of budget/rows before reaching this breaker. */
  | "evaluation_truncated"
  /** The budget row was read but is malformed — a limit this contract cannot interpret. */
  | "budget_unreadable";

/**
 * THE BREAKER'S STATE COULD NOT BE ESTABLISHED.
 *
 * The third band, for the same reason `divergence.ts`, `fleet_health.ts` and
 * `causality.ts` each have one — and here it is the MOST COMMON band in
 * production, because ADR-002's counters are approximate and an approximate
 * figure near a limit decides nothing.
 *
 * IT IS NOT `armed`. That conflation is the entire failure mode this feature
 * exists to prevent: "we could not tell" rendered as "there is headroom" is a
 * breaker that silently stops breaking, and it does so precisely when spend is
 * closest to the cap, because that is when an estimate straddles it.
 *
 * Never assignable to or from the other two states.
 */
export interface BreakerStateUndetermined {
  /** Discriminant. The structural barriers are `undeterminedBudgetId`, `undeterminedBecause` and `wouldBeDeterminedBy`. */
  state: "undetermined";
  /** DELIBERATELY NOT NAMED `budgetId` — see {@link BreakerTripped}. */
  undeterminedBudgetId: string;
  undeterminedLimit: BudgetLimit;
  kind: BreakerUndeterminedKind;
  /**
   * REQUIRED: what specifically could not be decided. "Spend is estimated at
   * 9,900 minor units against a 10,000 limit, from a sampled counter with no
   * stated error bound."
   */
  undeterminedBecause: string;
  /**
   * REQUIRED: what would decide it, as an action — "reconcile spend for this
   * period from the event log", or "raise the limit above the estimator's
   * error band".
   *
   * The difference between a product that says "I cannot tell" and one that
   * says "I cannot tell YET, and here is what to do". A state that reads as a
   * shrug is one people learn to configure around.
   */
  wouldBeDeterminedBy: string;
}

/**
 * One breaker's state.
 *
 * A single-slot union of three FIELD-DISJOINT types, safe for the reason
 * `ChainTerminus` is: it types one slot rather than a list, and it is useless
 * unnarrowed — there is no `budgetId`, no `limit` and no message common to the
 * three, so every access forces a `state` check.
 */
export type BreakerState = BreakerTripped | BreakerArmed | BreakerStateUndetermined;

// ---------------------------------------------------------------------------
// THE SNAPSHOT — the cheap ask
// ---------------------------------------------------------------------------

/**
 * What the server actually evaluated.
 *
 * Same posture as `CausalScan` and `FleetHealthScan`: the server STATES its
 * incompleteness in a field rather than refusing, and the GATE decides that an
 * incomplete evaluation is not an all-clear.
 */
export interface BreakerScan {
  /** Echoed. A server that evaluated a different subject answered a different question. */
  subject: BudgetSubject;
  /**
   * How many enabled budgets govern this subject.
   *
   * ZERO IS A LEGITIMATE, COMPLETE ANSWER and it means "no budget governs
   * this" — which is NOT "there is headroom". `fleet_health.ts` had to learn
   * this as "no data is not good news"; here it is the difference between an
   * unbudgeted agent and a budgeted one with room, and a budget deleted by
   * mistake looks exactly like the first. {@link decideBudget} gives it its own
   * decision band for that reason.
   */
  budgetsInScope: number;
  /** How many were actually evaluated. Less than `budgetsInScope` means the answer is partial. */
  budgetsEvaluated: number;
  /** True when the evaluation stopped on a server ceiling: every count above is a floor. */
  evaluationTruncated: boolean;
}

/**
 * EVERY BREAKER GOVERNING A SUBJECT, EVALUATED ONCE, WITH A STATED SHELF LIFE.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE CHEAP ASK, AND THE CHEAPNESS IS THE FEATURE
 * ---------------------------------------------------------------------------
 *
 * An agent may want to consult the breaker before EVERY model call. A breaker
 * nobody can afford to consult is not enforcement — it is a check that gets
 * commented out the first time somebody profiles the loop.
 *
 * So the wire shape is designed for one round trip per shelf life, not one per
 * question:
 *
 *   1. ONE CALL COVERS EVERY BUDGET IN SCOPE. `states` is the whole governing
 *      set, so an agent under an org cap, a project cap and a per-run cap asks
 *      once, not three times.
 *   2. THE SERVER STATES HOW LONG ITS ANSWER IS GOOD FOR (`freshUntil`). This
 *      is the server's judgement, not the client's guess, because only the
 *      server knows the spend rate and the distance to the cap. A breaker one
 *      cent from its limit can be given a one-second shelf life; a breaker at
 *      2% of its cap can be given a minute.
 *   3. THE ANSWER RIDES BACK ON A PATH THE AGENT ALREADY PAYS FOR. A snapshot
 *      returned alongside an ingest response refreshes the guard for free —
 *      see `packages/sdk/src/budget-guard.ts` (`absorbSnapshot`). An agent that
 *      records events is an agent whose breaker state is already current.
 *   4. THE CHECK ITSELF IS SYNCHRONOUS AND DOES NO I/O. `BudgetGuard.check()`
 *      reads the held snapshot. That is what makes a per-model-call check
 *      affordable at all.
 *
 * `freshUntil` IS CAPPED CLIENT-SIDE regardless of what the server says — see
 * {@link MAX_BREAKER_ANSWER_FRESHNESS_MS}. A shelf life is a server judgement;
 * an UNBOUNDED shelf life is a bypass, and a compromised or buggy deployment
 * must not be able to hand out an answer good for a year.
 *
 * DERIVED, NEVER SOURCE OF TRUTH (CLAUDE.md Event Log Rule 2): a snapshot is
 * computed at query time from budgets and spend. Recompute it; do not store it
 * back.
 */
export interface BreakerSnapshot {
  /** Server clock when the breakers were evaluated, epoch ms. */
  evaluatedAt: number;
  /**
   * SERVER-STATED SHELF LIFE, epoch ms, ON THE SERVER'S OWN CLOCK.
   *
   * ---------------------------------------------------------------------------
   * READ AS A DURATION, NOT AS AN INSTANT — AND THAT IS THE WHOLE FIX
   * ---------------------------------------------------------------------------
   *
   * Both this field and `evaluatedAt` come from the SAME clock, so the interval
   * between them (`freshUntil - evaluatedAt`) is SKEW-INVARIANT: it means what
   * the server meant no matter how wrong that clock is. Either endpoint taken
   * on its own is not, and comparing one of them to a CLIENT clock is the
   * defect this pair of fields has now produced twice, in both directions:
   *
   *   ANCHORED THE CEILING ON `evaluatedAt`  a server an hour AHEAD bought an
   *                                          hour of extra permission — the cap
   *                                          defeated by the value it capped.
   *   TOOK `freshUntil` AS A FLOOR           a server an hour BEHIND emitted a
   *                                          `freshUntil` already in the
   *                                          client's past, so EVERY answer was
   *                                          born stale and every decision a
   *                                          decline, fleet-wide, with no
   *                                          budget anywhere near a cap.
   *
   * The first repair closed the money direction and left the halt-a-business
   * direction open, which for this feature is the more expensive of the two.
   * Fixing one direction of a two-sided defect is the shape of that repair, and
   * it came from treating a server instant as if it were comparable to a client
   * one AT ALL.
   *
   * So {@link decideBudget} reads only the DURATION from this field and anchors
   * both ends of the window on `receivedAt`, a moment the client observed on its
   * own clock. The server contributes a judgement about how long its answer
   * stays good — which only it can make, because only it knows the spend rate
   * and the distance to the cap — and contributes NO absolute instant to any
   * comparison. A wrong server clock then has no effect in either direction.
   *
   * Must be strictly after `evaluatedAt`: a non-positive DURATION is malformed
   * (nothing can be good for zero time), and that is a different statement from
   * an instant that happens to sit in the client's past, which is ordinary skew
   * and is now tolerated correctly.
   */
  freshUntil: number;
  /**
   * SERVER-STATED SHELF LIFE AS A DURATION, in ms. THE AUTHORITATIVE FORM —
   * prefer this over {@link BreakerSnapshot.freshUntil} wherever both exist.
   *
   * ---------------------------------------------------------------------------
   * WHY A DURATION IS NOT MERELY A TIDIER SPELLING OF AN INSTANT
   * ---------------------------------------------------------------------------
   *
   * A server building a snapshot stamps `freshUntil = itsNow + ceiling`. By the
   * time the body reaches the client, the network and any queueing have already
   * elapsed, so a client anchoring on the absolute instant holds the answer for
   * `ceiling - transit`. THE MARGIN THE CADENCE MULTIPLE EXISTS TO GUARANTEE IS
   * SPENT ON TRANSIT, silently, and the amount spent is exactly the quantity
   * nobody is measuring.
   *
   * Per client that deduction is in the safe direction — they refresh sooner
   * than needed. THE HARM IS AT FLEET SCALE, and it is the kind that only shows
   * up in production: transit is longest precisely when the deployment is
   * slowest, so every client's hold shortens AT THE SAME MOMENT, and they all
   * come back to refresh together. A synchronised refresh storm, arriving
   * through the very field meant to prevent one, at the moment the server can
   * least absorb it.
   *
   * A duration has no such coupling: it means the same thing whenever it
   * arrives, and it is SKEW-INVARIANT as well, which is what closes the
   * separate two-sided clock defect described on {@link BreakerSnapshot.freshUntil}.
   * One field, two defects.
   *
   * OPTIONAL, FOR BACKWARD COMPATIBILITY ONLY. A deployment predating this
   * field is read through the derived fallback in {@link statedShelfLifeMs},
   * which recovers the same duration from `freshUntil - evaluatedAt` — sound,
   * because both endpoints come from one clock. New deployments should send it
   * explicitly rather than leave the client inferring intent from two
   * timestamps.
   *
   * STILL CLAMPED CLIENT-SIDE. An unbounded duration is a bypass exactly as an
   * unbounded instant was; this changes what the ceiling is anchored to, not
   * whether there is one.
   */
  shelfLifeMs?: number;
  /** Every governing breaker's state. Bounded by {@link MAX_BREAKER_STATES}. */
  states: BreakerState[];
  /** REQUIRED. What the evaluation covered — see {@link BreakerScan}. */
  scan: BreakerScan;
}

/**
 * THE SHELF LIFE A SNAPSHOT STATES, AS A DURATION — the one reader, so the
 * decision rule and the guard's refresh scheduler cannot end up on different
 * clocks.
 *
 * PREFERS THE EXPLICIT {@link BreakerSnapshot.shelfLifeMs} and falls back to
 * `freshUntil - evaluatedAt`. The fallback is sound because both of those come
 * from the server's own clock, so their difference survives that clock being
 * wrong — but it is an INFERENCE about what the server meant, and the explicit
 * field is a statement of it. Where a deployment sends both, the statement
 * wins.
 *
 * @param snapshot - anything at all.
 * @returns a positive duration in ms, or `null` when the snapshot states none
 *   usable. `null`, not `0`: "this answer is good for no time at all" and "this
 *   snapshot does not say how long it is good for" are different, and only the
 *   second is a malformity.
 */
export function statedShelfLifeMs(snapshot: BreakerSnapshot): number | null {
  if (!isRecordLike(snapshot)) return null;
  const explicit = (snapshot as unknown as Record<string, unknown>)["shelfLifeMs"];
  if (explicit !== undefined) {
    return isAmount(explicit) && explicit > 0 ? explicit : null;
  }
  const { evaluatedAt, freshUntil } = snapshot;
  if (!isFiniteNumber(evaluatedAt) || !isFiniteNumber(freshUntil)) return null;
  const derived = freshUntil - evaluatedAt;
  return derived > 0 ? derived : null;
}

/** Bound on a snapshot's state listing. A subject governed by more budgets than this is a misconfiguration. */
export const MAX_BREAKER_STATES = 50;

/**
 * HOW OFTEN THE BACKEND RE-EVALUATES BREAKERS. The sweep cron's period.
 *
 * DECLARED HERE, IN CONTRACTS, BECAUSE TWO SIDES DEPEND ON IT AND NEITHER MAY
 * GUESS. The backend schedules its sweep from this; the client derives its
 * honouring ceiling from it (see {@link MAX_BREAKER_ANSWER_FRESHNESS_MS}). A
 * deployment that changes its cadence changes this constant, and both sides
 * move together — which is the whole reason it is a shared value rather than a
 * number written down twice.
 */
export const BREAKER_EVALUATION_CADENCE_MS = 60_000;

/**
 * How many evaluation cadences an answer may be honoured for.
 *
 * TWO, AND THE NUMBER IS AN ARGUMENT RATHER THAN A PREFERENCE: one cadence
 * guarantees a gap, because an answer expires at exactly the moment the next
 * one is being computed and any cron lateness at all becomes a spurious
 * withhold — a sawtooth of declines produced by ordinary operational jitter,
 * in the halt-a-business direction. Two absorbs a missed tick and no more.
 */
export const BREAKER_FRESHNESS_CADENCE_MULTIPLE = 2;

/**
 * THE LONGEST A CLIENT MAY HONOUR ANY SNAPSHOT, whatever `freshUntil` says.
 *
 * ---------------------------------------------------------------------------
 * DERIVED FROM THE CADENCE, NOT CHOSEN BESIDE IT
 * ---------------------------------------------------------------------------
 *
 * This was a hand-picked 60,000 sitting next to a backend constant that
 * independently picked 120,000 for the same relationship in the other
 * direction. THE CEILING WAS HALF THE FLOOR, and with a 60-second sweep that
 * meant an answer expired exactly as its replacement was being computed: every
 * late cron tick produced a fleet-wide decline. Two hand-maintained constants
 * that must agree is the shape that has produced defects in nine layers of this
 * repo, and the repair is the one this codebase keeps arriving at — DERIVE ONE
 * FROM THE OTHER so a change to either cannot silently reintroduce the sawtooth.
 *
 * THE SECURITY PURPOSE IS UNCHANGED AND IS NOT WEAKENED BY DERIVING IT: this
 * ceiling is what bounds how long a compromised, wedged or buggy deployment can
 * keep granting permission by handing out an enormous `freshUntil`. A multiple
 * of the cadence is still a hard bound; it is simply a bound that cannot be in
 * the impossible relationship to the refresh rate.
 *
 * {@link breakerCadenceInvariant} states the relationship as a runtime check,
 * so the two constants crossing is a test failure rather than a production
 * sawtooth.
 */
export const MAX_BREAKER_ANSWER_FRESHNESS_MS =
  BREAKER_EVALUATION_CADENCE_MS * BREAKER_FRESHNESS_CADENCE_MULTIPLE;

/**
 * Does the DEPLOYMENT's actual sweep schedule match the cadence this contract
 * derives its honouring ceiling from?
 *
 * ---------------------------------------------------------------------------
 * IT TAKES A PARAMETER, AND THE PARAMETER IS THE ENTIRE POINT
 * ---------------------------------------------------------------------------
 *
 * The first version of this function took no argument and checked
 * `MAX_BREAKER_ANSWER_FRESHNESS_MS` against `BREAKER_EVALUATION_CADENCE_MS`.
 * Since the first is DERIVED from the second, the cadence cancels: both
 * conditions reduce to statements about {@link BREAKER_FRESHNESS_CADENCE_MULTIPLE},
 * a literal three lines above. IT COULD NOT FAIL FOR ITS OWN STATED REASON —
 * a green check that reported on nothing, which is worse than no check, because
 * it occupies the place where a real one would go.
 *
 * That is the same lesson as the phantom type parameter in `causality.ts`: a
 * barrier that exists and can never be reached is the weak form, and it reads
 * as coverage. Deriving the constant WAS the right repair for the original
 * drift — it removed the ability of the two numbers to disagree — and the
 * consequence is precisely that the invariant over them became vacuous. The
 * check has to move to a pair that CAN still diverge.
 *
 * THAT PAIR IS THIS CONSTANT AND THE CRON'S OWN SCHEDULE. `convex/` registers a
 * sweep with a literal interval; nothing links it to this file. If someone
 * changes the cron to every five minutes and leaves this at 60,000, the ceiling
 * is derived from a cadence the deployment no longer has, and answers expire
 * four minutes before their replacements are computed — the sawtooth again,
 * arriving by a route the derivation does not cover.
 *
 * The observed cadence is a PARAMETER rather than an import because contracts
 * has zero runtime dependencies and must not reach into `convex/` (CLAUDE.md,
 * System Boundaries). The caller — a test reading the interval off the shipped
 * `crons` export, or the backend at startup — supplies what the deployment
 * actually does, and this function judges it. A caller that passes
 * `BREAKER_EVALUATION_CADENCE_MS` back in has written the vacuous check again,
 * so do not.
 *
 * @param observedCadenceMs - the sweep interval the DEPLOYMENT actually
 *   registers, read from the schedule rather than from this module.
 * @returns `null` when the relationship holds, or a sentence naming what broke.
 */
export function breakerCadenceInvariant(observedCadenceMs: number): string | null {
  if (!isFiniteNumber(observedCadenceMs) || observedCadenceMs <= 0) {
    return (
      `the observed sweep cadence is not a positive number (${JSON.stringify(observedCadenceMs)}), so the ` +
      `deployment's refresh rate could not be checked against the ceiling derived from ` +
      `BREAKER_EVALUATION_CADENCE_MS`
    );
  }
  if (observedCadenceMs !== BREAKER_EVALUATION_CADENCE_MS) {
    return (
      `the deployment sweeps every ${observedCadenceMs}ms but BREAKER_EVALUATION_CADENCE_MS declares ` +
      `${BREAKER_EVALUATION_CADENCE_MS}ms, and the client honouring ceiling ` +
      `(${MAX_BREAKER_ANSWER_FRESHNESS_MS}ms) is derived from the declared value. Change both together, or ` +
      `answers expire on a schedule the deployment does not keep`
    );
  }
  if (MAX_BREAKER_ANSWER_FRESHNESS_MS <= observedCadenceMs) {
    return (
      `the honouring ceiling (${MAX_BREAKER_ANSWER_FRESHNESS_MS}ms) does not exceed the observed sweep cadence ` +
      `(${observedCadenceMs}ms), which guarantees a gap between every answer expiring and its replacement being ` +
      `computed — a fleet-wide sawtooth of declines produced by ordinary cron jitter`
    );
  }
  if (MAX_BREAKER_ANSWER_FRESHNESS_MS > observedCadenceMs * 5) {
    return (
      `the honouring ceiling (${MAX_BREAKER_ANSWER_FRESHNESS_MS}ms) is more than five sweep cadences, which is ` +
      `long enough for a wedged deployment to keep granting permission well past the point anyone would notice`
    );
  }
  return null;
}

/**
 * The longest a caller may configure {@link BudgetUnavailablePolicy}'s grace
 * window. Beyond this, "we are inside a brief outage" stops being true and the
 * caller is simply failing open on a timer.
 */
export const MAX_BREAKER_GRACE_MS = 300_000;

/**
 * Is this snapshot an answer at all — did the server evaluate every breaker it
 * said governs the subject?
 *
 * THE POSITIVE CLAUSE IS `budgetsEvaluated === budgetsInScope`, and note what
 * it deliberately is NOT: `budgetsEvaluated > 0`. Zero budgets in scope is a
 * legitimate, complete answer meaning "no budget governs this subject", and
 * requiring a positive count would report an unbudgeted agent as an
 * unevaluated one forever.
 *
 * The danger that clause would otherwise guard — an empty snapshot reading as
 * an all-clear — is handled where it belongs instead: {@link decideBudget}
 * gives "no budget governs this" ITS OWN DECISION BAND
 * ({@link AllowedNoBudgetGoverns}), so it can never be counted as headroom on
 * any dashboard. That is the `fleet_health.ts` "no data is not good news"
 * lesson placed at the layer that can act on it.
 *
 * @param snapshot - anything; `false` is a valid answer for a malformed body.
 * @returns true only when the evaluation is complete and internally consistent.
 */
export function isBreakerSnapshotComplete(snapshot: BreakerSnapshot): boolean {
  const scan = snapshot?.scan;
  if (!isRecordLike(scan)) return false;
  const s = scan as unknown as Record<string, unknown>;
  return (
    isAmount(s["budgetsInScope"]) &&
    isAmount(s["budgetsEvaluated"]) &&
    s["budgetsEvaluated"] === s["budgetsInScope"] &&
    s["evaluationTruncated"] === false &&
    // INDEXED, NOT SOUND. A malformed state is not an absent one; it is the
    // strongest ground there is for refusing to call this a complete answer.
    indexedElements<BreakerState>(snapshot?.states).every((state) => state !== null) &&
    soundElements<BreakerState>(snapshot?.states).length === s["budgetsEvaluated"] &&
    // ONE definition of "trustworthy", shared with the SDK gate and with
    // `decideBudget`. Three copies is how three layers come to disagree about
    // what is safe to enforce on.
    breakerSnapshotRefusals(snapshot).length === 0
  );
}

// ---------------------------------------------------------------------------
// THE DECISION — six bands, and three different ways of saying "proceed"
// ---------------------------------------------------------------------------

/**
 * WHAT TO DO WHEN THE BREAKER CANNOT BE CONSULTED.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED, EXPLICIT, AND NOT A DEFAULT IN A CATCH BLOCK
 * ---------------------------------------------------------------------------
 *
 * A breaker that fails OPEN on an unreachable server is not a breaker: anyone
 * who wants to bypass it causes a network error, and "the check errored" is the
 * easiest condition in computing to arrange. A breaker that fails CLOSED halts
 * honest work during an outage of OURS, which is a bill we send to a customer
 * for our own downtime.
 *
 * Both costs are real and they fall on different people, so this library does
 * not choose. It makes the choice a REQUIRED constructor argument with no
 * default, so that a codebase's posture is greppable rather than emergent —
 * and it puts a prose `acceptedRisk` on the two arms that weaken the breaker.
 * You may fail open; you may not do it by accident, and you may not do it
 * without a sentence somebody can find later.
 *
 * `grace` IS THE ONE TO REACH FOR FIRST, and it is not a compromise between
 * the other two: it honours a POSITIVE ANSWER WE ACTUALLY RECEIVED for a
 * bounded window past its stated expiry. It never invents a yes. A subject
 * whose last answer was `tripped`, or who never got an answer at all, gets
 * nothing from it.
 */
export type BudgetUnavailablePolicy =
  /**
   * FAIL CLOSED. No usable answer means decline. The default posture for
   * anything where the spend is worse than the delay.
   */
  | { onUnavailable: "deny" }
  /**
   * FAIL CLOSED, WITH A BOUNDED GRACE ON A YES WE ALREADY HAD. Honours the last
   * `armed` snapshot for `graceMs` past its `freshUntil`, then declines.
   */
  | {
      onUnavailable: "grace";
      /** Milliseconds past `freshUntil`. Bounded by {@link MAX_BREAKER_GRACE_MS}. */
      graceMs: number;
      /** REQUIRED: what you are accepting, in prose. "Up to 60s of spend past the cap during an AFR outage." */
      acceptedRisk: string;
    }
  /**
   * FAIL OPEN. No answer means proceed. The decision is still RECORDED as
   * {@link AllowedWithoutAnswer} — a distinct band that can never be counted as
   * headroom.
   */
  | {
      onUnavailable: "allow";
      /** REQUIRED: what you are accepting, in prose. "Unbounded spend while AFR is unreachable." */
      acceptedRisk: string;
    };

/**
 * WE ASKED, AND WE WERE TOLD THERE IS HEADROOM.
 *
 * The only band that means the breaker actually did its job. Never assignable
 * to or from the other two allow bands: no shared field.
 */
export interface AllowedByArmedBreaker {
  decision: "allowed_breaker_armed";
  /** Every breaker consulted, by budget id. NON-EMPTY: this band requires at least one armed breaker. */
  armedBudgetIds: [string, ...string[]];
  /** When the server evaluated them, epoch ms. */
  answerEvaluatedAt: number;
  /** How long the answer is good for, epoch ms — already capped by {@link MAX_BREAKER_ANSWER_FRESHNESS_MS}. */
  answerFreshUntil: number;
}

/**
 * NO BUDGET GOVERNS THIS SUBJECT.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN BAND AND NOT AN ARMED BREAKER WITH AN EMPTY LIST
 * ---------------------------------------------------------------------------
 *
 * "No budget applies" and "the budget was checked and there is room" are
 * different facts with different remedies, and the first is what a DELETED,
 * DISABLED OR MIS-SCOPED budget looks like. Folded into
 * {@link AllowedByArmedBreaker}, an org that lost its budgets in a bad
 * migration would show a clean, growing "allowed by armed breaker" count while
 * having no cost control whatsoever.
 *
 * `budgetsInScope` IS THE LITERAL TYPE `0`, not `number`, so this band cannot
 * be constructed for a subject that does have budgets — the same construction
 * as `OriginProof.inboundEdgesFound`.
 */
export interface AllowedNoBudgetGoverns {
  decision: "allowed_no_budget_governs";
  /** LITERAL `0`. A subject with budgets cannot be spelled here. */
  budgetsInScope: 0;
  /** Echoed, so a misconfiguration is greppable: which subject has no budget? */
  unbudgetedSubject: BudgetSubject;
  ungovernedAt: number;
}

/**
 * THE LAST YES EXPIRED, THE SERVER IS UNREACHABLE, AND WE ARE INSIDE THE
 * CONFIGURED GRACE.
 *
 * NOT the same as {@link AllowedByArmedBreaker}, and the fields make that
 * unmissable: this band has no `answerFreshUntil` to read, it has
 * `honouredAnswerExpiredAt` and `graceEndsAt`. A dashboard counting "allowed"
 * decisions sees these separately or not at all.
 *
 * It is still not fail-open: an answer we RECEIVED is being honoured slightly
 * past its stated shelf life. It cannot be reached without a prior `armed`
 * snapshot for the same subject.
 */
export interface AllowedWithinGrace {
  decision: "allowed_within_grace";
  /** When the honoured answer's `freshUntil` passed, epoch ms. */
  honouredAnswerExpiredAt: number;
  /** When the grace runs out and this becomes a decline, epoch ms. */
  graceEndsAt: number;
  /** REQUIRED: why the server could not be re-asked. */
  unreachableBecause: string;
  /** Echoed from the policy, so the sentence somebody wrote down travels with the decision. */
  graceAcceptedRisk: string;
}

/**
 * WE NEVER GOT AN ANSWER, AND THE POLICY SAYS PROCEED ANYWAY.
 *
 * ---------------------------------------------------------------------------
 * THE BAND THIS WHOLE CONTRACT EXISTS TO KEEP VISIBLE
 * ---------------------------------------------------------------------------
 *
 * "I could not ask" is being treated as "I was told yes", DELIBERATELY, by a
 * caller who wrote down why. That is a legitimate operational choice and it is
 * also the exact shape of a bypass, so it gets its own type, its own name, and
 * no field in common with the band that means we were actually told yes.
 *
 * An org whose allow decisions are entirely this band has no budget
 * enforcement at all. That fact must be readable from the decision itself,
 * without a flag anybody has to remember to check.
 */
export interface AllowedWithoutAnswer {
  decision: "allowed_without_answer";
  /** LITERAL `"allow"`. This band is unreachable under any other policy. */
  allowedByPolicy: "allow";
  /** REQUIRED: why there was no answer. */
  unansweredBecause: string;
  /** Echoed from the policy. The sentence somebody wrote down travels with every decision it licensed. */
  allowAcceptedRisk: string;
  unansweredAt: number;
}

/**
 * THE BREAKER IS TRIPPED, AND THE SDK DECLINED TO PROCEED.
 *
 * TWO FACTS, BOTH OURS, AND NEITHER OF THEM IS "THE AGENT STOPPED". The SDK
 * returned a decline; what the caller does next is the caller's. See this
 * file's invariant 1 and {@link decisionStatement}, which says so in the prose
 * a surface renders.
 */
export interface DeclinedBreakerTripped {
  decision: "declined_breaker_tripped";
  /** The breaker that tripped. */
  declinedForBudgetId: string;
  /** When it tripped, epoch ms — the server's fact, not ours. */
  breakerTrippedAt: number;
  /** REQUIRED: the breaker's own reason, carried through. */
  breakerTrippedBecause: string;
  declinedAt: number;
}

/**
 * THERE WAS NO USABLE ANSWER, AND THE POLICY SAYS DECLINE.
 *
 * The fail-closed outcome. Note it is NOT a claim that a breaker is tripped —
 * we do not know that, and saying so would be as dishonest in the other
 * direction. It is a claim about our own ignorance and about what we did with
 * it.
 */
export interface DeclinedNoAnswer {
  decision: "declined_no_answer";
  /** LITERAL `"deny"` or `"grace"`. Unreachable under `allow`. */
  declinedByPolicy: "deny" | "grace";
  /** REQUIRED: why there was no usable answer. */
  noAnswerBecause: string;
  /** REQUIRED: what would produce one, as an action. */
  wouldBeAnsweredBy: string;
  declinedAt: number;
}

/**
 * What the SDK decided, and on what basis.
 *
 * SIX BANDS, SHARING NO FIELD BUT THE DISCRIMINANT — not a run id, not a
 * timestamp name, not a message, and above all NOT an `allowed: boolean`. Every
 * access forces a narrow, and having narrowed, a consumer is holding a type
 * whose field names state which claim it is making.
 *
 * THREE OF THE SIX MEAN PROCEED and they are not interchangeable:
 * {@link AllowedByArmedBreaker} is enforcement working;
 * {@link AllowedNoBudgetGoverns} is enforcement absent;
 * {@link AllowedWithinGrace} is enforcement degraded;
 * {@link AllowedWithoutAnswer} is enforcement off. A single boolean would have
 * made all four the same number on the same graph.
 *
 * Use {@link mayProceed} for the boolean a control-flow site needs — it is a
 * TOTAL map over the discriminants, so a seventh band cannot ship without
 * somebody deciding, in one place, what it means.
 */
export type BudgetDecision =
  | AllowedByArmedBreaker
  | AllowedNoBudgetGoverns
  | AllowedWithinGrace
  | AllowedWithoutAnswer
  | DeclinedBreakerTripped
  | DeclinedNoAnswer;

/**
 * WHICH DECISIONS MEAN PROCEED, DECLARED ONCE.
 *
 * A table rather than a condition at each call site, for the same reason
 * `COMPLETE_TERMINI` is one in `causality.ts`: a classification chosen at a
 * call site is one somebody can get wrong again, and here getting it wrong
 * means either spending past a cap or halting a company's agents.
 *
 * TOTAL OVER THE UNION'S DISCRIMINANTS, so a seventh band is a compile error
 * here until it is classified. Defaulting to "proceed" by omission is exactly
 * how a new kind of not-having-asked would quietly start buying a green light.
 */
const PROCEED_DECISIONS: Record<BudgetDecision["decision"], boolean> = {
  allowed_breaker_armed: true,
  allowed_no_budget_governs: true,
  allowed_within_grace: true,
  allowed_without_answer: true,
  declined_breaker_tripped: false,
  declined_no_answer: false,
};

/**
 * The boolean a control-flow site needs.
 *
 * FAILS CLOSED ON AN UNRECOGNISED DISCRIMINANT: a decision speaking a
 * vocabulary this contract does not define is not one to guess at, and with
 * money the safe guess is "do not proceed".
 *
 * @param decision - the decision to read. Anything at all; `false` is a valid answer.
 * @returns whether the SDK is saying go ahead. NEVER throws.
 */
export function mayProceed(decision: BudgetDecision): boolean {
  const band = (decision as { decision?: unknown })?.decision;
  return typeof band === "string" && PROCEED_DECISIONS[band as BudgetDecision["decision"]] === true;
}

/**
 * Did the SDK decline?
 *
 * NOTE WHAT THIS FUNCTION IS NOT CALLED, AND WHAT DOES NOT EXIST BESIDE IT.
 * There is no `wasAgentStopped`, no `wasSpendPrevented`, no `wasEnforced` —
 * not because nobody wrote them, but because there is no honest implementation
 * of one. The SDK observes its own return value and nothing else. See this
 * file's invariant 1.
 *
 * @param decision - the decision to read.
 * @returns whether THE SDK declined to proceed. Says nothing about what the
 *   caller did next, because nothing here can know that.
 */
export function wasDeclinedBySdk(decision: BudgetDecision): boolean {
  return !mayProceed(decision);
}

/**
 * FIELD NAMES A BUDGET WIRE BODY MAY NEVER CARRY.
 *
 * Every one of these asserts something about a process this system does not
 * control: that an agent halted, that spend was prevented, that a limit was
 * enforced. The type system makes them unspellable in OUR code; a JSON body is
 * not typechecked by anyone, and a backend that adds `enforced: true` would
 * have its claim rendered by every surface that spreads a state object.
 *
 * The SDK gate refuses a body carrying any of these — the same treatment
 * `BANNED_SUSPICION_HEADLINES` gets in `reader.ts`, and for the same reason:
 * every other barrier stops a CONSUMER over-claiming by forgetting something,
 * and a transmitted field lets the PRODUCER do it in one keystroke.
 */
export const FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS: readonly string[] = [
  "enforced",
  "wasEnforced",
  "halted",
  "agentHalted",
  "stopped",
  "agentStopped",
  "blocked",
  "wasBlocked",
  "prevented",
  "spendPrevented",
  "killed",
  "terminated",
  "aborted",
  "execution_stopped",
];

/**
 * THE SENTENCE A HUMAN READS FOR A DECISION, COMPOSED RATHER THAN TRANSMITTED.
 *
 * The one place the claim boundary is stated in prose, so no surface can phrase
 * a decline as an outcome. Every decline branch names THE SDK as the subject
 * and then says, in the same sentence, what that does not establish — because
 * an operator reading "budget enforced" at 3am will not supply the caveat for
 * themselves, and a compliance reviewer reading it six months later certainly
 * will not.
 *
 * EXHAUSTIVE OVER THE UNION BY CONSTRUCTION: the final branch is reached
 * through a `never` check, so adding a seventh band without giving it a
 * sentence is a compile error here rather than an unlabelled decision on a
 * screen.
 *
 * @param decision - the decision to render.
 * @returns a statement about the breaker and about the SDK. Never a statement
 *   about the agent, in any branch.
 */
export function decisionStatement(decision: BudgetDecision): string {
  switch (decision.decision) {
    case "allowed_breaker_armed":
      return (
        `The SDK is not declining: ${decision.armedBudgetIds.length} breaker(s) were consulted and each has ` +
        `established headroom. This answer was evaluated at ` +
        `${new Date(decision.answerEvaluatedAt).toISOString()} and is good until ` +
        `${new Date(decision.answerFreshUntil).toISOString()}.`
      );
    case "allowed_no_budget_governs":
      return (
        `The SDK is not declining, but NO BUDGET GOVERNS THIS SUBJECT — there is nothing to have headroom in. ` +
        `This is what a deleted, disabled or mis-scoped budget also looks like; if you expected a cap here, the ` +
        `budget is not attached to ${JSON.stringify(decision.unbudgetedSubject)}.`
      );
    case "allowed_within_grace":
      return (
        `The SDK is not declining ON AN EXPIRED ANSWER. The last answer said there was headroom; it expired at ` +
        `${new Date(decision.honouredAnswerExpiredAt).toISOString()} and the server could not be re-asked ` +
        `(${decision.unreachableBecause}). The configured grace ends at ` +
        `${new Date(decision.graceEndsAt).toISOString()}, after which this becomes a decline. ` +
        `Accepted risk: ${decision.graceAcceptedRisk}`
      );
    case "allowed_without_answer":
      return (
        `THE BREAKER WAS NOT CONSULTED AND THE SDK IS NOT DECLINING. There was no answer ` +
        `(${decision.unansweredBecause}) and the configured policy is to proceed regardless. This decision was ` +
        `made WITHOUT any statement from the breaker — it is not evidence of headroom, and it must not be ` +
        `counted as one. Accepted risk: ${decision.allowAcceptedRisk}`
      );
    case "declined_breaker_tripped":
      return (
        `THE BREAKER FOR ${decision.declinedForBudgetId} IS TRIPPED (${decision.breakerTrippedBecause}), and THE ` +
        `SDK DECLINED TO PROCEED. Those are the two facts here. The SDK returns a decision; it does not stop a ` +
        `process, and nothing in this record establishes that the agent halted or that any spend was prevented.`
      );
    case "declined_no_answer":
      return (
        `THE SDK DECLINED TO PROCEED because the breaker could not be consulted (${decision.noAnswerBecause}), ` +
        `under the '${decision.declinedByPolicy}' policy. NOTE WHAT THIS IS NOT: it is not a statement that a ` +
        `breaker is tripped — we do not know that — and it is not a statement that the agent halted. To get a ` +
        `real answer: ${decision.wouldBeAnsweredBy}`
      );
    default: {
      // Exhaustiveness: a seventh band must be given a sentence here.
      const unreachable: never = decision;
      return String(unreachable);
    }
  }
}

// ---------------------------------------------------------------------------
// THE DECISION RULE — one implementation, for the SDK guard and the CLI gate
// ---------------------------------------------------------------------------

/** The inputs {@link decideBudget} needs. */
export interface BudgetDecisionInput {
  /**
   * The snapshot in hand, or `null` FOR NONE.
   *
   * `null` rather than a fabricated empty snapshot, and the difference is the
   * whole of invariant 2: an empty snapshot is a server saying "no budget
   * governs this", and a `null` is us saying "we never got an answer". A
   * caller that manufactures the former from the latter has forged a yes.
   */
  snapshot: BreakerSnapshot | null;
  /**
   * REQUIRED when `snapshot` is `null` or unusable: why. Carried into the
   * decision so the reason travels with it.
   */
  unavailableBecause?: string;
  /**
   * WHEN THE CLIENT RECEIVED THE SNAPSHOT, ON THE CLIENT'S OWN CLOCK, epoch ms.
   *
   * ---------------------------------------------------------------------------
   * THE CEILING IS ANCHORED HERE, AND IT USED TO BE ANCHORED ON THE SERVER
   * ---------------------------------------------------------------------------
   *
   * The honouring ceiling was computed as `min(freshUntil, evaluatedAt + MAX)`,
   * which mixes a SERVER-SUPPLIED timestamp with a CLIENT clock. Nothing
   * validates `evaluatedAt` against the client's own time, and the failure is
   * two-sided and both sides are bad:
   *
   *   SERVER AHEAD    an `evaluatedAt` an hour in the client's future makes the
   *                   ceiling an hour of extra grace. THE CAP THAT EXISTS TO
   *                   STOP A COMPROMISED DEPLOYMENT GRANTING A YEAR-LONG
   *                   PERMISSION IS DEFEATED BY THE VALUE IT IS CAPPING.
   *   SERVER BEHIND   every snapshot is born stale, every decision is a
   *                   decline, fleet-wide and permanently.
   *
   * A cap defeated by the value it is capping is not a cap. So the ceiling is
   * anchored on `receivedAt` — a moment the client observed on its own clock,
   * which no server can move — and `evaluatedAt` is kept for display and for
   * the coherence checks, where being wrong is legible rather than permissive.
   *
   * REQUIRED RATHER THAN OPTIONAL. An optional field with a fallback to
   * `evaluatedAt` would be the same defect behind a `??`, reachable by every
   * caller who did not read this doc.
   */
  receivedAt: number;
  /** Client clock now, epoch ms. Injected rather than read, so this function is pure and testable. */
  now: number;
  policy: BudgetUnavailablePolicy;
}

/** The reason string used when a caller declined to supply one. Never silently blank. */
const UNSTATED_REASON = "no reason was supplied by the caller";

/**
 * EVERY REASON A SNAPSHOT MUST NOT BE ENFORCED ON.
 *
 * ---------------------------------------------------------------------------
 * THE PRIMITIVE, SO EVERY CALLER OF THE DECISION RULE IS GATED — NOT JUST THE
 * ONE THAT REMEMBERED TO CALL A GATE
 * ---------------------------------------------------------------------------
 *
 * `{ state: 'tripped', trippedBudgetId: 'evil' }` — no limit, no evidence, no
 * reason — produced `declined_breaker_tripped` from {@link decideBudget}, while
 * the SDK's refusal list on the same body returned four separate refusals. The
 * guard was gated; the shared rule underneath it was not, so the CLI and every
 * other consumer of `decideBudget` enforced on a claim with nothing behind it.
 *
 * That is the causal edge with zero citations passing as recorded, in money. It
 * is also the same argument as `edge_cites_nothing`: REDUNDANCY ABOVE A HOLE IS
 * WHAT HIDES THE HOLE. The check belongs in the primitive everything reaches
 * for, not in the one layer whose author thought of it.
 *
 * NOTE THE DIRECTION OF THE FIX. An untrustworthy snapshot does NOT become an
 * allow: it becomes "we could not establish anything", which the caller's own
 * {@link BudgetUnavailablePolicy} adjudicates — a decline under `deny` and
 * `grace`, and a stated, auditable allow under `allow`. Silently dropping the
 * malformed trip and reading the rest would have been the permissive reading.
 *
 * MUST NEVER THROW: it runs on a body nothing has vouched for.
 *
 * @param snapshot - anything at all.
 * @returns every refusal reason. Empty means the snapshot may be enforced on.
 */
export function breakerSnapshotRefusals(snapshot: BreakerSnapshot): string[] {
  try {
    if (!isRecordLike(snapshot)) return ["the snapshot is not an object"];
    return [
      // USABILITY FIRST. Every check below is a comparison, and a comparison
      // against a string does not throw — it takes a branch.
      ...snapshotUnusableFields(snapshot).map((f) => `${f.path}: ${f.reason}`),
      ...snapshotClaimContradictions(snapshot).map((f) => `${f.at}: ${f.contradiction} (claim ${f.claim})`),
    ];
  } catch (err) {
    // A hostile body (a proxy with raising getters) is a refusal, never an
    // exception. An exception in an enforcement path is a silent allow the
    // moment a caller wraps it in a try/catch.
    return [`the snapshot could not be inspected (${err instanceof Error ? err.message : String(err)})`];
  }
}

/** Does this finding's path point INSIDE `states[index]`, rather than merely mentioning it? */
function impugnsStateAt(path: string, index: number): boolean {
  const anchor = `states[${index}]`;
  // Exact, or a property/element BELOW it. Substring-matching the bare anchor
  // would make `states[1]` impugn `states[10]`.
  return path === anchor || path.includes(`${anchor}.`) || path.includes(`${anchor}[`);
}

/**
 * THE FIRST TRIPPED BREAKER WHOSE OWN CLAIM NOTHING IMPUGNS.
 *
 * ---------------------------------------------------------------------------
 * WHY A REFUSAL IS SCOPED TO WHAT IT ACTUALLY IMPUGNS
 * ---------------------------------------------------------------------------
 *
 * Gating {@link decideBudget} on the whole refusal list closed one hole and
 * opened its mirror image: ANY refusal anywhere nulled the entire snapshot, so
 * `scan.evaluationTruncated: 'no'` — one malformed sibling field, nowhere near
 * the breaker — ERASED A GENUINE, EVIDENCE-BACKED TRIP. Under `allow` that
 * flipped `declined_breaker_tripped` into `allowed_without_answer`. Under
 * `deny` and `grace` the outcome stayed safe, but the trip's IDENTITY AND
 * REASON were lost: an operator saw "no answer" where the truth was "budget b1
 * is blown, here is why".
 *
 * A well-formed trip and a typo in an unrelated field had become the same
 * input, which is the same class as the defect the gating fixed — a claim
 * judged by something other than the evidence beside it.
 *
 * THE SCOPING IS DELIBERATELY ONE-DIRECTIONAL, and that asymmetry is the safety
 * argument. Only the DECLINE outcome is allowed to survive a defect elsewhere
 * in the body:
 *
 *   A TRIP survives, because declining on a well-formed trip is never the
 *   permissive reading — the worst case is that we decline while some other
 *   part of the snapshot was garbage, and declining is what we would have done
 *   anyway.
 *
 *   HEADROOM DOES NOT survive. An `armed` breaker in a body with any refusal
 *   still nulls the snapshot, because "this breaker says there is room and
 *   something else in the response is malformed" is exactly the situation where
 *   the malformed part might be the reason there is no room.
 *
 * A trip is impugned by a finding whose PATH POINTS INSIDE ITS OWN STATE, or by
 * a claim contradiction naming its budget (an unsupported trip, or a duplicate
 * state for the same budget — "which of these two governs?" is a real defect in
 * the trip itself). Freshness fields, `scan`, and sibling states are none of
 * those, and never were.
 *
 * MUST NEVER THROW.
 *
 * @param snapshot - anything at all.
 * @returns the tripped state a decision may rely on, or `undefined`.
 */
export function establishedTrip(snapshot: BreakerSnapshot | null): BreakerTripped | undefined {
  try {
    if (!isRecordLike(snapshot)) return undefined;
    const unusable = snapshotUnusableFields(snapshot as BreakerSnapshot);
    const contradictions = snapshotClaimContradictions(snapshot as BreakerSnapshot);
    for (const [index, state] of indexedElements<BreakerState>(
      (snapshot as BreakerSnapshot).states
    ).entries()) {
      if (state === null || state.state !== "tripped") continue;
      const budgetId = state.trippedBudgetId;
      if (typeof budgetId !== "string" || budgetId.length === 0) continue;
      const impugned =
        unusable.some((f) => impugnsStateAt(f.path, index)) ||
        contradictions.some((f) => f.at.includes(budgetId));
      if (!impugned) return state;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE decision rule, in one place, for every surface that makes one.
 *
 * ---------------------------------------------------------------------------
 * PRECEDENCE, AND WHY EACH STEP IS WHERE IT IS
 * ---------------------------------------------------------------------------
 *
 *  1. A TRIPPED BREAKER DECLINES, EVEN ON A STALE SNAPSHOT. Checked FIRST,
 *     before freshness, and this ordering is load-bearing: a trip does not
 *     un-trip by ageing. If the last thing we heard was "this budget is
 *     blown" and we cannot re-ask, the honest reading is that it is still
 *     blown. Putting the freshness check first would mean an agent could spend
 *     freely for as long as it could keep the server unreachable — the exact
 *     bypass this feature exists to close.
 *
 *  2. NO USABLE SNAPSHOT -> THE POLICY DECIDES. `null`, malformed, incomplete,
 *     stale beyond grace, or carrying an `undetermined` state: all of these are
 *     "we could not establish headroom", and NONE of them is "there is
 *     headroom". An `undetermined` state is folded in here rather than given
 *     its own outcome because that is precisely what it means — the ADR-002
 *     estimate straddled the cap and nobody can say which side it is on.
 *
 *  3. A COMPLETE, FRESH SNAPSHOT WITH ZERO BUDGETS -> `allowed_no_budget_governs`,
 *     never `allowed_breaker_armed`. See {@link AllowedNoBudgetGoverns}.
 *
 *  4. A COMPLETE, FRESH SNAPSHOT WITH EVERY BREAKER ARMED -> proceed, and this
 *     is the only band that means enforcement worked.
 *
 * FRESHNESS IS CAPPED CLIENT-SIDE. `freshUntil` is honoured only up to
 * {@link MAX_BREAKER_ANSWER_FRESHNESS_MS} past `evaluatedAt`, whatever the
 * server said, so a buggy or compromised deployment cannot hand out an answer
 * good for a year.
 *
 * MUST NEVER THROW. It sits in the hot path of somebody's agent loop, on a body
 * nothing has vouched for, and an exception here is an enforcement outcome
 * nobody wrote a meaning for — which in a `try/catch` around a model call means
 * "proceed".
 *
 * @param input - snapshot (or `null`), clock, and the explicit unavailability policy.
 * @returns one of six bands. Use {@link mayProceed} for the boolean.
 */
export function decideBudget(input: BudgetDecisionInput): BudgetDecision {
  const now = isFiniteNumber(input?.now) ? input.now : Number.NaN;
  const receivedAt = isFiniteNumber(input?.receivedAt) ? input.receivedAt : Number.NaN;
  const policy = input?.policy;
  let because =
    typeof input?.unavailableBecause === "string" && input.unavailableBecause.length > 0
      ? input.unavailableBecause
      : UNSTATED_REASON;

  let snapshot = isRecordLike(input?.snapshot) ? (input.snapshot as BreakerSnapshot) : null;
  // Computed BEFORE the gate nulls anything, because a well-formed trip must
  // survive a defect elsewhere in the body — see {@link establishedTrip}.
  const trip = establishedTrip(snapshot);

  // THE GATE, IN THE PRIMITIVE. An untrustworthy snapshot is treated as NO
  // snapshot — not as a snapshot whose readable parts may be enforced on. See
  // {@link breakerSnapshotRefusals} for the defect this closes. Note it runs
  // AFTER the trip has been identified and BEFORE anything permissive is read.
  if (snapshot !== null) {
    const refusals = breakerSnapshotRefusals(snapshot);
    if (refusals.length > 0) {
      because = `the breaker snapshot cannot be enforced on: ${refusals.join("; ")}`;
      snapshot = null;
    }
  }

  // A policy this contract does not define is not one to guess at. Fails
  // CLOSED, and says so — this is a caller bug, and the safe reading of a
  // caller bug in an enforcement path is "decline".
  const mode = (policy as { onUnavailable?: unknown })?.onUnavailable;
  if (mode !== "deny" && mode !== "grace" && mode !== "allow") {
    return {
      decision: "declined_no_answer",
      declinedByPolicy: "deny",
      noAnswerBecause: `no valid BudgetUnavailablePolicy was supplied (got ${JSON.stringify(mode ?? null)})`,
      wouldBeAnsweredBy:
        "construct the guard with an explicit { onUnavailable: 'deny' | 'grace' | 'allow' } policy — there is " +
        "deliberately no default, because failing open and failing closed have different costs paid by " +
        "different people",
      declinedAt: isFiniteNumber(now) ? now : 0,
    };
  }

  // STEP 1 — A TRIP DECLINES REGARDLESS OF FRESHNESS, AND REGARDLESS OF A
  // DEFECT ELSEWHERE IN THE BODY. Before every other check.
  //
  // Freshness: a trip does not un-trip by ageing. If the last thing we heard was
  // "this budget is blown" and we cannot re-ask, it is still blown — otherwise
  // an agent could spend freely for as long as it could keep the server away.
  //
  // Sibling defects: see {@link establishedTrip}. A typo in `scan` is not a
  // reason to tell an operator "no answer" when the truth is "budget b1 is
  // blown, here is why".
  const tripped = trip;
  if (tripped !== undefined) {
    return {
      decision: "declined_breaker_tripped",
      declinedForBudgetId: tripped.trippedBudgetId,
      breakerTrippedAt: isFiniteNumber(tripped.trippedAt) ? tripped.trippedAt : 0,
      breakerTrippedBecause:
        typeof tripped.trippedBecause === "string" && tripped.trippedBecause.length > 0
          ? tripped.trippedBecause
          : "the server reported this breaker tripped without stating a reason",
      declinedAt: isFiniteNumber(now) ? now : 0,
    };
  }

  const unavailable = (reason: string, remedy: string): BudgetDecision => {
    if (mode === "allow") {
      return {
        decision: "allowed_without_answer",
        allowedByPolicy: "allow",
        unansweredBecause: reason,
        allowAcceptedRisk: (policy as { acceptedRisk?: string }).acceptedRisk ?? UNSTATED_REASON,
        unansweredAt: isFiniteNumber(now) ? now : 0,
      };
    }
    return {
      decision: "declined_no_answer",
      declinedByPolicy: mode,
      noAnswerBecause: reason,
      wouldBeAnsweredBy: remedy,
      declinedAt: isFiniteNumber(now) ? now : 0,
    };
  };

  if (!isFiniteNumber(now)) {
    return unavailable(
      "the client clock supplied to decideBudget was not a finite number, so freshness could not be evaluated",
      "pass a real epoch-ms timestamp as `now`"
    );
  }
  if (snapshot !== null && !isFiniteNumber(receivedAt)) {
    // The ceiling is anchored on `receivedAt`; without it there is no clock the
    // client controls, and falling back to the server's would be exactly the
    // defect that field exists to close.
    return unavailable(
      "no client-observed `receivedAt` was supplied, so the honouring ceiling could not be anchored on a clock " +
        "this process controls",
      "record the client clock at the moment the snapshot arrives and pass it as `receivedAt`"
    );
  }
  if (snapshot !== null && receivedAt > now) {
    // ---------------------------------------------------------------------
    // AN IMPOSSIBLE ORDERING BETWEEN TWO CLIENT INSTANTS, NAMED — BECAUSE THE
    // OTHER PAIR ALREADY IS
    // ---------------------------------------------------------------------
    //
    // `shelf_life_not_positive` rejects `freshUntil <= evaluatedAt`: two
    // instants from ONE clock in an order that clock could not have produced.
    // `receivedAt` and `now` are the same shape one layer down — both from the
    // CLIENT's clock — and were compared without ever being related, so an
    // arrival stamped AFTER the check was honoured unexamined, and a clock
    // jumping backward between receipt and check extended the answer's life
    // without limit. Both present identically as `receivedAt > now`, so one
    // check covers them.
    //
    // Deciding an impossible ordering is a malformity for one pair and not the
    // other is the "applied at N call sites" shape this iteration has now
    // produced five times. The severity here is low — `BudgetGuard` stamps both
    // from a single injected clock, so the shipped path cannot reach it — but
    // the primitive is exported, and a rule that holds only because the one
    // caller in tree happens to be careful is not a rule.
    //
    // FAILS CLOSED, like every other thing this function cannot make sense of.
    return unavailable(
      `the snapshot's arrival (${receivedAt}) is later than the moment of this check (${now}), which no single ` +
        `clock can produce — either the arrival was stamped from a different clock than the one deciding, or the ` +
        `client clock moved backward between the two`,
      "stamp `receivedAt` and `now` from the SAME monotonic-enough clock, as `BudgetGuard` does, and re-request " +
        "the snapshot"
    );
  }
  if (snapshot === null) {
    return unavailable(because, "call FlightReader.getBudgetSnapshot(), or let an ingest response carry one back");
  }
  if (!isBreakerSnapshotComplete(snapshot)) {
    return unavailable(
      `the breaker snapshot is not a complete answer (${because})`,
      "re-request the snapshot; if the server keeps reporting a truncated evaluation, the subject may be " +
        "governed by more budgets than the evaluation ceiling allows"
    );
  }

  // Undetermined states are handled here rather than as their own outcome: an
  // approximate figure that straddles the cap has established nothing, and
  // "nothing established" is exactly what the policy exists to adjudicate.
  const undetermined = soundElements<BreakerState>(snapshot.states).find(
    (s): s is BreakerStateUndetermined => s?.state === "undetermined"
  );
  if (undetermined !== undefined) {
    return unavailable(
      `breaker state for ${undetermined.undeterminedBudgetId} could not be established: ` +
        `${undetermined.undeterminedBecause}`,
      undetermined.wouldBeDeterminedBy
    );
  }

  const evaluatedAt = snapshot.evaluatedAt;
  // THE SERVER CONTRIBUTES A DURATION AND NO ABSOLUTE INSTANT.
  //
  // `freshUntil - evaluatedAt` is skew-invariant: both endpoints come from the
  // server's clock, so the interval survives that clock being wrong by any
  // amount, in either direction. Every comparison below is then between two
  // moments the CLIENT observed. See {@link BreakerSnapshot.freshUntil} for the
  // two-sided defect this closes — a server ahead used to buy extra permission,
  // and a server behind used to decline a whole fleet.
  //
  // Transit time is not subtracted, so the window granted is the server's
  // stated duration measured from ARRIVAL rather than from evaluation. That is
  // marginally more generous than the server intended, bounded by request
  // latency and hard-bounded by MAX_BREAKER_ANSWER_FRESHNESS_MS regardless —
  // and it is the direction that does not halt a business on a slow network.
  // Explicit when the deployment sends it, derived when it does not — one
  // reader, so the guard's refresh scheduler cannot disagree with this.
  const shelfLifeMs = statedShelfLifeMs(snapshot);
  if (shelfLifeMs === null) {
    return unavailable(
      "the snapshot states no usable shelf life (neither `shelfLifeMs` nor a positive `freshUntil - evaluatedAt`)",
      "send `shelfLifeMs` as a positive duration in milliseconds"
    );
  }
  //
  // THIS IS ALSO WHERE `validUntil` IS ENFORCED. The server cannot make a
  // cached `proceed` stop being one; only the process holding it can, and this
  // is that line: past `effectiveFreshUntil`, an answer that said "armed" stops
  // being an answer at all and the policy takes over.
  const effectiveFreshUntil = receivedAt + Math.min(shelfLifeMs, MAX_BREAKER_ANSWER_FRESHNESS_MS);

  if (now <= effectiveFreshUntil) {
    if (snapshot.scan.budgetsInScope === 0) {
      return {
        decision: "allowed_no_budget_governs",
        budgetsInScope: 0,
        unbudgetedSubject: snapshot.scan.subject,
        ungovernedAt: now,
      };
    }
    const armed = soundElements<BreakerState>(snapshot.states)
      .filter((s): s is BreakerArmed => s?.state === "armed")
      .map((s) => s.armedBudgetId)
      .filter((id): id is string => typeof id === "string");
    // `isBreakerSnapshotComplete` already established that every state is
    // readable and that none is undetermined or tripped, so a non-empty scope
    // with no armed ids would be a contradiction it should have caught. Fails
    // closed rather than trusting that.
    if (armed.length === 0) {
      return unavailable(
        "the snapshot reports budgets in scope but carries no armed breaker for any of them",
        "re-request the snapshot"
      );
    }
    return {
      decision: "allowed_breaker_armed",
      armedBudgetIds: armed as [string, ...string[]],
      answerEvaluatedAt: evaluatedAt,
      answerFreshUntil: effectiveFreshUntil,
    };
  }

  // STALE. Grace honours a yes we actually received, for a bounded window.
  if (mode === "grace") {
    const graceMs = Math.min((policy as { graceMs: number }).graceMs, MAX_BREAKER_GRACE_MS);
    const graceEndsAt = effectiveFreshUntil + (isAmount(graceMs) ? graceMs : 0);
    // NO `budgetsInScope > 0` CONDITION, AND ITS ABSENCE IS LOAD-BEARING.
    //
    // It was there, and it inverted the policy exactly where the policy has the
    // least to say. Same staleness, same outage: a breaker last seen ONE CENT
    // BELOW ITS CAP was honoured, while a subject NO BUDGET GOVERNS AT ALL was
    // declined. An org that has configured no budgets whatsoever had its agents
    // stopped by the budget breaker during an outage of ours — the
    // halt-a-business direction, aimed at the customers with the least reason
    // to expect it.
    //
    // The unbudgeted case is where we have the least to say and the least right
    // to intervene: there is no cap, so there is nothing to be past. Honouring
    // an expired "nothing governs this" is strictly safer than honouring an
    // expired "you have a little room left", and the old condition permitted
    // precisely the second and refused the first.
    if (now <= graceEndsAt) {
      return {
        decision: "allowed_within_grace",
        honouredAnswerExpiredAt: effectiveFreshUntil,
        graceEndsAt,
        unreachableBecause: because,
        graceAcceptedRisk: (policy as { acceptedRisk?: string }).acceptedRisk ?? UNSTATED_REASON,
      };
    }
  }

  return unavailable(
    `the breaker answer expired at ${new Date(effectiveFreshUntil).toISOString()} and could not be refreshed ` +
      `(${because})`,
    "call FlightReader.getBudgetSnapshot() again, or record an event so an ingest response can carry a fresh " +
      "snapshot back"
  );
}

// ---------------------------------------------------------------------------
// USABILITY — is what arrived something arithmetic can be done with AT ALL?
//
// The prior question to coherence, and genuinely different: a guard written as
// a comparison (`spent >= limit`) does not reject a non-number, it takes the
// other branch, and whether that branch is safe is luck. Asked directly, once,
// for every field that feeds a decision — and the SDK REFUSES a snapshot that
// fails it.
// ---------------------------------------------------------------------------

/** Why a field's contents cannot be used. Facts about the VALUE, never about any agent. */
export type BudgetUnusableReason =
  /** Missing entirely, or present as something that is not a non-negative integer. */
  | "not_an_amount"
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
   * A spend figure that is not usable — a reconciled figure with no complete-read
   * proof, an approximate figure with malformed bounds, a figure with no budget.
   *
   * THE CHECK THIS FEATURE EXISTS FOR, AT THE WIRE. The type system makes an
   * unproven exact figure unspellable in OUR code; a JSON body is not
   * typechecked, and a `basis: 'reconciled'` with no proof behind it is AN
   * ESTIMATE WEARING AN EXACT FIGURE'S CLOTHES — the one input that can certify
   * headroom against a cap.
   */
  | "unusable_spend_figure"
  /**
   * A snapshot that states no positive shelf life — a `shelfLifeMs` that is not
   * a positive whole number, or a `freshUntil` that does not strictly follow
   * `evaluatedAt`.
   *
   * NOTE WHAT THIS IS NOT, because the distinction is the N6 fix: a
   * `freshUntil` sitting in the CLIENT'S past is NOT reported here and must not
   * be. That is ordinary clock skew, and rejecting it would decline a whole
   * fleet whose server is running a minute behind. What is malformed is a
   * non-positive DURATION — an answer that was never good for any time at all —
   * which is skew-invariant and therefore decidable without a shared clock.
   */
  | "shelf_life_not_positive"
  /**
   * THE ENFORCEMENT-CLAIM WALK RAN OUT OF BUDGET before it covered the body, so
   * "no claim found" would be a statement about the SCAN rather than about the
   * body.
   *
   * A SILENT BOUND IS THE DEFECT THIS FILE EXISTS AGAINST, in its own
   * validator. The walk was depth-bounded and said nothing when the bound bit:
   * a claim planted ten levels down produced zero findings and no explanation,
   * which reads exactly like a clean body. That is `adjacency_unread` rendered
   * as `no_edge_recorded`, one altitude down.
   *
   * Fails CLOSED — this is a refusal, so an unauditable body is not enforced
   * on. No legitimate snapshot nests anywhere near the ceiling.
   */
  | "enforcement_claim_scan_truncated"
  /**
   * THE WIRE BODY ASSERTS SOMETHING ABOUT THE AGENT. A field from
   * {@link FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS} — `enforced`, `halted`,
   * `blocked`. We record and we decline; we do not stop a process, and no field
   * may say we did. See this file's invariant 1.
   */
  | "forbidden_enforcement_claim";

/** One unusable field, addressed by a path a human can act on. */
export interface BudgetUnusableFieldFinding {
  /** e.g. `"scan.budgetsInScope"`, `"states[0].determinedFrom[0]"`. */
  path: string;
  reason: BudgetUnusableReason;
}

/** Node budget for the claim walk. A malformed body must not be able to make a validator expensive. */
const MAX_CLAIM_SCAN_NODES = 20_000;
/**
 * Depth budget for the claim walk.
 *
 * Comfortably deeper than any legal snapshot (the deepest legitimate path is
 * `states[] -> determinedFrom[] -> establishedBy[]`, four levels) and bounded
 * against a hostile one. IT ANNOUNCES ITSELF WHEN IT BITES — see
 * {@link forbiddenClaimsIn}.
 */
const MAX_CLAIM_SCAN_DEPTH = 24;

/**
 * EVERY forbidden enforcement claim ANYWHERE IN THE BODY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RECURSES INSTEAD OF CHECKING THE PLACES SOMEBODY THOUGHT OF
 * ---------------------------------------------------------------------------
 *
 * It did not, and the defect that found is worth writing down rather than
 * quietly fixing. The check fired on the snapshot root, on `scan`, on each
 * state and on each spend figure — four call sites, chosen by hand — so
 * `agentStopped: true` planted inside a `SpendReconciliation` passed every
 * gate and was accepted. THE OBJECT IT HID IN IS THE ONE WHOSE ENTIRE JOB IS TO
 * CARRY `proves: "event_log_summed"`.
 *
 * That is the same shape this codebase has now produced defects from in nine
 * layers: THE RULE IS RIGHT AND ITS APPLICATION IS PARTIAL. A depth-bounded
 * walk over hand-picked branches is a hand-maintained list wearing a recursion,
 * and it fails the way lists fail — by omitting the branch nobody thought
 * about, silently, in the permissive direction. `armedLimit`, `trippedLimit`
 * and `scan.subject` were three more, all reachable, none checked.
 *
 * So the walk is TOTAL over the body. Coverage is a property of the traversal
 * rather than of whoever last edited a call site, and a new nested type added
 * to a snapshot is covered by this function the day it is added.
 *
 * BOUNDED AND CYCLE-SAFE. A `seen` set, a node budget and a depth budget, so it
 * terminates on any input including one deliberately malformed — a validator
 * that hangs at a boundary is worse than one that returns a wrong answer. It
 * also NEVER THROWS: a proxy with raising getters is reported as an
 * uninspectable body, not propagated, because an exception in an enforcement
 * path is an enforcement outcome nobody chose.
 */
function forbiddenClaimsIn(value: unknown, at: string): BudgetUnusableFieldFinding[] {
  const found: BudgetUnusableFieldFinding[] = [];
  const seen = new Set<object>();
  let visited = 0;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): void => {
    // THE BOUND ANNOUNCES ITSELF. A silent ceiling is the shape this whole file
    // exists to prevent: "we did not look" reported as "there is nothing here"
    // is the same defect as an unmeasured base rate reading as a measured one,
    // and a validator is the last place it should appear. Returning quietly
    // here meant a claim planted below the ceiling produced ZERO findings and
    // ZERO explanation — indistinguishable from a clean body.
    //
    // It fails CLOSED: the finding is a refusal, so a body too deep to audit is
    // refused rather than trusted. No legitimate snapshot approaches this depth,
    // so the only bodies affected are ones nobody should be enforcing on.
    if (visited >= MAX_CLAIM_SCAN_NODES || depth > MAX_CLAIM_SCAN_DEPTH) {
      if (!truncated) {
        truncated = true;
        found.push({ path, reason: "enforcement_claim_scan_truncated" });
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
      if (FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS.includes(key)) {
        found.push({ path: `${path}.${key}`, reason: "forbidden_enforcement_claim" });
      }
      walk((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
    }
  };

  try {
    walk(value, at, 0);
  } catch {
    return [{ path: at, reason: "forbidden_enforcement_claim" }];
  }
  return found;
}

/**
 * Every field in a snapshot whose contents cannot be used.
 *
 * THE ONE FUNCTION A BOUNDARY SHOULD CALL, and it must run BEFORE
 * {@link snapshotClaimContradictions} and before any decision is made — both do
 * arithmetic and comparison, and a comparison against a string does not throw,
 * it takes a branch.
 *
 * MUST NEVER THROW. It runs at a boundary, on a JSON body nothing has vouched
 * for, so every collection it walks is checked before it is walked.
 *
 * @param snapshot - anything at all.
 * @returns every unusable field, in a stable order. Empty means arithmetic is
 *   safe — NOT that the numbers are right.
 */
export function snapshotUnusableFields(snapshot: BreakerSnapshot): BudgetUnusableFieldFinding[] {
  const found: BudgetUnusableFieldFinding[] = [];
  if (!isRecordLike(snapshot)) return [{ path: "(snapshot)", reason: "malformed_element" }];

  const amount = (value: unknown, path: string): void => {
    if (!isAmount(value)) found.push({ path, reason: "not_an_amount" });
  };

  if (!isFiniteNumber(snapshot.evaluatedAt)) found.push({ path: "evaluatedAt", reason: "not_a_finite_number" });
  if (!isFiniteNumber(snapshot.freshUntil)) found.push({ path: "freshUntil", reason: "not_a_finite_number" });
  if (
    isFiniteNumber(snapshot.evaluatedAt) &&
    isFiniteNumber(snapshot.freshUntil) &&
    snapshot.freshUntil <= snapshot.evaluatedAt
  ) {
    found.push({ path: "freshUntil", reason: "shelf_life_not_positive" });
  }
  // The explicit duration, when present, must itself be a positive whole
  // number of milliseconds. A `shelfLifeMs: 0` is not a cautious server, it is
  // an answer that was never good for any time at all.
  const explicitShelfLife = (snapshot as unknown as Record<string, unknown>)["shelfLifeMs"];
  if (explicitShelfLife !== undefined && !(isAmount(explicitShelfLife) && explicitShelfLife > 0)) {
    found.push({ path: "shelfLifeMs", reason: "shelf_life_not_positive" });
  }
  // ONE TOTAL SWEEP OVER THE WHOLE BODY — not one per branch somebody listed.
  // See {@link forbiddenClaimsIn} for the defect that motivated the change.
  found.push(...forbiddenClaimsIn(snapshot, "(snapshot)"));

  const scan: Record<string, unknown> | null = isRecordLike(snapshot.scan)
    ? (snapshot.scan as unknown as Record<string, unknown>)
    : null;
  if (scan === null) {
    found.push({ path: "scan", reason: "malformed_element" });
  } else {
    amount(scan["budgetsInScope"], "scan.budgetsInScope");
    amount(scan["budgetsEvaluated"], "scan.budgetsEvaluated");
    if (typeof scan["evaluationTruncated"] !== "boolean") {
      found.push({ path: "scan.evaluationTruncated", reason: "not_a_boolean" });
    }
    if (!isRecordLike(scan["subject"])) found.push({ path: "scan.subject", reason: "malformed_element" });
  }

  for (const [index, state] of indexedElements<BreakerState>(snapshot.states).entries()) {
    const at = `states[${index}]`;
    if (state === null) {
      found.push({ path: at, reason: "malformed_element" });
      continue;
    }
    if (state.state === "tripped") {
      if (!isFiniteNumber(state.trippedAt)) found.push({ path: `${at}.trippedAt`, reason: "not_a_finite_number" });
      if (typeof state.trippedBudgetId !== "string" || state.trippedBudgetId.length === 0) {
        found.push({ path: `${at}.trippedBudgetId`, reason: "not_a_known_value" });
      }
      if (typeof state.trippedBecause !== "string" || state.trippedBecause.length === 0) {
        found.push({ path: `${at}.trippedBecause`, reason: "missing_required_reason" });
      }
      if (state.trippedBy !== "limit_reached" && state.trippedBy !== "manual_trip") {
        found.push({ path: `${at}.trippedBy`, reason: "not_a_known_value" });
      }
      found.push(...figureFindings(state.determinedFrom, `${at}.determinedFrom`));
    } else if (state.state === "armed") {
      if (typeof state.armedBudgetId !== "string" || state.armedBudgetId.length === 0) {
        found.push({ path: `${at}.armedBudgetId`, reason: "not_a_known_value" });
      }
      if (!isFiniteNumber(state.establishedAt)) {
        found.push({ path: `${at}.establishedAt`, reason: "not_a_finite_number" });
      }
      found.push(...figureFindings(state.establishedUnderBy, `${at}.establishedUnderBy`));
    } else if (state.state === "undetermined") {
      if (typeof state.undeterminedBudgetId !== "string" || state.undeterminedBudgetId.length === 0) {
        found.push({ path: `${at}.undeterminedBudgetId`, reason: "not_a_known_value" });
      }
      if (typeof state.undeterminedBecause !== "string" || state.undeterminedBecause.length === 0) {
        found.push({ path: `${at}.undeterminedBecause`, reason: "missing_required_reason" });
      }
      if (typeof state.wouldBeDeterminedBy !== "string" || state.wouldBeDeterminedBy.length === 0) {
        found.push({ path: `${at}.wouldBeDeterminedBy`, reason: "missing_required_reason" });
      }
    } else {
      // Fails closed rather than being read as one of the three. A fourth state
      // is not a deployment to guess at, and with money the wrong guess is
      // `armed`.
      found.push({ path: `${at}.state`, reason: "not_a_known_value" });
    }
  }

  return found;
}

/** Every unusable spend figure in a collection, positioned. Empty collections are reported by the claim audits. */
function figureFindings(figures: unknown, at: string): BudgetUnusableFieldFinding[] {
  const found: BudgetUnusableFieldFinding[] = [];
  for (const [index, figure] of indexedElements<SpendFigure>(figures).entries()) {
    if (figure === null) {
      found.push({ path: `${at}[${index}]`, reason: "malformed_element" });
      continue;
    }
    if (spendUsability(figure) === "unusable") {
      found.push({ path: `${at}[${index}]`, reason: "unusable_spend_figure" });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// SELF-CLAIMS — every assertion a snapshot makes, checked against the figures
// it ships with.
//
// THE CLASS, from `causality.ts`, which met it four times in one file:
//
//   VERIFYING THAT A CLAIM IS PRESENT AND INTERNALLY WELL-FORMED IS NOT
//   VERIFYING THAT IT AGREES WITH THE DATA BESIDE IT.
//
// A breaker that says `armed` while carrying a figure that compares
// `provably_at_or_over` is not a weaker answer, it is a false one — and it is
// the shape a rounding bug or a stale cache produces. All of it is decidable
// from the snapshot's own contents at no extra request, because every state
// carries the limit it is about.
//
// Driven by a TOTAL table over the claim kinds, so a new self-claim is a
// compile error until it has an audit. Nothing chooses which claims to check at
// a call site.
// ---------------------------------------------------------------------------

/** A kind of assertion a snapshot makes about itself. Each one has a mandatory audit. */
export type BudgetClaim =
  /** A tripped breaker asserts the limit was reached. Audited against its own figures. */
  | "trip_is_supported_by_spend"
  /**
   * An armed breaker asserts headroom. Audited against its own figures — and
   * this is the ADR-002 audit: an approximate figure that straddles the cap
   * establishes nothing, so it cannot arm a breaker.
   */
  | "armed_headroom_is_established"
  /** Every figure asserts it is about the state's own budget. Audited against the limit beside it. */
  | "figure_is_for_this_budget"
  /** The scan asserts how many breakers were evaluated. Audited against the state list. */
  | "scan_count_matches_states"
  /** Every state asserts a distinct budget. Two states for one budget is a snapshot that disagrees with itself. */
  | "budgets_are_distinct";

/** How a claim contradicted the data beside it. */
export type BudgetClaimContradiction =
  /** A tripped breaker citing no spend figure at all. An arrow with nothing behind it, in money. */
  | "trip_cites_nothing"
  /**
   * A `limit_reached` trip whose figures do NOT establish the limit was
   * reached. The trip may still be right; the snapshot does not show it, and a
   * breaker that trips on evidence it cannot show is one nobody will trust the
   * second time.
   */
  | "trip_not_established_by_its_own_figures"
  /** An armed breaker citing no spend figure at all. */
  | "armed_cites_nothing"
  /**
   * AN ARMED BREAKER WHOSE OWN FIGURES DO NOT ESTABLISH HEADROOM. THE CENTRAL
   * ONE. An approximate spend of 9,900 against a 10,000 cap, with no stated
   * understatement bound, compares `not_decidable` — and a breaker armed on it
   * is "we could not tell" rendered as "there is room", which is the failure
   * this whole feature exists to prevent.
   */
  | "armed_on_undecidable_spend"
  /** An armed breaker carrying a figure that is provably AT OR OVER its own limit. Self-refuting. */
  | "armed_over_its_own_limit"
  /** A figure whose `forBudgetId` is not the budget of the state carrying it. It answers a different question. */
  | "figure_for_a_different_budget"
  /** `scan.budgetsEvaluated` disagrees with the number of readable states. */
  | "state_count_disagrees_with_scan"
  /** Two states for the same budget id. Which one governs? */
  | "duplicate_budget_state";

/** One contradiction, and what it was found in. */
export interface BudgetClaimFinding {
  claim: BudgetClaim;
  contradiction: BudgetClaimContradiction;
  /** e.g. `"states[0](tripped:budget_7)"`. */
  at: string;
}

/** The snapshot, indexed once, so no audit re-walks the state list. */
interface SnapshotIndex {
  tripped: BreakerTripped[];
  armed: BreakerArmed[];
  states: BreakerState[];
}

/**
 * The budget id a state is about, whichever band it is.
 *
 * INTERNAL AND DELIBERATELY NOT EXPORTED, exactly like `causality.ts`'s
 * `terminusRunId`. The whole point of `trippedBudgetId` / `armedBudgetId` /
 * `undeterminedBudgetId` being different names — and of `trippedLimit` /
 * `armedLimit` / `undeterminedLimit` likewise — is that no renderer can print
 * one under another's heading. A shared accessor handed to consumers would
 * re-open precisely that. This is an internal audit that needs the id purely to
 * check set membership, never to say anything about it, and the audits below
 * read each band's own limit AFTER narrowing rather than through a collapsed
 * accessor for the same reason.
 */
function stateBudgetId(state: BreakerState): string | undefined {
  if (state?.state === "tripped") return state.trippedBudgetId;
  if (state?.state === "armed") return state.armedBudgetId;
  if (state?.state === "undetermined") return state.undeterminedBudgetId;
  return undefined;
}

/**
 * EVERY CLAIM KIND, WITH ITS MANDATORY AUDIT.
 *
 * A TOTAL `Record` over {@link BudgetClaim}, so a new claim a snapshot can make
 * about itself is a COMPILE ERROR here until somebody writes the check that
 * audits it against the data beside it.
 */
const BUDGET_CLAIM_AUDITS: Record<BudgetClaim, (index: SnapshotIndex) => BudgetClaimFinding[]> = {
  trip_is_supported_by_spend: (index) =>
    index.tripped.flatMap((state): BudgetClaimFinding[] => {
      const at = `states(tripped:${state.trippedBudgetId})`;
      const figures = soundElements<SpendFigure>(state.determinedFrom);
      if (figures.length === 0) {
        return [{ claim: "trip_is_supported_by_spend" as const, contradiction: "trip_cites_nothing" as const, at }];
      }
      // A MANUAL trip is licensed by an operator, not by arithmetic, so it is
      // not audited against the meter. It is audited server-side into the
      // append-only admin audit log (CLAUDE.md Event Log Rule 6).
      if (state.trippedBy !== "limit_reached") return [];
      const limit = state.trippedLimit;
      const established = figures.some((f) => compareSpendToLimit(f, limit) === "provably_at_or_over");
      return established
        ? []
        : [
            {
              claim: "trip_is_supported_by_spend" as const,
              contradiction: "trip_not_established_by_its_own_figures" as const,
              at,
            },
          ];
    }),

  armed_headroom_is_established: (index) =>
    index.armed.flatMap((state): BudgetClaimFinding[] => {
      const at = `states(armed:${state.armedBudgetId})`;
      const figures = soundElements<SpendFigure>(state.establishedUnderBy);
      if (figures.length === 0) {
        return [
          { claim: "armed_headroom_is_established" as const, contradiction: "armed_cites_nothing" as const, at },
        ];
      }
      const limit = state.armedLimit;
      const comparisons = figures.map((f) => compareSpendToLimit(f, limit));
      // SELF-REFUTING FIRST: a figure over the cap on an armed breaker is a
      // sharper defect than one that merely cannot decide, and reporting it as
      // the vaguer code would send an engine author looking in the wrong place.
      if (comparisons.includes("provably_at_or_over")) {
        return [
          { claim: "armed_headroom_is_established" as const, contradiction: "armed_over_its_own_limit" as const, at },
        ];
      }
      if (!comparisons.includes("provably_under")) {
        return [
          {
            claim: "armed_headroom_is_established" as const,
            contradiction: "armed_on_undecidable_spend" as const,
            at,
          },
        ];
      }
      return [];
    }),

  figure_is_for_this_budget: (index) =>
    index.states.flatMap((state): BudgetClaimFinding[] => {
      const budgetId = stateBudgetId(state);
      if (typeof budgetId !== "string") return [];
      const figures =
        state.state === "tripped"
          ? soundElements<SpendFigure>(state.determinedFrom)
          : state.state === "armed"
            ? soundElements<SpendFigure>(state.establishedUnderBy)
            : [];
      return figures
        .filter((f) => f.forBudgetId !== budgetId)
        .map((f) => ({
          claim: "figure_is_for_this_budget" as const,
          contradiction: "figure_for_a_different_budget" as const,
          at: `states(${state.state}:${budgetId}) figure for ${String(f.forBudgetId)}`,
        }));
    }),

  // The only audit that needs the SCAN rather than the state list, so it is run
  // by {@link snapshotClaimContradictions} after the table. It has an entry here
  // regardless, because the table is what makes coverage total — a claim kind
  // with no key would be a claim nobody audits, which is the hole this shape
  // exists to close.
  scan_count_matches_states: () => [],

  budgets_are_distinct: (index) => {
    const seen = new Set<string>();
    const findings: BudgetClaimFinding[] = [];
    for (const state of index.states) {
      const budgetId = stateBudgetId(state);
      if (typeof budgetId !== "string") continue;
      if (seen.has(budgetId)) {
        findings.push({
          claim: "budgets_are_distinct",
          contradiction: "duplicate_budget_state",
          at: `states(${budgetId})`,
        });
        continue;
      }
      seen.add(budgetId);
    }
    return findings;
  },
};

/**
 * Every claim this snapshot makes that the data beside it contradicts.
 *
 * THE ONE FUNCTION A GATE SHOULD CALL FOR SELF-CONSISTENCY, alongside
 * {@link snapshotUnusableFields}. It indexes the snapshot once and runs every
 * entry in the audit table, so coverage is a property of the table rather than
 * of whoever last edited a gate.
 *
 * MUST NEVER THROW: it runs at a boundary on a body nothing has vouched for.
 *
 * @param snapshot - anything at all.
 * @returns every contradiction, in a stable order. Empty means the snapshot's
 *   claims agree with its own figures — NOT that the figures are right.
 */
export function snapshotClaimContradictions(snapshot: BreakerSnapshot): BudgetClaimFinding[] {
  if (!isRecordLike(snapshot)) return [];
  const states = soundElements<BreakerState>(snapshot.states);
  const index: SnapshotIndex = {
    states,
    tripped: states.filter((s): s is BreakerTripped => s?.state === "tripped" && isRecordLike(s.trippedLimit)),
    armed: states.filter((s): s is BreakerArmed => s?.state === "armed" && isRecordLike(s.armedLimit)),
  };
  const findings = (Object.keys(BUDGET_CLAIM_AUDITS) as BudgetClaim[]).flatMap((claim) =>
    BUDGET_CLAIM_AUDITS[claim](index)
  );

  // The scan-count audit needs the scan, which the index does not carry.
  const evaluated = (snapshot.scan as unknown as Record<string, unknown> | undefined)?.["budgetsEvaluated"];
  if (isAmount(evaluated) && states.length !== evaluated) {
    findings.push({
      claim: "scan_count_matches_states",
      contradiction: "state_count_disagrees_with_scan",
      at: `scan.budgetsEvaluated=${evaluated} vs ${states.length} readable state(s)`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// PRIVILEGED MUTATIONS — definition, manual trip, manual reset
//
// These are ADMIN operations, audited server-side into the append-only admin
// audit log (CLAUDE.md Event Log Rule 6). The contract shapes live here so the
// CLI, the web UI and the Convex mutation are built from one vocabulary.
// ---------------------------------------------------------------------------

/** Create or replace a budget definition. Admin-gated and audited server-side. */
export interface UpsertBudgetRequest {
  /** Omit to create; supply to replace. */
  budgetId?: string;
  scope: BudgetScope;
  scopeId: string;
  meter: BudgetMeter;
  period: BudgetPeriod;
  /** INTEGER, in the meter's own unit. See {@link BudgetMeter}. */
  limitAmount: number;
  currency?: string;
  enabled: boolean;
}

/**
 * Trip a breaker by hand.
 *
 * REQUIRES A REASON, and the reason is stored: a manual trip is the one kind
 * that arithmetic cannot justify, so the justification has to be a human
 * sentence in the audit log. `afr budget trip` refuses to send without one.
 */
export interface ManualTripRequest {
  budgetId: string;
  /** REQUIRED, non-empty. Written to the admin audit log. */
  reason: string;
}

/**
 * Reset a tripped breaker.
 *
 * SEPARATE FROM `UpsertBudgetRequest`, deliberately: raising a limit and
 * clearing a trip are different acts with different blast radii, and an
 * operator who wanted the second should not be able to do the first by
 * supplying one extra field.
 */
export interface ManualResetRequest {
  budgetId: string;
  /** REQUIRED, non-empty. Written to the admin audit log. */
  reason: string;
}

/** The result of a privileged budget mutation. `auditLogId` is the receipt. */
export interface BudgetMutationResult {
  budgetId: string;
  /** The append-only admin audit log entry this mutation wrote. The receipt an operator can cite. */
  auditLogId: string;
  appliedAt: number;
}
