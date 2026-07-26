/**
 * WHAT A BUDGET CAN ESTABLISH, BEFORE IT HAS ESTABLISHED ANYTHING.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * A breaker's state (`armed` / `tripped` / `undetermined`) is computed by the
 * backend at query time and arrives on a `BreakerSnapshot`. This module is
 * about a DIFFERENT question, asked one layer earlier and answerable from the
 * budget's own configuration:
 *
 *   GIVEN HOW THIS BUDGET IS DENOMINATED AND SCOPED, WHICH STATES CAN IT EVER
 *   REACH?
 *
 * The answer is not "all three", it is not uniform, and every asymmetry in it
 * points the same way — TOWARD BEING ABLE TO PROVE A BREACH AND NEVER BEING
 * ABLE TO PROVE COMPLIANCE. An operator who configures a cost budget and then
 * watches it sit quietly at `undetermined` forever will conclude the feature is
 * broken, or worse, will conclude the silence means everything is fine. Both
 * readings are available only because nothing told them at configuration time.
 *
 * So the classification is stated UP FRONT, on the create form and on every
 * row, rather than being inferable from an absence.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CLASSES, AND WHERE EACH ONE COMES FROM
 * ---------------------------------------------------------------------------
 *
 *   METER REFUSED       `cost_minor_units` and `events_ingested`. The backend
 *                       will not sign a figure for either, so EVERY evaluation
 *                       returns `undetermined` / `budget_unreadable`. Such a
 *                       budget can never arm and can never trip. It is a
 *                       configured intention with no enforcement behind it.
 *                       Source: convex/helpers/budget.ts `meterAmount` returns
 *                       `null` for both, and `meterRefusalReason` states why.
 *
 *   COUNTER-BACKED      Any non-`run` scope on a countable meter. Spend is the
 *                       sum of `runs.tokensIn`/`tokensOut`, which are add-only,
 *                       unscaled and idempotent — so THE SUM ITSELF HAS ZERO
 *                       ERROR AND ONLY ITS COVERAGE IS SHORT. Typed as
 *                       `couldOverstateBy: 0, couldUnderstateBy: null`, which
 *                       makes `provably_at_or_over` REACHABLE and
 *                       `provably_under` UNREACHABLE (contracts,
 *                       `compareSpendToLimit`). CAN TRIP; CAN NEVER ARM.
 *                       Below the limit it reads `undetermined`, and that is
 *                       arithmetic, not a special case.
 *
 *   RUN-RECONCILED      `scope: "run"` on a countable meter. Spend is summed
 *                       from the append-only event log with
 *                       `logReadComplete: true` — a LITERAL type a truncated
 *                       read cannot construct. This is the one place a breaker
 *                       can genuinely arm, because it is the one place a figure
 *                       can be exact. Over the reconciliation ceiling it
 *                       reports `undetermined` rather than falling back to the
 *                       counter and still calling itself exact.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING NOTHING IN HERE SAYS
 * ---------------------------------------------------------------------------
 *
 * No string below claims an agent halted, that spend was prevented, or that a
 * limit was enforced. `canTrip` is a statement about THE BREAKER; nothing here
 * is a statement about a process this system does not control. See
 * `packages/contracts/src/budgets.ts` invariant 1, and
 * `tests/unit/budget_ui_no_execution_claim.test.ts`, which greps this file and
 * every budget component for the forbidden vocabulary.
 */
import type { BudgetMeter, BudgetPeriod, BudgetScope } from '@agent-flight-recorder/contracts'

/** Which of the three evaluation paths a budget's configuration puts it on. */
export type BudgetEvaluabilityKind =
  /** The backend refuses to produce a figure for this meter at all. Never arms, never trips. */
  | 'meter_refused'
  /** Counted from run records. Can trip; can never arm. */
  | 'counter_backed'
  /** Reconciled from the event log. The one path that can arm. */
  | 'run_reconciled'

export interface BudgetEvaluability {
  kind: BudgetEvaluabilityKind
  /**
   * Can this budget's breaker ever reach `armed` — i.e. can it ever ESTABLISH
   * headroom? False for two of the three classes, and the falseness is the
   * whole point of this module.
   */
  canArm: boolean
  /** Can this budget's breaker ever reach `tripped` by arithmetic (a manual trip is always possible)? */
  canTrip: boolean
  /** Six words or fewer, for a row. Never a claim about an agent. */
  headline: string
  /** The sentence an operator needs, in full, at configuration time. */
  explanation: string
  /** What would move this budget onto a stronger footing, as an action. Never "add more substrings". */
  wouldBeImprovedBy: string
}

/**
 * Whether the backend will produce a spend figure for a meter at all.
 *
 * A TOTAL `Record`, so a sixth meter added to the contract is a COMPILE ERROR
 * here until somebody decides whether this product can measure it. The
 * permissive default — treating an unrecognised meter as countable — is exactly
 * how a budget denominated in something nobody measures would come to render as
 * enforcement.
 */
