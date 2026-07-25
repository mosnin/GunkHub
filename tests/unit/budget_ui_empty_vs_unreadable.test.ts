/**
 * "NO BUDGETS CONFIGURED" AND "WE COULD NOT READ YOUR BUDGETS" NEVER LOOK ALIKE.
 *
 * ---------------------------------------------------------------------------
 * THE AMBIGUITY, AND WHICH DIRECTION IT IS DANGEROUS IN
 * ---------------------------------------------------------------------------
 *
 * Three completely different situations produce a page with no breaker rows on
 * it:
 *
 *   1. A trustworthy answer whose count is zero — nothing governs spend here.
 *   2. A body that arrived and cannot be enforced on.
 *   3. A query that failed outright.
 *
 * Collapsed, they all read as a quiet screen, and A QUIET SCREEN ON THIS
 * FEATURE READS AS REASSURANCE. That is the wrong direction for every one of
 * them: (1) means there is no cost control at all — which is also what a
 * deleted or mis-scoped budget looks like — and (2) and (3) mean we do not know
 * whether there is.
 *
 * So the read layer returns a DISCRIMINATED UNION rather than a nullable
 * snapshot, and the page holds `BudgetRecord[] | null` rather than defaulting
 * to `[]`. This file pins both, and pins the source against the two edits that
 * would quietly re-merge them: a `?? []` on the list read, and a `catch`
 * returning an empty snapshot.
 */
import { readFileSync } from 'fs'
import path from 'path'

import { describe, expect, it } from 'vitest'

import { armed, snapshot, unbudgetedSnapshot } from './budget_fixtures'

import { readBreakerSnapshot } from '@/lib/services/budgets'


const WEB_ROOT = path.resolve(__dirname, '../../apps/web')

describe('readBreakerSnapshot separates an answer from the absence of one', () => {
  it('a trustworthy snapshot reads as a snapshot', () => {
    const result = readBreakerSnapshot(snapshot({ states: [armed()] }))
    expect(result.kind).toBe('snapshot')
  })

  it('a ZERO-BUDGET snapshot is still a snapshot — it is an answer, not an absence', () => {
    // The distinction the contract makes with `AllowedNoBudgetGoverns`, whose
    // `budgetsInScope` is the literal type `0`. Reporting this as unreadable
    // would be as wrong as reporting an outage as empty, in the other
    // direction: it would hide a real, actionable finding behind an error.
    const result = readBreakerSnapshot(unbudgetedSnapshot())
    expect(result.kind).toBe('snapshot')
    if (result.kind === 'snapshot') {
      expect(result.snapshot.scan.budgetsInScope).toBe(0)
    }
  })

  it('`null` is unreadable, NOT an empty snapshot', () => {
    // The forged-yes case. A caller that manufactures an empty snapshot from a
    // missing one has invented a server saying "no budget governs this".
    const result = readBreakerSnapshot(null)
    expect(result.kind).toBe('unreadable')
  })

  it('a malformed body is unreadable and says which field', () => {
    const result = readBreakerSnapshot({ states: [], scan: { budgetsInScope: 0 } })
    expect(result.kind).toBe('unreadable')
    if (result.kind === 'unreadable') {
      expect(result.refusals.length).toBeGreaterThan(0)
      // A bug report nobody can act on is barely better than none.
      expect(result.refusals.join(' ')).toMatch(/\w+/)
    }
  })

  it('a body carrying an execution claim is unreadable', () => {
    // The producer-side attack the contract's forbidden-field list exists for:
    // a backend that adds `enforced: true` would otherwise have its claim
    // rendered by anything that spreads a state object.
    const withClaim = { ...snapshot({ states: [armed()] }), enforced: true }
    const result = readBreakerSnapshot(withClaim)
    expect(result.kind).toBe('unreadable')
    if (result.kind === 'unreadable') {
      expect(result.refusals.join(' ')).toContain('forbidden_enforcement_claim')
    }
  })

  it('uses the contract’s own gate rather than a second opinion', () => {
    // Pinned by behaviour: an armed breaker whose figure cannot establish
    // headroom is a CONTRACT-level contradiction, not a shape error, and a
    // hand-rolled shape check here would have let it through.
    const armedOnUndecidable = snapshot({
      states: [
        {
          ...armed(),
          establishedUnderBy: [
            {
              basis: 'approximate',
              kind: 'denormalised_run_counter',
              estimatedAmount: 9_900,
              couldOverstateBy: 0,
              couldUnderstateBy: null,
              approximateBecause: 'counter coverage is short by an unbounded amount',
              wouldBeReconciledBy: 'sum the event log',
              forBudgetId: 'budget_1',
              sampledAt: 1_800_000_000_000,
            },
          ],
        },
      ],
    })
    const result = readBreakerSnapshot(armedOnUndecidable)
    expect(result.kind).toBe('unreadable')
  })
})

describe('the source cannot re-merge the two by accident', () => {
  const page = readFileSync(path.join(WEB_ROOT, 'app/(app)/settings/budgets/page.tsx'), 'utf8')
  const section = readFileSync(path.join(WEB_ROOT, 'src/components/budgets/BudgetsSection.tsx'), 'utf8')
  const service = readFileSync(path.join(WEB_ROOT, 'src/lib/services/budgets.ts'), 'utf8')

  it('the page holds budgets as nullable and does not default to an empty array', () => {
    expect(page).toContain('BudgetRecord[] | null')
    // `listBudgets() ?? []` or `= []` in the catch would be the single edit
    // that turns an outage into "you have no budgets".
    expect(/listBudgets\(\)\s*(\?\?|\|\|)/.test(page)).toBe(false)
    expect(/catch[\s\S]{0,120}budgets\s*=\s*\[\]/.test(page)).toBe(false)
  })

  it('the section renders an ERROR, not an empty state, when the read failed', () => {
    // Ordering: the null branch must return before the length check, or an
    // outage falls through to the "nothing here yet" copy.
    const nullBranch = section.indexOf('budgets === null')
    const emptyBranch = section.indexOf('budgets.length === 0')
    expect(nullBranch).toBeGreaterThan(-1)
    expect(emptyBranch).toBeGreaterThan(-1)
    expect(nullBranch).toBeLessThan(emptyBranch)
    expect(section).toContain('ErrorState')
  })

  it('the empty state says it is a CONFIRMED read', () => {
    expect(section).toContain('confirmed read')
  })

  it('the service does not swallow a failed list read into an empty one', () => {
    // A `try { ... } catch { return [] }` in the service would defeat every
    // check above, because the page would then never see the failure.
    expect(/catch[\s\S]{0,80}return\s*\[\]/.test(service)).toBe(false)
  })

  it('the snapshot panel’s unreadable arm states that it is not an empty result', () => {
    const panel = readFileSync(
      path.join(WEB_ROOT, 'src/components/budgets/BreakerSnapshotPanel.tsx'),
      'utf8',
    )
    expect(panel).toContain('not being shown as an empty list')
    expect(panel).toContain('No budget governs this organization')
    expect(panel).toContain('it is not headroom')
  })
})
