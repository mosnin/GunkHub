// ---------------------------------------------------------------------------
// BUDGET CIRCUIT BREAKERS — the server's spend-figure and breaker-state engine.
//
// PURE. Deterministic. No `ctx`, no `ctx.db`, no I/O, no `Date.now()`, no
// randomness. Same posture as convex/helpers/{fleet,causal_graph,divergence,
// otel_mapping,analytics,failure_summary}.ts. `now` is an INPUT for the same
// reason `analyzedAt` is in helpers/fleet.ts.
//
// ===========================================================================
// PART 1 — THE CONTRACT VOCABULARY, IMPORTED (not mirrored)
// ===========================================================================
//
// Everything about spend, limits, breaker state, coverage and freshness is
// IMPORTED from `packages/contracts/src/budgets.ts`, which is CANONICAL. There
// is no copy of it here.
//
// AN EARLIER DRAFT OF THIS FILE DEFINED THE VOCABULARY LOCALLY — `BudgetDecision`,
// `BreakerState`, `BudgetClaim` and `decideBudget`, all four colliding with the
// contract's names and none matching its shapes. It was wrong in the most
// expensive possible way, and the cost was MEASURED rather than theorised: Team
// D fed this module's output into the shipped `snapshotRefusals` and got THREE
// REFUSALS WITH ZERO SHARED FIELDS. A refusal's failure direction is DECLINE, so
// a customer wiring the documented example would have halted their fleet.
//
// The local copy was DELETED rather than kept in sync — the only correct
// resolution, and the same one helpers/causal_graph.ts and helpers/fleet.ts each
// record having reached before it. This is the THIRD time this repository has
// paid for one certainty boundary having two definitions.
//
// THE ONE COST, STATED: `@agent-flight-recorder/contracts` resolves through
// `dist/`, a gitignored build artifact, so `convex typecheck` requires
// `packages/contracts` to be BUILT first. helpers/{divergence,fleet,causal_graph}
// already record this coupling; this file inherits it and adds nothing new.
//
// ===========================================================================
// PART 2 — THE ACCOUNTING RULING, PLAINLY
//
// The question was whether the accounting is exact or explicitly approximate,
// then sharpened: given what the substrate actually does, is "approximate" even
// generous enough? The answer is not one answer but four, because there are four
// different numbers underneath and they are NOT equally bad.
// ===========================================================================
//
// (a) `usage_counters` — NOT AN ESTIMATE OF SPEND, AND NEVER READ HERE.
//     `incrementUsageCounters` flushes single-unit increments ~1-in-
//     `USAGE_FLUSH_STRIDE` and multiplies by `STRIDE` when it does, so the same
//     100 true events report anywhere from ~1 to ~991 depending only on
//     `Math.random`. A ~1000x spread is not an error bar, it is a different
//     quantity. ADR-002 licenses "approximate"; it does not license this for a
//     limit. A breaker built on it trips at random. NOT READ — not as a
//     fallback, not as a hint. Asserted structurally in convex/budgets.test.ts.
//
// (b) `cost_minor_units` via `helpers/pricing.ts` — REFUSED OUTRIGHT.
//     `resolveModelPricing` matches by BIDIRECTIONAL SUBSTRING: `"o"` prices as
//     Sonnet 4.5 with `matched: true`; `"gemini"` takes the family's cheapest
//     (>10x under); `"claude-opus-4-6"` prices as `claude-opus-4`, 3x OVER,
//     which is the HALT direction. Ties break on key string LENGTH, so adding a
//     row silently reprices existing ambiguous models — a table that gets MORE
//     wrong as it grows. This module will not sign a figure derived from it:
//     {@link meterAmount} returns `null` for the cost meter and the breaker is
//     reported `undetermined` naming the defect.
//     THE FIX IS NOT MORE SUBSTRINGS. It is exact-match-plus-explicit-alias, or
//     reconciliation against a billed invoice. Neither is in this boundary.
//
// (c) `runs.tokensIn` / `runs.tokensOut` — THE ONE NUMBER WORTH GATING ON.
//     ADD-ONLY, UNSCALED, UNSAMPLED, summed at event-insert time over
//     idempotently-ingested events. Nothing decrements it, nothing multiplies
//     it. So THE SUM ITSELF HAS ZERO ERROR: it is an exact count of the tokens
//     this system RECORDED.
//
//     Its only shortfall is COVERAGE — an uninstrumented agent, or an
//     `llm.response` payload shape `extractTokenUsage` did not recognize (it
//     contributes zero and never throws), was never recorded and is not in the
//     sum. That shortfall is UNBOUNDED and unmeasurable in principle by a
//     recorder.
//
//     THE CONTRACT ALREADY HAS EXACTLY THIS SHAPE, and expressing it in the
//     contract's types instead of in prose is the whole gain from the refit:
//
//         kind:              "denormalised_run_counter"
//         couldOverstateBy:  0        <- it CANNOT be high
//         couldUnderstateBy: null     <- unbounded, and NOT zero
//
//     Feed that to `compareSpendToLimit` and the asymmetry falls out of the
//     contract's own arithmetic, with no special-casing anywhere:
//
//         provably_at_or_over   REACHABLE   (estimate - 0 >= limit)
//         provably_under        UNREACHABLE (couldUnderstateBy is null)
//
//     WHICH MEANS: A COUNTER-BACKED BREAKER CAN TRIP BUT CAN NEVER ARM. Below
//     the limit it is `undetermined`, not `armed`. That is not a limitation to
//     work around — it is the honest reading, and the contract's
//     `BreakerStateUndetermined` exists precisely so it has somewhere truthful
//     to sit instead of being rounded up to headroom.
//
// (d) THE EXACT PATH, BUILT RATHER THAN PROMISED. The contract's
//     `ReconciledSpend` requires a `SpendReconciliation` proving
//     `event_log_summed` with `logReadComplete: true`. That is achievable — by
//     summing `llm.response` events from the append-only log itself, which IS
//     the source of truth — but only over a bounded population. So it is offered
//     where it is affordable and honest, and nowhere else:
//
//       scope "run"    RECONCILED. One run's events are bounded by
//                      MAX_EVENTS_PER_RUN, read to completion or not at all.
//                      This breaker CAN arm and CAN trip, both provably. It is
//                      the narrow exact path the accounting can support.
//
//       wider scopes   APPROXIMATE per (c). Trips provably; never arms.
//
//     A hard limit on a soft number would have been the dishonest build. A
//     NARROW EXACT limit plus a WIDE provable-trip-only limit is what the data
//     actually supports, and it is what is built.
//
//     ONE LIMIT OF RECONCILIATION, STATED SO IT IS NOT OVERSOLD: it makes the
//     count exact over the LOG. Spend that was never recorded is not recoverable
//     from stored data by any means, so even a reconciled figure is a statement
//     about what this product observed — not about what a provider billed.
//
// ===========================================================================
// PART 3 — WE RECORD, WE REPORT; WE DO NOT STOP
// ===========================================================================
//
// The contract's INVARIANT 1 governs; this module implements rather than
// reinterprets it. "The breaker is tripped" is ours to state. "The agent
// stopped" is a fact about a process this product neither runs nor observes, and
// nothing here may assert it.
//
// The contract enforces this at the wire via `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS`
// (field NAMES a body may not carry). This module adds the complementary guard
// the contract CANNOT apply, because it operates on the server's own generated
// PROSE, which the contract receives as opaque required strings
// (`trippedBecause`, `undeterminedBecause`, `wouldBeDeterminedBy`): every such
// sentence composed here passes through {@link assertNoExecutionClaim}, swept in
// convex/helpers/budget.test.ts over the full generated cross-product.
//
// Both guards are needed. A producer can over-claim by adding a FIELD or by
// writing one SENTENCE.
//
// THE GUARD APPLIES TO OUR VOICE AND NEVER TO THE OPERATOR'S. An admin's note on
// a manual trip is stored verbatim under a field named `operatorNote` and is
// never composed into a system sentence. Censoring a human's account of what
// they did would be a worse dishonesty than the one being prevented.
//
// ===========================================================================
// PART 4 — TIME WINDOWS, AND THE ARITHMETIC THIS MODULE REFUSES TO REUSE
// ===========================================================================
//
// THIS MODULE DOES NOT CALL `dayBoundsUtc`, `currentUsageDay` OR `yesterdayUtc`,
// and does not read `daily_rollups`. All are defective for this purpose, in
// different directions:
//
//   `dayBoundsUtc` takes `"YYYY-MM-DD"` and returns `{NaN, NaN}` for a full ISO
//     timestamp — a SILENTLY EMPTY WINDOW, and empty reads as nothing spent,
//     which is the arm direction. Worse, six impossible dates (`2024-02-30`,
//     day-31 of 30-day months) return a perfectly well-formed 24-hour window FOR
//     THE WRONG DAY, which no downstream validity check can detect.
//   `currentUsageDay` / `yesterdayUtc` THROW where their sibling fails silently
//     — inconsistent enough that no caller can handle both correctly.
//   `daily_rollups` are computed for YESTERDAY ONLY. A daily spend breaker whose
//     only per-agent totals are yesterday's cannot see today's overspend at all,
//     which is the entire question it was configured to answer. (And
//     `computeRunStats` computes `runsWithTokenData` while `upsertDailyRollup`
//     drops it, so a rollup cannot even say how much of its day it saw.)
//
// So windows here are computed from EPOCH MILLISECONDS ONLY — never from a date
// string, which is where every one of those defects enters — and spend is summed
// from a LIVE, org-scoped range scan of `runs`, never from a rollup.
// {@link startOfUtcPeriod} takes a number and uses UTC field accessors, so there
// is no string to misparse; {@link isUsableInstant} rejects a non-finite instant
// explicitly rather than letting `new Date(NaN).toISOString()` throw from inside
// an evaluation.
//
// UTC ONLY, stated as a limitation rather than a default: `day` and `month` roll
// at 00:00 UTC wherever the operator sits. There is no per-org timezone in this
// schema and inventing one here would be a speculative field. An operator for
// whom that is wrong should use `hour`, or a run-scoped budget.
//
// SPEND IS ATTRIBUTED TO THE PERIOD A RUN STARTED IN, IN WHOLE. Attributing per
// event would need a time-ranged scan of `events` across a period, unaffordable
// at MAX_EVENTS_PER_RUN. The approximation is NAMED in every figure's
// `approximateBecause` rather than hidden.
//
// A PERIOD ROLL WRITES NOTHING TO THE APPEND-ONLY LOG. Evaluating, tripping,
// re-arming and resetting touch `budget_breakers` and `audit_log` and nothing
// else — asserted end-to-end in convex/budgets.test.ts by dumping `events` and
// `runs` across a roll that trips and re-arms.
//
// ===========================================================================
// PART 5 — VACUOUS TRUTH
// ===========================================================================
//
// The snapshot completeness predicate is the contract's
// `isBreakerSnapshotComplete`, USED AND NOT HAND-ROLLED, for the reason
// helpers/causal_graph.ts gives about `isCausalTraversalComplete`: completeness
// is the single input that turns "nothing found" into an all-clear, so a locally
// invented version of it is a locally invented all-clear.
//
// The two predicates defined locally each carry a POSITIVE clause, documented
// individually: {@link isSpendSumComplete} asserts the scan OBSERVED the end of
// its range (the scanner over-fetches by one and checks — never a `!truncated`
// that is true by default), and {@link isEvaluationFresh} asserts an evaluation
// HAPPENED and is stamped in the PAST (a future stamp otherwise reads fresh
// forever).
//
// A limit of 0 is separately refused at write time: `estimate - 0 >= 0` is TRUE
// having observed nothing, so a zero limit would trip every breaker on creation.
// ---------------------------------------------------------------------------

