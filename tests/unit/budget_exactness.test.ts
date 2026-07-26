/**
 * AN APPROXIMATE FIGURE MUST NOT BE READABLE AS AN EXACT ONE.
 *
 * ADR-002 is explicit: `usage_counters` is approximate and NOT billing-grade.
 * Single-unit increments are flushed roughly one time in ten and scaled by ten
 * when they are, which makes it a SAMPLED ESTIMATOR — it is not a floor, it is
 * not a ceiling, and it can be wrong in either direction.
 *
 * A hard limit built on such a figure is a lie unless the approximation is in
 * the type. This is the `null`-versus-`0` lesson from `FleetShareMeasurement`
 * with money attached, and the stakes are concrete:
 *
 *   AN APPROXIMATE 9,900 AGAINST A 10,000 CAP AND AN EXACT 9,900 AGAINST A
 *   10,000 CAP ARE NOT THE SAME CLAIM, AND THE DIFFERENCE DECIDES WHETHER
 *   SOMEBODY'S PRODUCTION AGENTS STOP.
 *
 * Three properties are proven here, and each has a specific way of going wrong
 * that would be invisible in normal operation — because the failure only shows
 * up when spend is CLOSE to the cap, which is precisely when nobody is reading
 * carefully:
 *
 *  1. THE COMPARISON CANNOT BE WRITTEN BY HAND. Neither figure type has a field
 *     a caller could put on the left of a `>=`. `spend.amount` does not compile
 *     against either, so `compareSpendToLimit` is not a convenience — it is the
 *     only route, and it is three-valued.
 *
 *  2. `null` IS NOT `0`. An unbounded understatement makes `provably_under`
 *     UNREACHABLE, however comfortable the estimate looks. A single `number`
 *     field would have collapsed "we did not measure the error" into "there is
 *     no error", and the collapse points in the direction that certifies
 *     headroom.
 *
 *  3. A BREAKER CANNOT BE ARMED ON A FIGURE THAT DECIDES NOTHING. The full
 *     chain is proven end to end: the claim audit reports it, the completeness
 *     predicate refuses it, the SDK gate refuses the snapshot, and the decision
 *     comes back a decline rather than a green light.
 *
 * `@ts-expect-error` is the assertion for property 1 and is self-verifying in
 * both directions: if any line stops erroring — someone adds a shared `amount`,
 * relaxes a discriminant, widens `logReadComplete` off the literal `true` —
 * TypeScript reports "Unused '@ts-expect-error' directive" AS AN ERROR and
 * `pnpm typecheck` goes red.
 */
import {
  compareSpendToLimit,
  decideBudget,
  isBreakerSnapshotComplete,
  mayProceed,
  snapshotClaimContradictions,
  spendStatement,
  spendUsability,
} from '@agent-flight-recorder/contracts'
import { snapshotRefusals } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import { NOW, approximate, limit, reconciled, snapshot } from './budget_fixtures.js'

import type {
  ApproximateSpend,
  BreakerArmed,
  ReconciledSpend,
  SpendFigure,
  SpendReconciliation,
} from '@agent-flight-recorder/contracts'

const DENY = { onUnavailable: 'deny' } as const
const CAP = limit({ limitAmount: 10_000 })

describe('the two figure types share no field, so the comparison cannot be hand-rolled', () => {
  it('neither has an `amount` a caller could compare to a limit', () => {
    // Held through an array so TypeScript does not narrow the const to its
    // initializer's arm — the union is the thing under test, and a narrowed
    // `figure` would make three of these four directives pass for the wrong
    // reason.
    const figures: SpendFigure[] = [approximate(9_900)]
    const figure = figures[0]

    // @ts-expect-error - THE LOAD-BEARING ONE. There is no `amount`, so
    // `spend.amount >= limit.limitAmount` — the line every consumer would
    // otherwise write — does not exist to be written.
    void figure.amount
    // @ts-expect-error - nor `spent`.
    void figure.spent
    // @ts-expect-error - nor `total`.
    void figure.total
    // @ts-expect-error - and neither number is readable without narrowing:
    // `estimatedAmount` is not on the reconciled arm.
    void figure.estimatedAmount

    expect(compareSpendToLimit(figure, CAP)).toBe('not_decidable')
  })

  it('an exact figure cannot be read through an approximate one, or vice versa', () => {
    const exact: ReconciledSpend = reconciled(9_900)
    const estimate: ApproximateSpend = approximate(9_900)

    // @ts-expect-error - an estimate is not a reconciled figure.
    const a: ReconciledSpend = estimate
    // @ts-expect-error - and a reconciled figure is not an estimate.
    const b: ApproximateSpend = exact
    void a
    void b

    // @ts-expect-error - the exact figure has no error bounds, because it has
    // no error. A renderer cannot print "± 0" for it by reading a shared field.
    void exact.couldUnderstateBy
    // @ts-expect-error - and the estimate has no proof, because there is none.
    void estimate.establishedBy
  })

  it('a partial sum cannot be spelled as reconciled', () => {
    // `logReadComplete` is the LITERAL TYPE `true`. A summation that stopped on
    // a ceiling cannot construct the proof, so an estimate wearing an exact
    // figure's clothes is a compile error rather than a convention.
    const truncated: SpendReconciliation = {
      proves: 'event_log_summed',
      budgetId: 'budget_1',
      runsSummed: 41,
      eventsSummed: 903,
      // @ts-expect-error - `false` is not assignable to `true`.
      logReadComplete: false,
      reconciledAt: NOW,
    }
    void truncated
  })
})