export const METER_IS_MEASURED: Record<BudgetMeter, boolean> = {
  tokens_in: true,
  tokens_out: true,
  runs_started: true,
  // Refused: the pricing table matches models by bidirectional substring and
  // mis-prices UPWARD as readily as downward — the direction that reaches a
  // limit. There is no honest cost figure to emit, so none is emitted.
  cost_minor_units: false,
  // Refused: the only stored source is the sampled usage counter, whose spread
  // is roughly three orders of magnitude on identical workloads.
  events_ingested: false,
}

/** Display label for a meter. Mono-rendered at the call site; this is just the string. */
export const METER_LABEL: Record<BudgetMeter, string> = {
  cost_minor_units: 'cost (minor units)',
  tokens_in: 'input tokens',
  tokens_out: 'output tokens',
  runs_started: 'runs started',
  events_ingested: 'events ingested',
}

/** Display label for a period. */
export const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  run: 'per run',
  hour: 'per hour',
  day: 'per day',
  month: 'per month',
  lifetime: 'lifetime',
}

/** Display label for a scope. */
export const SCOPE_LABEL: Record<BudgetScope, string> = {
  org: 'organization',
  project: 'project',
  agent: 'agent',
  agent_version: 'agent version',
  run: 'run',
}

const REFUSED_COST: Omit<BudgetEvaluability, 'kind' | 'canArm' | 'canTrip'> = {
  headline: 'Not evaluable — cost is not measured',
  explanation:
    'This backend will not produce a cost figure, so a budget denominated in cost is never evaluated: every ' +
    'reading of it reports that its state could not be established, and it can neither establish headroom nor ' +
    'reach its limit. Cost would have to come from a pricing table whose model matcher compares by substring, ' +
    'which mis-prices upward as readily as downward — and upward is the direction that reaches a limit.',
  wouldBeImprovedBy:
    'Denominate this budget in input or output tokens, which are counted rather than priced. A cost budget needs ' +
    'exact model matching with explicit aliases, or reconciliation against a billed invoice; neither exists yet.',
}

const REFUSED_EVENTS: Omit<BudgetEvaluability, 'kind' | 'canArm' | 'canTrip'> = {
  headline: 'Not evaluable — events are sampled',
  explanation:
    'This backend will not produce an events-ingested figure, so this budget is never evaluated: every reading of ' +
    'it reports that its state could not be established. The only stored source is a sampled counter that flushes ' +
    'single-unit increments about one time in ten and multiplies by ten when it does, so identical workloads ' +
    'report totals spanning roughly three orders of magnitude.',
  wouldBeImprovedBy:
    'Denominate this budget in input tokens, output tokens, or runs started — all three are counted directly on ' +
    'the run record rather than sampled.',
}

const COUNTER_BACKED: Omit<BudgetEvaluability, 'kind' | 'canArm' | 'canTrip'> = {
  headline: 'Can reach its limit; cannot establish headroom',
  explanation:
    'Spend for this budget is summed from run records. Those counters are add-only and unscaled, so the sum is ' +
    'never too high — but it can be short by an amount nobody has bounded, because a run whose totals have not ' +
    'landed yet contributes nothing. That asymmetry is decisive: the figure can prove the limit has been reached ' +
    'and can never prove it has not. While the total sits below the limit this breaker reports that its state ' +
    'could not be established — which is not the same as, and must not be read as, having room.',
  wouldBeImprovedBy:
    'Scope a budget to a single run to get a figure reconciled from the event log, which is exact and can ' +
    'establish headroom. At wider scopes, treat a reached limit as the signal and the quiet as an absence of ' +
    'information.',
}

const RUN_RECONCILED: Omit<BudgetEvaluability, 'kind' | 'canArm' | 'canTrip'> = {
  headline: 'Reconciled from the event log — exact',
  explanation:
    'Spend for this budget is summed event by event from the append-only log, and the sum is exact as of the ' +
    "moment it was taken. This is the only configuration whose breaker can establish headroom, because it is the " +
    'only one whose figure is a measurement rather than a floor. If the run exceeds the reconciliation ceiling ' +
    'the breaker reports that its state could not be established rather than falling back to a counted total and ' +
    'still calling it exact.',
  wouldBeImprovedBy:
    'Nothing — this is the strongest footing available. Note it answers a narrower question than a project- or ' +
    'agent-scoped budget: one run, not a workload.',
}

/**
 * Which evaluation path a budget's configuration puts it on.
 *
 * THE METER IS CHECKED FIRST, and the order is load-bearing: a run-scoped cost
 * budget is refused for its meter, not reconciled for its scope. Reporting it
 * as the exact path because of how it is scoped would describe a budget that is
 * never evaluated as the strongest kind there is.
 *
 * @param scope - the budget's scope.
 * @param meter - what the budget counts.
 * @returns the class, with the prose an operator needs. Never throws.
 */
export function budgetEvaluability(scope: BudgetScope, meter: BudgetMeter): BudgetEvaluability {
  if (!METER_IS_MEASURED[meter]) {
    const body = meter === 'cost_minor_units' ? REFUSED_COST : REFUSED_EVENTS
    return { kind: 'meter_refused', canArm: false, canTrip: false, ...body }
  }
  if (scope === 'run') {
    return { kind: 'run_reconciled', canArm: true, canTrip: true, ...RUN_RECONCILED }
  }
  return { kind: 'counter_backed', canArm: false, canTrip: true, ...COUNTER_BACKED }
}
