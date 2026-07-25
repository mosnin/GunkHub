/**
 * NO COMPLIANCE CLAIM IS RENDERABLE FROM A FLOOR.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM UNDER TEST
 * ---------------------------------------------------------------------------
 *
 * The spend figures this product can produce at any scope wider than a single
 * run are FLOORS: `runs.tokensIn`/`tokensOut` are add-only, unscaled, unsampled
 * and idempotent, so the sum itself has ZERO error — only its coverage is
 * short, and unboundedly so. Typed as `couldOverstateBy: 0` (it cannot be high)
 * and `couldUnderstateBy: null` (unbounded, and NOT zero).
 *
 * The consequence is asymmetric and absolute: SUCH A FIGURE CAN PROVE A BREACH
 * AND CAN NEVER PROVE COMPLIANCE. `provably_at_or_over` is reachable;
 * `provably_under` is not, at any distance below the limit.
 *
 * A progress bar contradicts that in visual form. A bar filling toward a limit
 * asserts a denominator — "you are this far along and the remainder is yours" —
 * and there is no remainder to draw, because the true position could be
 * anywhere between the drawn mark and past the end. It is also the single most
 * natural component to reach for on this screen, which is why it gets a test
 * rather than a comment.
 *
 * THREE LAYERS ARE CHECKED, because any one of them alone is bypassable:
 *   1. THE ARITHMETIC — the figure genuinely cannot establish headroom.
 *   2. THE CLASSIFICATION — the UI's own model says so before any data arrives.
 *   3. THE MARKUP — no budget component contains a meter, a bar, or a
 *      percentage-of-limit computation.
 */
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

import {
  BUDGET_METERS,
  BUDGET_SCOPES,
  compareSpendToLimit,
  type ApproximateSpend,
  type BudgetLimit,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


import { budgetEvaluability } from '@/lib/budgets/evaluability'

const WEB_ROOT = path.resolve(__dirname, '../../apps/web')

/** Every source file that renders any part of the budget feature. */
function budgetUiSources(): { file: string; text: string }[] {
  const dirs = [
    path.join(WEB_ROOT, 'src/components/budgets'),
    path.join(WEB_ROOT, 'src/lib/budgets'),
  ]
  const files: { file: string; text: string }[] = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
      files.push({ file: path.join(dir, name), text: readFileSync(path.join(dir, name), 'utf8') })
    }
  }
  files.push({
    file: path.join(WEB_ROOT, 'app/(app)/settings/budgets/page.tsx'),
    text: readFileSync(path.join(WEB_ROOT, 'app/(app)/settings/budgets/page.tsx'), 'utf8'),
  })
  return files
}

/**
 * The counter-backed figure the engine actually emits, at its most comfortable:
 * one unit of spend against a ten-thousand limit.
 */
function counterFigure(estimatedAmount: number, budgetId = 'budget_1'): ApproximateSpend {
  return {
    basis: 'approximate',
    kind: 'denormalised_run_counter',
    estimatedAmount,
    // IT CANNOT BE HIGH — the counters are add-only and unscaled.
    couldOverstateBy: 0,
    // IT CAN BE LOW BY AN UNBOUNDED AMOUNT — a run whose totals have not landed
    // contributes nothing. `null`, and never 0.
    couldUnderstateBy: null,
    approximateBecause:
      'Summed from denormalised run counters, which are add-only and unscaled but cover only runs whose totals ' +
      'have landed.',
    wouldBeReconciledBy: 'Sum llm.response events for this window from the event log.',
    forBudgetId: budgetId,
    sampledAt: 1_800_000_000_000,
  }
}

const LIMIT: BudgetLimit = {
  budgetId: 'budget_1',
  orgId: 'org_1',
  scope: 'agent',
  scopeId: 'agent_1',
  meter: 'tokens_out',
  period: 'day',
  limitAmount: 10_000,
  enabled: true,
  createdAt: 1_700_000_000_000,
}