describe('an approximate figure near the cap decides NOTHING', () => {
  it('THE CASE THIS FEATURE EXISTS FOR: approximate 9,900 vs a 10,000 cap', () => {
    // Naively, 9900 < 10000, so "you have room". That is the lie.
    expect(compareSpendToLimit(approximate(9_900), CAP)).toBe('not_decidable')
    // The exact same number, summed from the log, DOES establish headroom.
    expect(compareSpendToLimit(reconciled(9_900), CAP)).toBe('provably_under')
  })

  it('`null` bounds are not `0` bounds — and the difference is the whole answer', () => {
    // UNBOUNDED: cannot establish anything in either direction.
    expect(spendUsability(approximate(9_900))).toBe('unbounded')
    expect(compareSpendToLimit(approximate(9_900), CAP)).toBe('not_decidable')

    // A bound of 0 is a CLAIM — "this estimate cannot be low" — and it decides.
    // It is a claim `usage_counters` cannot support, which is exactly why the
    // type makes stating it a deliberate act rather than a default.
    expect(compareSpendToLimit(approximate(9_900, { under: 0 }), CAP)).toBe('provably_under')
  })

  it('the bound has to actually clear the cap, not merely exist', () => {
    // 9,900 + 200 = 10,100, which crosses the cap. Still undecided.
    expect(compareSpendToLimit(approximate(9_900, { under: 200 }), CAP)).toBe('not_decidable')
    // 9,900 + 50 = 9,950. Even at its least favourable reading, there is room.
    expect(compareSpendToLimit(approximate(9_900, { under: 50 }), CAP)).toBe('provably_under')
  })

  it('the OVER direction is tightened too, and independently', () => {
    // 10,400 estimated, but it could be overstating by 600 — 9,800 at its most
    // favourable reading, which does not clear the cap. Undecided, not tripped.
    expect(compareSpendToLimit(approximate(10_400, { over: 600 }), CAP)).toBe('not_decidable')
    // Overstating by at most 100 -> 10,300 even at its most favourable. Over.
    expect(compareSpendToLimit(approximate(10_400, { over: 100 }), CAP)).toBe('provably_at_or_over')
    // A figure bounded in ONE direction decides in that direction only.
    expect(compareSpendToLimit(approximate(1_000, { over: 10 }), CAP)).toBe('not_decidable')
  })

  it('a figure for a different budget answers a different question', () => {
    expect(compareSpendToLimit(reconciled(10, 'budget_OTHER'), CAP)).toBe('not_decidable')
  })

  it('fails to `not_decidable` on anything arithmetic cannot be done with — never to `under`', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      'reconciled',
      42,
      { basis: 'reconciled' },
      // Strings that a bare `>=` would coerce. '9900' >= 10000 is FALSE by JS
      // coercion, so a naive comparison does not FAIL a limit check — IT PASSES
      // ONE, and this figure would have read as headroom.
      { ...reconciled(0), reconciledAmount: '9900' },
      { ...approximate(0, { under: 0 }), estimatedAmount: '9900' },
      // NaN, against which every comparison is false, so every check is skipped.
      { ...reconciled(0), reconciledAmount: Number.NaN },
      // A reconciled figure with no proof: an estimate in exact clothing.
      { ...reconciled(9_900), establishedBy: [] },
      // A proof that did not finish reading.
      { ...reconciled(9_900), establishedBy: [{ ...reconciled(9_900).establishedBy[0], logReadComplete: false }] },
      // A bound that is not a bound.
      { ...approximate(9_900), couldUnderstateBy: 'lots' },
      // Approximate with no stated reason: a producer that will not say why its
      // figure is approximate has not thought about whether it is.
      { ...approximate(9_900, { under: 0 }), approximateBecause: '' },
    ]
    for (const figure of hostile) {
      const result = compareSpendToLimit(figure as SpendFigure, CAP)
      expect(result).toBe('not_decidable')
      expect(result).not.toBe('provably_under')
    }
  })

  it('never throws, on any of them', () => {
    for (const figure of [null, undefined, 'x', {}, [], Number.NaN]) {
      expect(() => compareSpendToLimit(figure as SpendFigure, CAP)).not.toThrow()
      expect(() => spendUsability(figure as SpendFigure)).not.toThrow()
    }
  })
})