import {
  BREAKER_EVALUATION_CADENCE_MS,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  MAX_BREAKER_STATES,
  breakerCadenceInvariant,
  compareSpendToLimit,
  isBreakerSnapshotComplete,
  spendUsability,
  type ApproximateSpend,
  type BreakerScan,
  type BreakerSnapshot,
  type BreakerState,
  type BreakerStateUndetermined,
  type BreakerTripCause,
  type BudgetLimit,
  type BudgetMeter,
  type BudgetPeriod,
  type BudgetScope,
  type BudgetSubject,
  type ReconciledSpend,
  type SpendFigure,
  type SpendReconciliation,
} from "@agent-flight-recorder/contracts";

export type {
  BreakerScan,
  BreakerSnapshot,
  BreakerState,
  BreakerTripCause,
  BudgetLimit,
  BudgetMeter,
  BudgetPeriod,
  BudgetScope,
  BudgetSubject,
  SpendFigure,
};

export {
  BREAKER_EVALUATION_CADENCE_MS,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  MAX_BREAKER_STATES,
  breakerCadenceInvariant,
  compareSpendToLimit,
  isBreakerSnapshotComplete,
  spendUsability,
};

// ===========================================================================
// PART A — BOUNDS
// ===========================================================================

/** Runs read per evaluation for a period-scoped budget. Mirrors ROLLUP_MAX_RUNS_SAMPLE. */
export const BUDGET_MAX_RUNS_SCANNED = 5_000;

