/**
 * Shared builders for the `budget_*` suites.
 *
 * Not a test file (no `.test.ts` suffix, so vitest does not collect it). It
 * exists because all four budget suites need a WELL-FORMED snapshot to mutate,
 * and a fixture each is how three of them end up proving something about a
 * shape the fourth does not have.
 *
 * Every builder returns a snapshot that PASSES the gate unless you break it.
 * That is the important property: a test that starts from a broken fixture
 * proves nothing when it observes a refusal.
 */
import type {
  ApproximateSpend,
  BreakerArmed,
  BreakerSnapshot,
  BreakerStateUndetermined,
  BreakerTripped,
  BudgetLimit,
  ReconciledSpend,
} from '@agent-flight-recorder/contracts'

export const NOW = 1_800_000_000_000

/**
 * A FIXED ARRIVAL INSTANT, distinct from {@link NOW}.
 *
 * Defaulting `receivedAt` to whatever `now` a case passed was not
 * meaning-preserving: the old ceiling reduced to `min(freshUntil, now + MAX)`,
 * which for any generous `freshUntil` is `freshUntil` unconditionally — so the
 * ceiling was INERT in every case that used the default, and a snapshot
 * claiming to be good until the heat death of the universe was honoured at any
 * clock. A defaulted parameter that changes what a case asserts is how a probe
 * goes quiet, and this one had.
 */
export const RECEIVED_AT = NOW - 500

/** A $100.00 per-day cap on agent_7, in minor units. */
export function limit(overrides: Partial<BudgetLimit> = {}): BudgetLimit {
  return {
    budgetId: 'budget_1',
    orgId: 'org_1',
    scope: 'agent',
    scopeId: 'agent_7',
    meter: 'cost_minor_units',
    period: 'day',
    limitAmount: 10_000,
    currency: 'USD',
    enabled: true,
    createdAt: NOW - 86_400_000,
    ...overrides,
  }
}

/** An EXACT figure, summed from the immutable event log. */
export function reconciled(amount: number, budgetId = 'budget_1'): ReconciledSpend {
  return {
    basis: 'reconciled',
    reconciledAmount: amount,
    reconciledThrough: NOW - 1_000,
    forBudgetId: budgetId,
    establishedBy: [
      {
        proves: 'event_log_summed',
        budgetId,
        runsSummed: 41,
        eventsSummed: 903,
        logReadComplete: true,
        reconciledAt: NOW - 1_000,
      },
    ],
  }
}

/**
 * An ADR-002 sampled figure. Bounds default to `null` — UNBOUNDED — because
 * that is what `usage_counters` can honestly say about itself, and because the
 * default a fixture hands out is the one most tests will exercise.
 */
export function approximate(
  amount: number,
  bounds: { under?: number | null; over?: number | null } = {},
  budgetId = 'budget_1'
): ApproximateSpend {
  return {
    basis: 'approximate',
    kind: 'sampled_usage_counter',
    estimatedAmount: amount,
    couldUnderstateBy: bounds.under ?? null,
    couldOverstateBy: bounds.over ?? null,
    approximateBecause:
      'ADR-002 usage_counters flushes single-unit increments ~1-in-10 and scales by 10x; the residual is not bounded.',
    wouldBeReconciledBy: 'sum llm.response events for this period from the event log',
    forBudgetId: budgetId,
    sampledAt: NOW - 2_000,
  }
}

export function armed(spendAmount = 1_000, l: BudgetLimit = limit()): BreakerArmed {
  return {
    state: 'armed',
    armedBudgetId: l.budgetId,
    armedLimit: l,
    establishedUnderBy: [reconciled(spendAmount, l.budgetId)],
    establishedAt: NOW - 1_000,
  }
}

export function tripped(spendAmount = 10_400, l: BudgetLimit = limit()): BreakerTripped {
  return {
    state: 'tripped',
    trippedBudgetId: l.budgetId,
    trippedLimit: l,
    trippedAt: NOW - 5_000,
    trippedBy: 'limit_reached',
    trippedBecause: `reconciled spend of ${spendAmount} reached the ${l.limitAmount} limit`,
    determinedFrom: [reconciled(spendAmount, l.budgetId)],
  }
}

export function undetermined(l: BudgetLimit = limit()): BreakerStateUndetermined {
  return {
    state: 'undetermined',
    undeterminedBudgetId: l.budgetId,
    undeterminedLimit: l,
    kind: 'spend_not_decidable',
    undeterminedBecause:
      'spend is estimated at 9,900 against a 10,000 limit, from a sampled counter with no stated error bound',
    wouldBeDeterminedBy: 'reconcile spend for this period from the event log',
  }
}

/** A snapshot that passes the gate. `states` defaults to one armed breaker. */
export function snapshot(overrides: Partial<BreakerSnapshot> = {}): BreakerSnapshot {
  const states = overrides.states ?? [armed()]
  return {
    evaluatedAt: NOW - 1_000,
    freshUntil: NOW + 10_000,
    // Stated explicitly, matching what a current deployment sends. A DURATION
    // means the same thing whenever it arrives; an absolute instant silently
    // spends the cadence margin on network transit.
    shelfLifeMs: 11_000,
    states,
    scan: {
      subject: { agentId: 'agent_7' },
      budgetsInScope: states.length,
      budgetsEvaluated: states.length,
      evaluationTruncated: false,
    },
    ...overrides,
  }
}

/** A snapshot for a subject no budget governs. Complete, legal, and NOT headroom. */
export function unbudgetedSnapshot(): BreakerSnapshot {
  return {
    evaluatedAt: NOW - 1_000,
    freshUntil: NOW + 10_000,
    shelfLifeMs: 11_000,
    states: [],
    scan: { subject: { agentId: 'agent_7' }, budgetsInScope: 0, budgetsEvaluated: 0, evaluationTruncated: false },
  }
}