describe('the rendered sentence cannot be read as exact', () => {
  it('an approximate figure names itself as an estimate and states its bounds', () => {
    const sentence = spendStatement(approximate(9_900), CAP)
    expect(sentence).toContain('APPROXIMATELY')
    expect(sentence).toContain('ESTIMATE, not a measurement')
    expect(sentence).toContain('UNBOUNDED')
    expect(sentence).toContain('not decidable')
    // And it hands over the way to get a real number.
    expect(sentence).toContain('sum llm.response events')
  })

  it('a reconciled figure says where it came from, and does not hedge', () => {
    const sentence = spendStatement(reconciled(9_900), CAP)
    expect(sentence).toContain('SUMMED FROM THE EVENT LOG')
    expect(sentence).not.toContain('APPROXIMATELY')
    expect(sentence).not.toContain('ESTIMATE')
  })

  it('the two are never phrased alike, at the same number', () => {
    expect(spendStatement(approximate(9_900), CAP)).not.toBe(spendStatement(reconciled(9_900), CAP))
  })
})

describe('a breaker cannot be ARMED on a figure that decides nothing — end to end', () => {
  /** An armed breaker whose only evidence is an unbounded estimate near the cap. */
  function armedOnEstimate(): BreakerArmed {
    return {
      state: 'armed',
      armedBudgetId: CAP.budgetId,
      armedLimit: CAP,
      establishedUnderBy: [approximate(9_900)],
      establishedAt: NOW - 1_000,
    }
  }

  it('the claim audit names it', () => {
    const forged = snapshot({ states: [armedOnEstimate()] })
    const findings = snapshotClaimContradictions(forged)
    expect(findings.map((f) => f.contradiction)).toContain('armed_on_undecidable_spend')
  })

  it('the completeness predicate refuses it', () => {
    expect(isBreakerSnapshotComplete(snapshot({ states: [armedOnEstimate()] }))).toBe(false)
    // ...while the same shape backed by a reconciled figure passes, so the
    // predicate is discriminating rather than merely strict.
    expect(isBreakerSnapshotComplete(snapshot())).toBe(true)
  })

  it('the SDK gate refuses the snapshot', () => {
    expect(snapshotRefusals(snapshot({ states: [armedOnEstimate()] })).join(' ')).toContain(
      'armed_on_undecidable_spend'
    )
  })

  it('THE DECISION IS A DECLINE, NOT A GREEN LIGHT', () => {
    const decision = decideBudget({
      snapshot: snapshot({ states: [armedOnEstimate()] }),
      unavailableBecause: 'the snapshot could not establish headroom',
      receivedAt: NOW, now: NOW,
      policy: DENY,
    })
    expect(mayProceed(decision)).toBe(false)
    expect(decision.decision).toBe('declined_no_answer')
  })

  it('an armed breaker over its OWN limit is reported distinctly, not as the vaguer code', () => {
    // An engine author told "your figure cannot decide" would go looking at
    // error bounds; the real problem here is that the figure refutes the claim.
    const forged = snapshot({
      states: [{ ...armedOnEstimate(), establishedUnderBy: [reconciled(10_400)] }],
    })
    expect(snapshotClaimContradictions(forged).map((f) => f.contradiction)).toContain('armed_over_its_own_limit')
  })

  it('a TRIP on an approximate figure is still possible — the asymmetry is deliberate', () => {
    // Spend that is PROVABLY over should stop. Spend that MIGHT be under should
    // not be certified as headroom. The two directions have different costs and
    // the contract does not pretend otherwise.
    const trippedOnEstimate = snapshot({
      states: [
        {
          state: 'tripped',
          trippedBudgetId: CAP.budgetId,
          trippedLimit: CAP,
          trippedAt: NOW - 5_000,
          trippedBy: 'limit_reached',
          trippedBecause: 'estimated spend clears the cap even at its most favourable reading',
          determinedFrom: [approximate(10_400, { over: 100 })],
        },
      ],
    })
    expect(snapshotClaimContradictions(trippedOnEstimate)).toEqual([])
    expect(decideBudget({ snapshot: trippedOnEstimate, receivedAt: NOW, now: NOW, policy: DENY }).decision).toBe(
      'declined_breaker_tripped'
    )
  })

  it('a trip whose own figures do NOT establish it is refused', () => {
    const unsupported = snapshot({
      states: [
        {
          state: 'tripped',
          trippedBudgetId: CAP.budgetId,
          trippedLimit: CAP,
          trippedAt: NOW - 5_000,
          trippedBy: 'limit_reached',
          trippedBecause: 'trust me',
          determinedFrom: [approximate(10_400)],
        },
      ],
    })
    expect(snapshotClaimContradictions(unsupported).map((f) => f.contradiction)).toContain(
      'trip_not_established_by_its_own_figures'
    )
  })

  it('a MANUAL trip is not audited against the meter — an operator is not arithmetic', () => {
    const manual = snapshot({
      states: [
        {
          state: 'tripped',
          trippedBudgetId: CAP.budgetId,
          trippedLimit: CAP,
          trippedAt: NOW - 5_000,
          trippedBy: 'manual_trip',
          trippedBecause: 'runaway retry loop, incident INC-412',
          determinedFrom: [reconciled(12)],
        },
      ],
    })
    expect(snapshotClaimContradictions(manual)).toEqual([])
  })
})