/**
 * Events read when RECONCILING one run's spend from the log.
 *
 * A run exceeding this CANNOT be reconciled, and that is reported as
 * `undetermined` rather than silently downgraded to the run counter and still
 * called exact. A truncated read cannot construct `logReadComplete: true` — the
 * contract makes the illegal state unspellable rather than merely discouraged.
 */
export const BUDGET_MAX_EVENTS_RECONCILED = 20_000;

/** A limit of 0 is breached by an empty window. See PART 5. */
export const BUDGET_MIN_LIMIT_AMOUNT = 1;

/**
 * Server-stated shelf life, taken from the CONTRACT rather than chosen here.
 *
 * The contract caps what a client may honour at `MAX_BREAKER_ANSWER_FRESHNESS_MS`
 * regardless of what the server says, so a server that states a longer one is
 * silently overruled and has no idea how stale its answers are in the field. An
 * earlier draft of this module picked 5 minutes independently and was clamped.
 * Deriving it from the contract is what stops the two crossing again — and
 * {@link breakerCadenceInvariant} makes the relationship to the sweep cadence a
 * test failure rather than a production sawtooth of declines.
 */
export const BUDGET_SNAPSHOT_SHELF_LIFE_MS = MAX_BREAKER_ANSWER_FRESHNESS_MS;

export const MAX_BUDGET_NAME_LENGTH = 80;
export const MAX_BUDGET_NOTE_LENGTH = 1_024;
/** A subject governed by more budgets than the contract can list is a misconfiguration. */
export const MAX_BREAKERS_PER_ORG = MAX_BREAKER_STATES;