describe('LAYER 1 — the arithmetic cannot establish headroom from a floor', () => {
  it('a counter-backed figure at 0.01% of its limit is STILL not provably under', () => {
    // The comfortable case, and the one an operator would most want a green bar
    // for. One token of a ten-thousand-token budget.
    expect(compareSpendToLimit(counterFigure(1), LIMIT)).toBe('not_decidable')
  })

  it('no amount below the limit makes it provably under', () => {
    for (const amount of [0, 1, 100, 5_000, 9_000, 9_999]) {
      expect(compareSpendToLimit(counterFigure(amount), LIMIT)).toBe('not_decidable')
    }
  })

  it('but a breach IS provable — the asymmetry is real, not a blanket refusal', () => {
    // `couldOverstateBy: 0` is a real claim and it is what makes this reachable.
    // A test that only asserted "never decides" would pass against a breaker
    // that had stopped working entirely.
    expect(compareSpendToLimit(counterFigure(10_000), LIMIT)).toBe('provably_at_or_over')
    expect(compareSpendToLimit(counterFigure(12_500), LIMIT)).toBe('provably_at_or_over')
  })

  it('`couldUnderstateBy: 0` would flip it — which is why null must never become 0', () => {
    // Stated as a test rather than a comment so the consequence of the field
    // regressing to 0 is visible in a failure message, not only in prose.
    const zeroBounded = { ...counterFigure(1), couldUnderstateBy: 0 }
    expect(compareSpendToLimit(zeroBounded, LIMIT)).toBe('provably_under')
  })
})

describe('LAYER 2 — the UI classifies wide scopes as unable to arm, before any data', () => {
  it('every non-run scope on a countable meter can trip and cannot arm', () => {
    for (const scope of BUDGET_SCOPES) {
      if (scope === 'run') continue
      for (const meter of ['tokens_in', 'tokens_out', 'runs_started'] as const) {
        const evaluability = budgetEvaluability(scope, meter)
        expect(evaluability.kind).toBe('counter_backed')
        expect(evaluability.canArm).toBe(false)
        expect(evaluability.canTrip).toBe(true)
      }
    }
  })

  it('run scope on a countable meter is the ONE configuration that can arm', () => {
    const evaluability = budgetEvaluability('run', 'tokens_out')
    expect(evaluability.kind).toBe('run_reconciled')
    expect(evaluability.canArm).toBe(true)
  })

  it('a refused meter can neither arm nor trip, at EVERY scope including run', () => {
    // Order matters: the meter is checked before the scope, so a run-scoped
    // cost budget must not be reported as the strongest kind there is.
    for (const scope of BUDGET_SCOPES) {
      for (const meter of ['cost_minor_units', 'events_ingested'] as const) {
        const evaluability = budgetEvaluability(scope, meter)
        expect(evaluability.kind).toBe('meter_refused')
        expect(evaluability.canArm).toBe(false)
        expect(evaluability.canTrip).toBe(false)
      }
    }
  })

  it('every meter is classified — a sixth one cannot default to measurable', () => {
    for (const meter of BUDGET_METERS) {
      expect(budgetEvaluability('agent', meter)).toBeDefined()
    }
  })

  it('the cost refusal names the real fix and does NOT propose more substring matching', () => {
    const { wouldBeImprovedBy, explanation } = budgetEvaluability('agent', 'cost_minor_units')
    expect(`${wouldBeImprovedBy} ${explanation}`.toLowerCase()).not.toMatch(/more substring|add substring/)
    expect(wouldBeImprovedBy.toLowerCase()).toMatch(/alias|invoice|token/)
  })
})

describe('LAYER 3 — no budget component can draw a bar toward a limit', () => {
  const sources = budgetUiSources()

  it('finds the budget UI sources it claims to be scanning', () => {
    // Without this, a renamed directory turns every assertion below into a
    // vacuous pass over an empty list.
    expect(sources.length).toBeGreaterThanOrEqual(5)
  })

  it('contains no progress/meter element or bar-width style', () => {
    const BAR_PATTERNS: [RegExp, string][] = [
      [/role\s*=\s*["']progressbar["']/, 'an ARIA progressbar'],
      [/<progress\b/, 'a <progress> element'],
      [/<meter\b/, 'a <meter> element'],
      [/style\s*=\s*\{\{[^}]*width/, 'an inline width style (the way a bar fill is drawn)'],
      [/\bw-\[\$\{/, 'a computed Tailwind width'],
    ]
    for (const { file, text } of sources) {
      for (const [pattern, description] of BAR_PATTERNS) {
        expect(pattern.test(text), `${path.basename(file)} contains ${description}`).toBe(false)
      }
    }
  })

  it('never divides a spend figure by a limit', () => {
    // The arithmetic a percentage needs. Contracts makes `spend.amount` not
    // compile, so any such computation has to name the narrowed field — which
    // is exactly what this catches.
    const RATIO = /(reconciledAmount|estimatedAmount|limitAmount)\s*\/\s*/
    for (const { file, text } of sources) {
      expect(RATIO.test(text), `${path.basename(file)} computes a ratio from a spend or limit amount`).toBe(false)
    }
  })

  it('never renders a percent sign next to a spend figure', () => {
    for (const { file, text } of sources) {
      expect(/toFixed\(\s*\d*\s*\)\s*\}?\s*%/.test(text), `${path.basename(file)} formats a percentage`).toBe(false)
    }
  })
})