// ===========================================================================
// PART B — THE PROSE GUARD (PART 3)
// ===========================================================================

/**
 * Claims this system is not entitled to make, as word-boundary patterns.
 *
 * COMPLEMENTARY TO, NOT A DUPLICATE OF, the contract's
 * `FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS`: that list guards field NAMES on the
 * wire, this one guards the server's own generated SENTENCES.
 *
 * `blocked`/`prevented`/`enforced` sit alongside the obvious `stopped`/`halted`
 * because they are what a well-meaning contributor actually reaches for when
 * writing a breaker message — "spending blocked", "limit enforced" — and they
 * are exactly as false.
 */
export const FORBIDDEN_EXECUTION_CLAIMS: readonly RegExp[] = [
  /\bstopp?ed\b/i,
  /\bhalt(ed|s|ing)?\b/i,
  /\bkill(ed|s|ing)?\b/i,
  /\bterminat(ed|es|ing)\b/i,
  /\bblock(ed|s|ing)\b/i,
  /\bprevent(ed|s|ing)\b/i,
  /\bshut down\b/i,
  /\benforc(ed|es|ing)\b/i,
  /\bpaused the\b/i,
  /\bsuspended the agent\b/i,
];

/** The first forbidden claim in `text`, or null. Returns the OFFENDING SUBSTRING so a failure names it. */
export function executionClaimIn(text: string): string | null {
  for (const pattern of FORBIDDEN_EXECUTION_CLAIMS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

/** Assert a SYSTEM-GENERATED sentence claims nothing about agent execution. Operator text never passes here. */
export function assertNoExecutionClaim(text: string, where: string): string {
  const offending = executionClaimIn(text);
  if (offending !== null) {
    throw new Error(
      `budget vocabulary violation in ${where}: "${offending}" claims something about agent ` +
        `execution, which this product records but does not perform. State the breaker's state, ` +
        `not the agent's. See convex/helpers/budget.ts PART 3.`,
    );
  }
  return text;
}

// ===========================================================================
// PART C — WINDOWS (PART 4)
// ===========================================================================

/**
 * Is this a usable epoch instant?
 *
 * EXPLICIT, because the alternatives both fail badly: `new Date(NaN)
 * .toISOString()` throws from the middle of an evaluation and wedges the
 * breaker, while a silently-NaN window compares false against everything and
 * reads as no spend — the arm direction. This is the guard `dayBoundsUtc` lacks.
 */
export function isUsableInstant(t: unknown): t is number {
  return typeof t === "number" && Number.isFinite(t) && t > 0;
}

/**
 * Start of the UTC hour / day / month containing `now`.
 *
 * TAKES A NUMBER, NEVER A DATE STRING. Every defect in `rollups.ts`'s
 * `dayBoundsUtc` enters through string parsing — `Date.parse("2024-02-30")`
 * yields a valid instant for a day that does not exist, and a full ISO timestamp
 * where `"YYYY-MM-DD"` was expected yields NaN. Working in epoch milliseconds
 * with UTC field accessors makes both unreachable: there is no string to
 * misparse and no impossible date to normalise.
 */
export function startOfUtcPeriod(now: number, period: "hour" | "day" | "month"): number {
  const d = new Date(now);
  switch (period) {
    case "hour":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case "day":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

export interface BudgetWindow {
  startAt: number;
  endAt: number;
  /**
   * Whether the FLOOR moved `startAt` later than the period alone would, from
   * either cause: the breaker is younger than its period (a new budget must not
   * retroactively trip on spend that predates the decision to have one), or an
   * operator reset it. Surfaced because "your daily budget shows four hours of
   * spend at 20:00" is confusing until you know the window did not start at
   * midnight.
   */
  truncatedByFloor: boolean;
}

/**
 * The half-open accounting window `[startAt, endAt)` for a budget at `now`.
 *
 * `period: "run"` has NO time window — a run-scoped budget is bounded by the run
 * itself — and is handled by the reconciled path in convex/budgets.ts instead.
 *
 * A RESET ADVANCES THE START FOR EVERY PERIOD. Without it, resetting a breaker
 * whose window still contains the breaching spend re-trips it on the very next
 * evaluation, and "reset" is a button that appears broken — from which an
 * operator would reasonably conclude the original trip was spurious. Reset
 * therefore MEANS "begin a new accounting period at this instant", and is
 * audited as such.
 */
export function resolveBudgetWindow(
  cfg: { period: Exclude<BudgetPeriod, "run">; createdAt: number; resetAt?: number },
  now: number,
): BudgetWindow {
  const start = cfg.period === "lifetime" ? cfg.createdAt : startOfUtcPeriod(now, cfg.period);
  const floor = cfg.resetAt ?? cfg.createdAt;
  return {
    startAt: Math.max(start, floor),
    endAt: now,
    truncatedByFloor: floor > start,
  };
}

// ===========================================================================
// PART D — THE OBSERVATION AND ITS COMPLETENESS
// ===========================================================================

/** What one bounded, org-scoped scan of `runs` saw. Produced by convex/budgets.ts. */
export interface SpendObservation {
  windowStartAt: number;
  windowEndAt: number;
  recordedTokensIn: number;
  recordedTokensOut: number;
  runsCounted: number;
  /**
   * Runs read carrying NEITHER `tokensIn` NOR `tokensOut`. Not runs that spent
   * nothing — runs whose spend was never recorded. Reported so nobody reads a
   * thin sum as a small bill.
   */
  runsWithNoRecordedTokens: number;
  /** Counted runs still pending/running: their contribution is rising after this read. */
  runsInFlight: number;
  /** POSITIVE observation that the scan read past the end of its range. See PART 5. */
  reachedEndOfRange: boolean;
  /** Rows read whose orgId did not match. Non-zero means the sum does not account for all it saw. */
  crossOrgRowsSkipped: number;
  observedAt: number;
}

/**
 * MAY THIS SUM BE PRESENTED AS A COMPLETE COUNT OF RECORDED SPEND?
 *
 * POSITIVE CLAUSES, none redundant:
 *
 *   both instants usable          Guards NaN/zero bounds, which compare false
 *                                 against everything and read as no spend.
 *   `windowEndAt > windowStartAt` A window PERIOD exists.
 *   `reachedEndOfRange === true`  The scan SAW the end of its range. The scanner
 *                                 over-fetches by one and checks, so this cannot
 *                                 be true by default.
 *   `crossOrgRowsSkipped === 0`   Everything read was accounted for.
 *
 * `runsCounted` is deliberately NOT gated — the same call helpers/fleet.ts's
 * `isBaselineEstablished` makes about `baselineOccurrencesExamined`. ZERO RUNS
 * READ TO THE END OF THE RANGE IS THE STRONGEST POSSIBLE OBSERVATION, not a
 * missing one: nothing ran, so nothing was recorded as spent. Requiring
 * `runsCounted > 0` would hold a quiet window permanently undetermined.
 */
export function isSpendSumComplete(o: SpendObservation): boolean {
  return (
    isUsableInstant(o.windowStartAt) &&
    isUsableInstant(o.windowEndAt) &&
    o.windowEndAt > o.windowStartAt &&
    o.reachedEndOfRange === true &&
    o.crossOrgRowsSkipped === 0
  );
}

/**
 * IS THE STORED EVALUATION STILL AN ANSWER, OR IS IT A MEMORY?
 *
 * TWO POSITIVE CLAUSES:
 *   an evaluation HAPPENED   A never-evaluated breaker has measured nothing;
 *                            treating its default as fresh would let a brand-new
 *                            budget answer on the strength of no observation.
 *   `now >= evaluatedAt`     The stamp is in the PAST. Without it a future-dated
 *                            stamp — clock skew, a bad backfill — yields a
 *                            negative age satisfying any bound FOREVER.
 */
export function isEvaluationFresh(
  evaluatedAt: number | undefined,
  now: number,
  shelfLifeMs: number,
): boolean {
  if (!isUsableInstant(evaluatedAt)) return false;
  if (!isUsableInstant(now)) return false;
  if (now < evaluatedAt) return false;
  return now - evaluatedAt <= shelfLifeMs;
}

// ===========================================================================
// PART E — SPEND FIGURES
// ===========================================================================

/**
 * Amount in the meter's own unit, or `null` when this backend will not sign a
 * figure for that meter.
 *
 * `cost_minor_units` -> null: PART 2(b). The pricing table substring-matches and
 *   over-prices in the halt direction; there is no honest cost figure to emit.
 * `events_ingested`  -> null: PART 2(a). The only source is the sampled
 *   `usage_counters`, whose spread is ~1000x.
 *
 * BOTH REFUSE RATHER THAN SUBSTITUTE. Returning a nearby number for a meter we
 * cannot measure is exactly how a soft number acquires a hard limit.
 */
export function meterAmount(o: SpendObservation, meter: BudgetMeter): number | null {
  switch (meter) {
    case "tokens_in":
      return o.recordedTokensIn;
    case "tokens_out":
      return o.recordedTokensOut;
    case "runs_started":
      return o.runsCounted;
    case "cost_minor_units":
    case "events_ingested":
      return null;
  }
}

/** Why a meter was refused, as operator-facing prose. Paired with {@link meterAmount} returning null. */
export function meterRefusalReason(meter: BudgetMeter): {
  because: string;
  wouldBeDeterminedBy: string;
} {
  if (meter === "cost_minor_units") {
    return {
      because:
        "This backend will not produce a cost figure. Cost would have to come from the snapshot pricing table, whose model matcher compares by bidirectional substring: an unknown model resolves to whichever table key it shares a substring with, ties break on key string length, and an unrecognised version suffix silently prices as an older, more expensive model. That mis-prices upward as readily as downward, and upward is the direction that reaches a limit.",
      wouldBeDeterminedBy:
        "Denominate this budget in tokens_in or tokens_out, which are counted rather than priced. A cost budget needs exact model matching with explicit aliases, or reconciliation against a billed invoice — neither exists yet.",
    };
  }
  return {
    because:
      "This backend will not produce an events_ingested figure. The only stored source is the sampled usage counter, which flushes single-unit increments about one time in ten and multiplies by ten when it does, so the same workload reports numbers spanning roughly three orders of magnitude depending only on which increments happened to flush.",
    wouldBeDeterminedBy:
      "Denominate this budget in tokens_in, tokens_out or runs_started, all of which are counted exactly from run records rather than sampled.",
  };
}

/**
 * THE APPROXIMATE FIGURE FOR THE RUN COUNTER — PART 2(c) in code.
 *
 * `couldOverstateBy: 0` IS THE LOAD-BEARING FIELD and it is a real claim, not a
 * convenience: the counter is an add-only, unscaled, unsampled sum over
 * idempotently-ingested events, so it CANNOT exceed what this system recorded.
 * That single zero is what makes `provably_at_or_over` reachable and therefore
 * what lets this breaker trip at all.
 *
 * `couldUnderstateBy: null` IS UNBOUNDED AND MUST NEVER BECOME 0. Zero would be
 * the claim that the figure cannot be low, certifying headroom from a counter
 * that cannot see an uninstrumented agent at all. `null` makes `provably_under`
 * unreachable, so this breaker never arms — the honest reading, produced by the
 * contract's arithmetic unaided.
 */
export function approximateFigureFromCounter(
  o: SpendObservation,
  amount: number,
  budgetId: string,
): ApproximateSpend {
  const coverage =
    o.runsCounted > 0
      ? `${o.runsWithNoRecordedTokens} of ${o.runsCounted} run(s) in this window recorded no token usage at all`
      : "no runs started in this window";
  return {
    basis: "approximate",
    kind: "denormalised_run_counter",
    estimatedAmount: amount,
    couldOverstateBy: 0,
    couldUnderstateBy: null,
    approximateBecause: assertNoExecutionClaim(
      `Summed from runs.tokensIn/tokensOut, an add-only unscaled counter written at event-insert time. The sum itself is exact and cannot be high, but it counts only spend this product RECORDED: an uninstrumented agent, or an llm.response payload shape the extractor did not recognise, contributes zero and nothing stored bounds how much that is. Spend is attributed in whole to the period a run STARTED in. ${coverage}.${o.runsInFlight > 0 ? ` ${o.runsInFlight} run(s) are still in flight, so this total is still rising.` : ""}`,
      "approximateFigureFromCounter",
    ),
    wouldBeReconciledBy:
      "Sum llm.response events for these runs directly from the append-only event log, which this backend does for run-scoped budgets. Reconciliation makes the count exact over the LOG; spend that was never recorded is not recoverable from stored data by any means.",
    forBudgetId: budgetId,
    sampledAt: o.observedAt,
  };
}

/**
 * THE RECONCILED FIGURE — PART 2(d). Constructible ONLY from a complete read of
 * one run's events.
 *
 * `logReadComplete` is the literal type `true` in the contract, so a caller
 * holding a truncated read CANNOT build this object: a compile error, not a
 * convention. That is why convex/budgets.ts reports `undetermined` for an
 * over-long run rather than falling back to the counter and still calling it
 * exact.
 */
export function reconciledFigureFromLog(input: {
  amount: number;
  budgetId: string;
  runsSummed: number;
  eventsSummed: number;
  reconciledThrough: number;
  reconciledAt: number;
}): ReconciledSpend {
  const proof: SpendReconciliation = {
    proves: "event_log_summed",
    budgetId: input.budgetId,
    runsSummed: input.runsSummed,
    eventsSummed: input.eventsSummed,
    logReadComplete: true,
    reconciledAt: input.reconciledAt,
  };
  return {
    basis: "reconciled",
    reconciledAmount: input.amount,
    reconciledThrough: input.reconciledThrough,
    forBudgetId: input.budgetId,
    establishedBy: [proof],
  };
}

// ===========================================================================
// PART F — THE FOLD: FIGURE + LIMIT -> BreakerState
// ===========================================================================

/** An `undetermined` state, with both required prose fields guarded. */
export function undeterminedState(input: {
  limit: BudgetLimit;
  kind: BreakerStateUndetermined["kind"];
  because: string;
  wouldBeDeterminedBy: string;
}): BreakerStateUndetermined {
  return {
    state: "undetermined",
    undeterminedBudgetId: input.limit.budgetId,
    undeterminedLimit: input.limit,
    kind: input.kind,
    undeterminedBecause: assertNoExecutionClaim(input.because, "undeterminedState/because"),
    wouldBeDeterminedBy: assertNoExecutionClaim(
      input.wouldBeDeterminedBy,
      "undeterminedState/wouldBeDeterminedBy",
    ),
  };
}

export interface BreakerFoldInput {
  limit: BudgetLimit;
  figure: SpendFigure;
  /** A trip already recorded on this breaker. A trip PERSISTS until reset. */
  existingTrip?: { trippedAt: number; trippedBy: BreakerTripCause; because: string };
  /** Re-arm on a period roll rather than only on an operator reset. */
  rearmOnPeriodRoll: boolean;
  windowStartAt: number;
  now: number;
}

export interface BreakerFoldResult {
  state: BreakerState;
  /** True only on a transition INTO tripped, so the caller knows to audit. */
  transitionedToTripped: boolean;
  /** True only on a period-roll re-arm out of a trip. */
  transitionedOutOfTrip: boolean;
}

/**
 * Decide one breaker's state.
 *
 * THE ORDER OF THESE BRANCHES IS THE SAFETY PROPERTY, exactly as it is in
 * helpers/fleet.ts's `deriveAgentHealthState`:
 *
 *   1. UNUSABLE FIGURE FIRST. A malformed figure is not a low one. Checked
 *      before any comparison so no arithmetic runs on it — the contract's
 *      `spendUsability` exists because `NaN >= limit` is `false` and silently
 *      takes the permissive branch.
 *   2. PROVEN BREACH. `compareSpendToLimit` is THE comparison rule; this module
 *      never writes `>=` against a limit. For the run counter it is reachable
 *      only because `couldOverstateBy` is 0.
 *   3. RE-ARM, only from an existing trip, only on opt-in, and only on a
 *      POSITIVE comparison against the CURRENT window.
 *   4. A TRIP PERSISTS. Falling through to `armed` here is how a trip silently
 *      evaporates.
 *   5. PROVEN HEADROOM -> armed. Requires `provably_under`, which an unbounded
 *      figure can never produce.
 *   6. `undetermined` is the FALLTHROUGH. Every path that did not positively
 *      establish something lands here, including any state a future contributor
 *      adds without thinking about this function.
 */
export function foldBreakerState(input: BreakerFoldInput): BreakerFoldResult {
  const { limit, figure } = input;

  // 1. UNUSABLE FIGURE.
  if (spendUsability(figure) === "unusable") {
    return {
      state: undeterminedState({
        limit,
        kind: "spend_unavailable",
        because: `The spend figure produced for this budget is not usable, so no comparison against the ${limit.limitAmount} ${limit.meter} limit was attempted. A malformed figure is not a low one.`,
        wouldBeDeterminedBy:
          "Re-run the evaluation. If it persists, the run records for this window are unreadable and must be inspected directly.",
      }),
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  const comparison = compareSpendToLimit(figure, limit);

  // 2. PROVEN BREACH.
  if (comparison === "provably_at_or_over") {
    const amount = figure.basis === "reconciled" ? figure.reconciledAmount : figure.estimatedAmount;
    const how =
      figure.basis === "reconciled"
        ? "summed from the append-only event log"
        : "counted from the add-only run counters, which cannot overstate";
    return {
      state: {
        state: "tripped",
        trippedBudgetId: limit.budgetId,
        trippedLimit: limit,
        trippedAt: input.existingTrip?.trippedAt ?? input.now,
        trippedBy: input.existingTrip?.trippedBy ?? "limit_reached",
        trippedBecause: assertNoExecutionClaim(
          `Recorded spend of ${amount} ${limit.meter} reached the ${limit.limitAmount} ${limit.meter} limit for ${limit.scope} ${limit.scopeId}, ${how}. This states the breaker's state and the recorded total; it says nothing about what any agent did.`,
          "foldBreakerState/tripped",
        ),
        determinedFrom: [figure],
      },
      transitionedToTripped: input.existingTrip === undefined,
      transitionedOutOfTrip: false,
    };
  }

  // 3. RE-ARM on a period roll — positive comparison against the current window.
  const trip = input.existingTrip;
  if (
    trip !== undefined &&
    input.rearmOnPeriodRoll &&
    isUsableInstant(trip.trippedAt) &&
    trip.trippedAt < input.windowStartAt &&
    comparison === "provably_under"
  ) {
    return {
      state: {
        state: "armed",
        armedBudgetId: limit.budgetId,
        armedLimit: limit,
        establishedUnderBy: [figure],
        establishedAt: input.now,
      },
      transitionedToTripped: false,
      transitionedOutOfTrip: true,
    };
  }

  // 4. A TRIP PERSISTS.
  if (trip !== undefined) {
    return {
      state: {
        state: "tripped",
        trippedBudgetId: limit.budgetId,
        trippedLimit: limit,
        trippedAt: trip.trippedAt,
        trippedBy: trip.trippedBy,
        trippedBecause: assertNoExecutionClaim(trip.because, "foldBreakerState/persisted"),
        determinedFrom: [figure],
      },
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  // 5. PROVEN HEADROOM.
  if (comparison === "provably_under") {
    return {
      state: {
        state: "armed",
        armedBudgetId: limit.budgetId,
        armedLimit: limit,
        establishedUnderBy: [figure],
        establishedAt: input.now,
      },
      transitionedToTripped: false,
      transitionedOutOfTrip: false,
    };
  }

  // 6. FALLTHROUGH: undetermined. THE COMMON CASE for a counter-backed budget,
  //    and the honest one — see PART 2(c).
  return {
    state: undeterminedState({
      limit,
      kind: "spend_not_decidable",
      because:
        figure.basis === "approximate"
          ? `Recorded spend for this budget is ${figure.estimatedAmount} ${limit.meter} against a ${limit.limitAmount} ${limit.meter} limit, from the add-only run counters. That figure cannot overstate, so it can establish a breach — but it counts only recorded spend and nothing bounds how much went unrecorded, so it can never establish headroom. Below the limit this breaker is undetermined, not armed.`
          : `The spend figure for this budget straddles the ${limit.limitAmount} ${limit.meter} limit given its own stated error bounds, so neither a breach nor headroom is established.`,
      wouldBeDeterminedBy:
        limit.scope === "run"
          ? "Reduce this run's event count below the reconciliation ceiling so its spend can be summed from the event log."
          : "Use a run-scoped budget, whose spend is reconciled from the append-only event log and can establish headroom as well as breach; or raise the limit above the range the recorded total can reach.",
    }),
    transitionedToTripped: false,
    transitionedOutOfTrip: false,
  };
}

// ===========================================================================
// PART G — THE SNAPSHOT
// ===========================================================================

/**
 * A snapshot plus the shelf life expressed as a DURATION.
 *
 * X2 — WHY BOTH, AND WHY THE DURATION IS THE HONEST ONE.
 *
 * `freshUntil` is an ABSOLUTE INSTANT the server picks, and the contract
 * requires it. But the clock on it starts when the SERVER builds the snapshot,
 * not when the CLIENT receives it, so every millisecond of serialization,
 * network and queueing is silently deducted from the very margin
 * `CADENCE * MULTIPLE` exists to guarantee. The two errors compound in the same
 * direction and both grow under load: exactly when transit is slowest, the
 * budget for absorbing a slow refresh is smallest. At fleet scale that shortens
 * every client's hold at once and turns into a synchronised refresh storm — the
 * halt-shaped failure, arriving through the field that was supposed to prevent
 * it.
 *
 * `shelfLifeMs` is the same value expressed as a duration, which a client
 * anchors ON RECEIPT. Transit then costs nothing: the answer is good for the
 * stated duration from the moment it actually arrives. This is the same
 * anchoring correction Team B applied to the ceiling.
 *
 * IT IS ADDITIVE AND THE CONTRACT'S `BreakerSnapshot` IS UNCHANGED, so nothing
 * consuming `freshUntil` breaks and `snapshotUnusableFields` still passes (it
 * sweeps keys for forbidden claims but does not reject unknown fields).
 * A CLIENT MUST STILL CLAMP: `shelfLifeMs` is a server judgement, and an
 * unbounded one would be a bypass exactly as an unbounded `freshUntil` is —
 * `MAX_BREAKER_ANSWER_FRESHNESS_MS` remains the ceiling either way.
 *
 * THE HALF THIS BOUNDARY CANNOT FINISH: the SDK reads `freshUntil` today, so
 * until it (and ideally the contract's snapshot type) adopt `shelfLifeMs`, the
 * transit deduction is merely VISIBLE rather than fixed. That handover is
 * reported rather than assumed.
 */
export interface BreakerSnapshotEnvelope extends BreakerSnapshot {
  /** Shelf life as a DURATION, to be anchored on RECEIPT. See this type's header. */
  shelfLifeMs: number;
}

/**
 * Assemble the wire answer.
 *
 * `freshUntil` is STRICTLY after `evaluatedAt` — the contract calls a snapshot
 * born stale malformed rather than cautious — and equals the contract's own
 * client-side ceiling, so the server's stated shelf life and the client's
 * honoured one agree exactly.
 */
export function buildSnapshot(input: {
  states: BreakerState[];
  subject: BudgetSubject;
  budgetsInScope: number;
  budgetsEvaluated: number;
  evaluationTruncated: boolean;
  now: number;
}): BreakerSnapshotEnvelope {
  return {
    evaluatedAt: input.now,
    freshUntil: input.now + BUDGET_SNAPSHOT_SHELF_LIFE_MS,
    // The receipt-anchorable form of the same shelf life. See
    // BreakerSnapshotEnvelope: `freshUntil` loses transit time, this does not.
    shelfLifeMs: BUDGET_SNAPSHOT_SHELF_LIFE_MS,
    states: input.states.slice(0, MAX_BREAKER_STATES),
    scan: {
      subject: input.subject,
      budgetsInScope: input.budgetsInScope,
      budgetsEvaluated: input.budgetsEvaluated,
      evaluationTruncated: input.evaluationTruncated,
    },
  };
}
