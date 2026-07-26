/**
 * THE FAIL-CLOSED PATH MUST NOT BE BYPASSABLE BY INDUCING AN ERROR.
 *
 * A breaker that fails OPEN when it cannot reach the server is not a breaker:
 * anybody who wants past it arranges a network error, and "the check errored" is
 * the easiest condition in computing to arrange. So the property under test is
 * not "does `deny` decline when there is no snapshot" — that is the case
 * everybody writes. It is:
 *
 *   IS THERE ANY INPUT AT ALL — malformed, hostile, exotic, or merely unlucky —
 *   THAT TURNS A `deny` POLICY INTO A PROCEED, OR THAT MAKES THE GUARD THROW
 *   RATHER THAN DECIDE?
 *
 * The second half of that matters as much as the first. An exception from an
 * enforcement path is an enforcement OUTCOME nobody chose, and inside the
 * `try/catch` that surrounds a model call it is the permissive one. So the
 * sweep asserts both: no proceed, and no throw, over a corpus of inputs the
 * author of the happy path did not have in mind.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE ALSO PINS FOUR DEFECTS FOUND BY ATTACK, EACH IN ITS OWN BLOCK
 * ---------------------------------------------------------------------------
 *
 * D1 — GRACE HONOURED THE RISKIEST ANSWER AND DECLINED THE SAFEST. The grace
 *      arm carried `&& budgetsInScope > 0`, so at identical staleness a breaker
 *      last seen ONE CENT BELOW ITS CAP was honoured while a subject NO BUDGET
 *      GOVERNS AT ALL was declined. An org that had configured nothing had its
 *      agents stopped by the budget breaker during an outage of ours. The
 *      halt-a-business direction, aimed at the customers with the least reason
 *      to expect it.
 *
 * D2 — AN EVIDENCE-FREE TRIP DECLINED, UNGATED. `{ state: 'tripped',
 *      trippedBudgetId: 'evil' }` produced `declined_breaker_tripped` from the
 *      shared rule while the refusal list on the same body returned four
 *      refusals. `BudgetGuard` was gated; every other caller of `decideBudget`
 *      was not. The causal edge with zero citations, in money.
 *
 * D3 — THE HONOURING CEILING WAS ANCHORED ON A SERVER-SUPPLIED CLOCK.
 *      `min(freshUntil, evaluatedAt + MAX)` mixes the server's timestamp with
 *      the client's `now`. Server ahead: the cap that exists to stop a
 *      compromised deployment granting a year of permission is defeated
 *      permissively. Server behind: every snapshot is born stale and every
 *      decision is a decline, fleet-wide. A cap defeated by the value it is
 *      capping is not a cap.
 *
 * D4 — THE CEILING AND THE BACKEND'S STALENESS FLOOR WERE HAND-PICKED SEPARATELY
 *      AND CROSSED. A 60s ceiling against a 120s floor with a 60s sweep meant
 *      an answer expired exactly as its replacement was computed: a fleet-wide
 *      sawtooth of declines from ordinary cron jitter. The ceiling is now
 *      DERIVED from the cadence, and the relationship is asserted here rather
 *      than commented.
 */
import {
  BREAKER_EVALUATION_CADENCE_MS,
  BREAKER_FRESHNESS_CADENCE_MULTIPLE,
  breakerCadenceInvariant,
  breakerSnapshotRefusals,
  decideBudget,
  establishedTrip,
  statedShelfLifeMs,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  mayProceed,
} from '@agent-flight-recorder/contracts'
import { BudgetGuard } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import { NOW, armed, reconciled, snapshot, tripped, unbudgetedSnapshot } from './budget_fixtures.js'

import type { BreakerTripped , BreakerSnapshot, BudgetUnavailablePolicy } from '@agent-flight-recorder/contracts'


/**
 * A snapshot as a deployment PREDATING `shelfLifeMs` would send it.
 *
 * The key is DELETED rather than set to `undefined`: under
 * `exactOptionalPropertyTypes` those are different, and only the deletion
 * models an older server — which is the case the derived fallback exists for.
 */
function withoutShelfLife(s: BreakerSnapshot): BreakerSnapshot {
  const copy = { ...(s as unknown as Record<string, unknown>) }
  delete copy['shelfLifeMs']
  return copy as unknown as BreakerSnapshot
}

const DENY: BudgetUnavailablePolicy = { onUnavailable: 'deny' }
const GRACE: BudgetUnavailablePolicy = {
  onUnavailable: 'grace',
  graceMs: 30_000,
  acceptedRisk: 'up to 30s of spend past the cap during an AFR outage',
}
const ALLOW: BudgetUnavailablePolicy = {
  onUnavailable: 'allow',
  acceptedRisk: 'unbounded spend while AFR is unreachable',
}

/**
 * Inputs an attacker, a bad deployment or a bad afternoon could produce.
 *
 * Each one is a specific way of arranging "the check errored". The corpus is
 * the point: proving the happy-path refusal proves nothing about the input
 * nobody imagined, and every entry here is one somebody could imagine.
 */
function hostileSnapshots(): { name: string; snapshot: unknown }[] {
  const good = snapshot()
  return [
    { name: 'null', snapshot: null },
    { name: 'undefined', snapshot: undefined },
    { name: 'a string', snapshot: 'armed' },
    { name: 'a number', snapshot: 1 },
    { name: 'an array', snapshot: [] },
    { name: 'an empty object', snapshot: {} },
    { name: 'no scan', snapshot: { ...good, scan: undefined } },
    { name: 'scan is a string', snapshot: { ...good, scan: 'complete' } },
    { name: 'states is a string', snapshot: { ...good, states: 'armed' } },
    { name: 'states contains null', snapshot: { ...good, states: [null] } },
    { name: 'states contains a string', snapshot: { ...good, states: ['armed'] } },
    { name: 'a state with an unknown discriminant', snapshot: { ...good, states: [{ state: 'fine' }] } },
    { name: 'freshUntil is a string', snapshot: { ...good, freshUntil: '99999999999999' } },
    { name: 'freshUntil is NaN', snapshot: { ...good, freshUntil: Number.NaN } },
    { name: 'freshUntil is Infinity', snapshot: { ...good, freshUntil: Number.POSITIVE_INFINITY } },
    { name: 'freshUntil precedes evaluatedAt', snapshot: { ...good, freshUntil: good.evaluatedAt - 1 } },
    { name: 'evaluatedAt is NaN', snapshot: { ...good, evaluatedAt: Number.NaN } },
    {
      name: 'counts are strings that a bare >= would coerce',
      snapshot: { ...good, scan: { ...good.scan, budgetsInScope: '1', budgetsEvaluated: '1' } },
    },
    {
      name: 'evaluationTruncated is dropped (undefined is falsy)',
      snapshot: { ...good, scan: { ...good.scan, evaluationTruncated: undefined } },
    },
    {
      name: 'evaluationTruncated is the string "false"',
      snapshot: { ...good, scan: { ...good.scan, evaluationTruncated: 'false' } },
    },
    {
      name: 'more budgets in scope than were evaluated',
      snapshot: { ...good, scan: { ...good.scan, budgetsInScope: 9 } },
    },
    { name: 'an armed breaker citing nothing', snapshot: { ...good, states: [{ ...armed(), establishedUnderBy: [] }] } },
    {
      name: 'an armed breaker whose figure is over its own cap',
      snapshot: { ...good, states: [{ ...armed(), establishedUnderBy: tripped().determinedFrom }] },
    },
    { name: 'duplicate states for one budget', snapshot: { ...good, states: [armed(), armed()] } },
    { name: 'a proxy that throws on every property read', snapshot: throwingProxy() },
    { name: 'an object with a throwing getter', snapshot: { ...good, get states(): never { throw new Error('nope') } } },
    { name: 'a malformed, self-referential object', snapshot: selfReferential() },
  ]
}

function throwingProxy(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('property access denied')
      },
      ownKeys() {
        throw new Error('key enumeration denied')
      },
    }
  )
}

/**
 * Malformed AND cyclic. Both halves matter: the malformation is what must be
 * refused, and the cycle is what must not hang the validator walking it.
 *
 * A merely cyclic but otherwise WELL-FORMED snapshot is not hostile and is
 * expected to pass — an extra key nobody reads is not a defect — so basing this
 * on a good snapshot would have made it a corpus entry that proves the opposite
 * of what the corpus is for.
 */
function selfReferential(): unknown {
  const cyclic: Record<string, unknown> = { ...(snapshot() as unknown as Record<string, unknown>), states: [null] }
  cyclic['self'] = cyclic
  return cyclic
}

describe('no hostile input turns a `deny` policy into a proceed', () => {
  it.each(hostileSnapshots())('$name', ({ snapshot: hostile }) => {
    const decision = decideBudget({
      snapshot: hostile as BreakerSnapshot,
      unavailableBecause: 'induced',
      receivedAt: NOW,
      now: NOW,
      policy: DENY,
    })
    expect(mayProceed(decision)).toBe(false)
  })

  it.each(hostileSnapshots())('$name — and never throws', ({ snapshot: hostile }) => {
    expect(() =>
      decideBudget({ snapshot: hostile as BreakerSnapshot, receivedAt: NOW, now: NOW, policy: DENY })
    ).not.toThrow()
    expect(() => breakerSnapshotRefusals(hostile as BreakerSnapshot)).not.toThrow()
  })

  it.each(hostileSnapshots())('$name — and the guard declines rather than raising', ({ snapshot: hostile }) => {
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => NOW })
    expect(() => guard.absorbSnapshot(hostile as BreakerSnapshot)).not.toThrow()
    expect(guard.absorbSnapshot(hostile as BreakerSnapshot).accepted).toBe(false)
    expect(guard.mayProceedNow()).toBe(false)
  })

  it('a `grace` policy is not a way round it either — grace needs a yes it actually received', () => {
    for (const { snapshot: hostile } of hostileSnapshots()) {
      const decision = decideBudget({
        snapshot: hostile as BreakerSnapshot,
        unavailableBecause: 'induced',
        receivedAt: NOW,
        now: NOW,
        policy: GRACE,
      })
      expect(mayProceed(decision)).toBe(false)
    }
  })

  it('under `allow` they proceed — and are reported as `allowed_without_answer`, never as headroom', () => {
    // The fail-open policy is a stated, auditable choice, so it must work. What
    // must NOT happen is it being indistinguishable from a consulted breaker.
    for (const { snapshot: hostile } of hostileSnapshots()) {
      const decision = decideBudget({
        snapshot: hostile as BreakerSnapshot,
        unavailableBecause: 'induced',
        receivedAt: NOW,
        now: NOW,
        policy: ALLOW,
      })
      expect(decision.decision).toBe('allowed_without_answer')
      expect(decision.decision).not.toBe('allowed_breaker_armed')
    }
  })

  it('the corpus is not vacuous — the SAME shape, well-formed, proceeds', () => {
    // Without this, every assertion above would pass on a fixture that could
    // never proceed under any circumstances.
    const decision = decideBudget({ snapshot: snapshot(), receivedAt: NOW, now: NOW, policy: DENY })
    expect(decision.decision).toBe('allowed_breaker_armed')
    expect(mayProceed(decision)).toBe(true)
  })
})

describe('the guard itself cannot be made to throw', () => {
  it('a clock that throws is an unavailability, not an exception', () => {
    const guard = new BudgetGuard({
      unavailablePolicy: DENY,
      now: () => {
        throw new Error('clock unavailable')
      },
    })
    expect(() => guard.check()).not.toThrow()
    expect(mayProceed(guard.check())).toBe(false)
    expect(guard.freshnessRemainingMs()).toBeNull()
    expect(guard.shouldRefresh()).toBe(true)
  })

  it('a clock returning nonsense is too', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 'now']) {
      const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => bad as number })
      expect(mayProceed(guard.check())).toBe(false)
    }
  })

  it('a guard that never received anything declines, and says which', () => {
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => NOW })
    const decision = guard.check()
    expect(decision.decision).toBe('declined_no_answer')
    if (decision.decision === 'declined_no_answer') {
      expect(decision.noAnswerBecause).toContain('no breaker snapshot has been received')
    }
  })

  it('a REFUSED snapshot neither poisons nor EXTENDS a good one', () => {
    let clock = NOW
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => clock })
    expect(guard.absorbSnapshot(snapshot()).accepted).toBe(true)
    expect(guard.mayProceedNow()).toBe(true)

    // A forged snapshot with an enormous shelf life is refused, so it cannot
    // buy time. The held answer keeps its own expiry.
    const forged = snapshot({ shelfLifeMs: 86_400_000, states: 'armed' as unknown as [] })
    expect(guard.absorbSnapshot(forged).accepted).toBe(false)
    clock = NOW + 11_001 // past the held snapshot's OWN shelf life
    expect(guard.mayProceedNow()).toBe(false)
  })

  it('a misconfigured policy throws at WIRING time, not at decision time', () => {
    expect(() => new BudgetGuard({ unavailablePolicy: undefined as unknown as BudgetUnavailablePolicy })).toThrow(
      RangeError
    )
    expect(() => new BudgetGuard({ unavailablePolicy: { onUnavailable: 'grace', graceMs: 0 } as never })).toThrow(
      RangeError
    )
    // Fail-open without a written accepted risk is a caller bug, not a default.
    expect(() => new BudgetGuard({ unavailablePolicy: { onUnavailable: 'allow' } as never })).toThrow(/acceptedRisk/)
    expect(() =>
      new BudgetGuard({ unavailablePolicy: { onUnavailable: 'grace', graceMs: 999_999_999, acceptedRisk: 'x' } })
    ).toThrow(/MAX_BREAKER_GRACE_MS/)
  })

  it('a missing policy at the RULE level fails closed rather than throwing', () => {
    // `decideBudget` is reachable without the guard's constructor, so it cannot
    // rely on that validation having happened.
    const decision = decideBudget({
      snapshot: snapshot(),
      receivedAt: NOW,
      now: NOW,
      policy: undefined as unknown as BudgetUnavailablePolicy,
    })
    expect(decision.decision).toBe('declined_no_answer')
  })
})

describe('a trip cannot be outrun by keeping the server unreachable', () => {
  it('a TRIPPED breaker declines even on a long-expired snapshot', () => {
    // The bypass this ordering closes: if freshness were checked first, an
    // agent could spend freely for as long as it could keep the server away.
    const stale = snapshot({ states: [tripped()], shelfLifeMs: 10_000 })
    for (const policy of [DENY, GRACE, ALLOW]) {
      const decision = decideBudget({
        snapshot: stale,
        unavailableBecause: 'network',
        receivedAt: NOW - 600_000,
        now: NOW,
        policy,
      })
      expect(decision.decision).toBe('declined_breaker_tripped')
    }
  })
})

/** D2 */
describe('D2 — an evidence-free trip is gated in the RULE, not only in the guard', () => {
  const evil = snapshot({ states: [{ state: 'tripped', trippedBudgetId: 'evil' } as never] })

  it('the refusal list and the decision rule now agree', () => {
    expect(breakerSnapshotRefusals(evil).length).toBeGreaterThan(0)
    const decision = decideBudget({ snapshot: evil, receivedAt: NOW, now: NOW, policy: DENY })
    // NOT `declined_breaker_tripped`: we have no evidence any breaker tripped,
    // and asserting one would be dishonest in the other direction.
    expect(decision.decision).toBe('declined_no_answer')
  })

  it('and it does not become an ALLOW — an untrustworthy body establishes nothing', () => {
    expect(mayProceed(decideBudget({ snapshot: evil, receivedAt: NOW, now: NOW, policy: DENY }))).toBe(false)
    expect(mayProceed(decideBudget({ snapshot: evil, receivedAt: NOW, now: NOW, policy: GRACE }))).toBe(false)
  })

  it('a WELL-FORMED trip still declines as a trip, so the gate is discriminating', () => {
    expect(decideBudget({ snapshot: snapshot({ states: [tripped()] }), receivedAt: NOW, now: NOW, policy: DENY }).decision).toBe(
      'declined_breaker_tripped'
    )
  })
})

/** D1 — the halt-a-business direction. */
describe('D1 — grace must not decline the subject with NO BUDGET AT ALL', () => {
  /** A ten-second shelf life, received twenty seconds ago: expired by RECEIPT. */
  const EXPIRED = { shelfLifeMs: 10_000 }

  it('an org that configured nothing is not stopped by the budget breaker during OUR outage', () => {
    const decision = decideBudget({
      snapshot: { ...unbudgetedSnapshot(), ...EXPIRED },
      unavailableBecause: 'the AFR deployment is unreachable',
      receivedAt: NOW - 20_000,
      now: NOW,
      policy: GRACE,
    })
    expect(mayProceed(decision)).toBe(true)
    expect(decision.decision).toBe('allowed_within_grace')
  })

  it('the two cases are now treated alike — and the OLD behaviour was the inversion', () => {
    // A breaker one cent below its cap and a subject with no cap at all, at
    // identical staleness under an identical policy. Before the fix the first
    // was honoured and the second declined, which is backwards: the unbudgeted
    // subject is the one we have least right to intervene on.
    const nearCap = decideBudget({
      snapshot: { ...snapshot({ states: [armed(9_999)] }), ...EXPIRED },
      unavailableBecause: 'unreachable',
      receivedAt: NOW - 20_000,
      now: NOW,
      policy: GRACE,
    })
    const unbudgeted = decideBudget({
      snapshot: { ...unbudgetedSnapshot(), ...EXPIRED },
      unavailableBecause: 'unreachable',
      receivedAt: NOW - 20_000,
      now: NOW,
      policy: GRACE,
    })
    expect(mayProceed(nearCap)).toBe(mayProceed(unbudgeted))
    expect(mayProceed(unbudgeted)).toBe(true)
  })

  it('grace still ENDS — it is a bounded window, not a switch', () => {
    const decision = decideBudget({
      snapshot: { ...unbudgetedSnapshot(), ...EXPIRED },
      unavailableBecause: 'unreachable',
      receivedAt: NOW - 20_000,
      now: NOW + 60_000, // past freshUntil + graceMs
      policy: GRACE,
    })
    expect(mayProceed(decision)).toBe(false)
  })

  it('under `deny`, an expired answer is no answer — for both cases equally', () => {
    for (const snap of [{ ...unbudgetedSnapshot(), ...EXPIRED }, { ...snapshot(), ...EXPIRED }]) {
      expect(
        mayProceed(decideBudget({ snapshot: snap, receivedAt: NOW - 20_000, now: NOW, policy: DENY }))
      ).toBe(false)
    }
  })
})

/** D3 — a cap defeated by the value it is capping is not a cap. */
describe('D3 — the honouring ceiling is anchored on a clock the client controls', () => {
  it('a server clock an HOUR AHEAD cannot buy an hour of extra permission', () => {
    // The server claims it evaluated an hour from now and that its answer is
    // good for an hour. Anchored on `evaluatedAt`, that was an hour of grace.
    const forged = snapshot({
      evaluatedAt: NOW + 3_600_000,
      freshUntil: NOW + 7_200_000,
      shelfLifeMs: 7_200_000,
    })
    const receivedAt = NOW
    const decision = decideBudget({
      snapshot: forged,
      receivedAt,
      now: receivedAt + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1,
      policy: DENY,
    })
    expect(mayProceed(decision)).toBe(false)
  })

  it('and the ceiling is exactly MAX past RECEIPT, not past the server timestamp', () => {
    const forged = snapshot({ evaluatedAt: NOW + 3_600_000, freshUntil: NOW + 7_200_000, shelfLifeMs: 7_200_000 })
    const receivedAt = NOW
    expect(
      mayProceed(
        decideBudget({ snapshot: forged, receivedAt, now: receivedAt + MAX_BREAKER_ANSWER_FRESHNESS_MS - 1, policy: DENY })
      )
    ).toBe(true)
    expect(
      mayProceed(
        decideBudget({ snapshot: forged, receivedAt, now: receivedAt + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1, policy: DENY })
      )
    ).toBe(false)
  })

  it('a server clock BEHIND does not make every answer born stale', () => {
    // The other side of the same defect, and the one that halts a fleet: an
    // `evaluatedAt` well in the past used to burn the entire ceiling before the
    // client had even received the body.
    const lagging = snapshot({ evaluatedAt: NOW - 3_600_000, freshUntil: NOW - 3_590_000, shelfLifeMs: 10_000 })
    const decision = decideBudget({ snapshot: lagging, receivedAt: NOW, now: NOW + 1_000, policy: DENY })
    expect(decision.decision).toBe('allowed_breaker_armed')
  })

  it('a missing `receivedAt` fails CLOSED rather than falling back to the server clock', () => {
    const decision = decideBudget({
      snapshot: snapshot(),
      receivedAt: Number.NaN,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('declined_no_answer')
  })

  it('the guard stamps receipt from its OWN clock, and enforces validUntil from it', () => {
    let clock = NOW
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => clock })
    // A server insisting its answer is good for a day.
    guard.absorbSnapshot(snapshot({ shelfLifeMs: 86_400_000 }))
    expect(guard.mayProceedNow()).toBe(true)
    clock = NOW + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1
    // THE SERVER CANNOT MAKE A CACHED `proceed` STOP BEING ONE. Only the
    // process holding it can, and this is that line.
    expect(guard.mayProceedNow()).toBe(false)
    expect(guard.freshnessRemainingMs()).toBe(0)
    expect(guard.shouldRefresh()).toBe(true)
  })
})

/** D4 — two hand-maintained constants that must agree. */
describe('D4 — the honouring ceiling is DERIVED from the evaluation cadence', () => {
  /**
   * THE INVARIANT NOW TAKES THE OBSERVED CADENCE, and passing
   * `BREAKER_EVALUATION_CADENCE_MS` back into it would be the vacuous check
   * again — the first version took no argument and, because the ceiling is
   * DERIVED from the cadence, its conditions reduced to statements about a
   * literal three lines away. It could not fail for its own stated reason.
   *
   * The pair that can still diverge is this constant and the sweep the
   * DEPLOYMENT actually registers, so the real assertion lives where the cron
   * is readable (`budget_adversarial_engine.test.ts` reads the interval off the
   * shipped `crons` export). What is checked here is the arithmetic the
   * function performs once it has been given a real, independently-sourced
   * number.
   */
  it('accepts a deployment sweeping at the declared cadence', () => {
    expect(breakerCadenceInvariant(BREAKER_EVALUATION_CADENCE_MS)).toBeNull()
  })

  it('REJECTS a deployment whose sweep has drifted from the declared cadence', () => {
    // The route the derivation does not cover: someone edits the cron to every
    // five minutes and leaves the constant at 60s, so answers expire four
    // minutes before their replacements are computed.
    expect(breakerCadenceInvariant(300_000)).toContain('sweeps every 300000ms')
    expect(breakerCadenceInvariant(30_000)).not.toBeNull()
  })

  it('rejects a cadence that is not a number at all, rather than passing it', () => {
    for (const bad of [Number.NaN, 0, -1, undefined, 'one minute']) {
      expect(breakerCadenceInvariant(bad as number)).not.toBeNull()
    }
  })

  it('is not vacuous — it can return non-null, which the zero-argument version could not', () => {
    // The property the old signature lacked. If this ever starts returning
    // `null` for every input, the check has gone quiet again.
    expect(breakerCadenceInvariant(300_000)).not.toBeNull()
    expect(breakerCadenceInvariant(BREAKER_EVALUATION_CADENCE_MS)).toBeNull()
  })

  it('the ceiling is a multiple of the cadence, not a number chosen beside it', () => {
    expect(MAX_BREAKER_ANSWER_FRESHNESS_MS).toBe(
      BREAKER_EVALUATION_CADENCE_MS * BREAKER_FRESHNESS_CADENCE_MULTIPLE
    )
  })

  it('one cadence would guarantee a sawtooth, so the multiple is at least two', () => {
    // An answer that expires at exactly the moment its replacement is being
    // computed turns any cron lateness into a fleet-wide decline. The margin is
    // the whole reason the multiple exists.
    expect(BREAKER_FRESHNESS_CADENCE_MULTIPLE).toBeGreaterThanOrEqual(2)
    expect(MAX_BREAKER_ANSWER_FRESHNESS_MS).toBeGreaterThan(BREAKER_EVALUATION_CADENCE_MS)
  })

  it('an answer survives one missed sweep, which is the operational case', () => {
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => NOW })
    guard.absorbSnapshot(snapshot({ shelfLifeMs: MAX_BREAKER_ANSWER_FRESHNESS_MS }))
    // One cadence late: the replacement has not arrived, and the held answer
    // must still be good or every deployment sees spurious declines.
    const late = new BudgetGuard({
      unavailablePolicy: DENY,
      now: () => NOW,
    })
    late.absorbSnapshot(snapshot({ shelfLifeMs: MAX_BREAKER_ANSWER_FRESHNESS_MS }))
    expect(
      mayProceed(
        decideBudget({
          snapshot: snapshot({ shelfLifeMs: MAX_BREAKER_ANSWER_FRESHNESS_MS }),
          receivedAt: NOW,
          now: NOW + BREAKER_EVALUATION_CADENCE_MS + 1_000,
          policy: DENY,
        })
      )
    ).toBe(true)
  })

  it('but not indefinitely — the security bound survives the derivation', () => {
    expect(MAX_BREAKER_ANSWER_FRESHNESS_MS).toBeLessThanOrEqual(BREAKER_EVALUATION_CADENCE_MS * 5)
  })
})

/** C2 */
describe('C2 — the enforcement-claim walk is TOTAL, not a list of branches', () => {
  it('a claim planted inside a spend-proof object is caught', () => {
    // The object whose entire job is to carry `proves: "event_log_summed"` was
    // the one branch the hand-picked walk did not visit.
    // Narrowed deliberately: `establishedUnderBy[0]` is a `SpendFigure`, and
    // `.establishedBy` is not readable off the union — which is the exactness
    // barrier doing its job even inside a test that is attacking a different
    // one. Build the reconciled figure directly.
    const figure = reconciled(1_000)
    const planted = {
      ...snapshot(),
      states: [
        {
          ...armed(),
          establishedUnderBy: [{ ...figure, establishedBy: [{ ...figure.establishedBy[0], agentStopped: true }] }],
        },
      ],
    }
    expect(breakerSnapshotRefusals(planted as unknown as BreakerSnapshot).join(' ')).toContain(
      'forbidden_enforcement_claim'
    )
  })

  it.each([
    ['armedLimit', (s: BreakerSnapshot) => ({ ...s, states: [{ ...armed(), armedLimit: { ...armed().armedLimit, enforced: true } }] })],
    ['scan.subject', (s: BreakerSnapshot) => ({ ...s, scan: { ...s.scan, subject: { agentId: 'a', halted: true } } })],
    ['trippedLimit', (s: BreakerSnapshot) => ({ ...s, states: [{ ...tripped(), trippedLimit: { ...tripped().trippedLimit, blocked: true } }] })],
  ])('a claim planted in %s is caught', (_name, mutate) => {
    expect(breakerSnapshotRefusals(mutate(snapshot()) as unknown as BreakerSnapshot).join(' ')).toContain(
      'forbidden_enforcement_claim'
    )
  })

  it('and the walk terminates on a cyclic body rather than hanging', () => {
    expect(() => breakerSnapshotRefusals(selfReferential() as BreakerSnapshot)).not.toThrow()
    // Also on a WELL-FORMED cyclic one, which is the case a `seen` set is for:
    // termination must not depend on the body being rejected early.
    const wellFormedCycle: Record<string, unknown> = { ...(snapshot() as unknown as Record<string, unknown>) }
    wellFormedCycle['self'] = wellFormedCycle
    expect(() => breakerSnapshotRefusals(wellFormedCycle as unknown as BreakerSnapshot)).not.toThrow()
  })
})


/**
 * N6 — the second half of D3. The first repair anchored the CEILING on
 * `receivedAt` and left the FLOOR as the server's absolute `freshUntil`, which
 * `min` still took. Fixing one direction of a two-sided defect, in the
 * direction that costs money, leaving open the direction that halts a business.
 */
describe('N6 — a server clock BEHIND cannot make every answer born stale', () => {
  it('an hour-behind server still yields a usable answer', () => {
    // The server thinks it is 08:00 when the client thinks it is 09:00, so its
    // `freshUntil` sits an hour in the CLIENT'S past. Taken as an absolute
    // floor, `min(freshUntil, ...)` made this expired on arrival — every
    // decision a decline, fleet-wide, with no budget anywhere near a cap.
    const behind = snapshot({
      evaluatedAt: NOW - 3_600_000,
      freshUntil: NOW - 3_590_000,
      shelfLifeMs: 10_000,
    })
    const decision = decideBudget({ snapshot: behind, receivedAt: NOW, now: NOW + 1_000, policy: DENY })
    expect(decision.decision).toBe('allowed_breaker_armed')
  })

  it('and the SAME body is not honoured forever — the duration still governs', () => {
    const behind = snapshot({ evaluatedAt: NOW - 3_600_000, freshUntil: NOW - 3_590_000, shelfLifeMs: 10_000 })
    expect(
      mayProceed(decideBudget({ snapshot: behind, receivedAt: NOW, now: NOW + 10_001, policy: DENY }))
    ).toBe(false)
  })

  it('an hour-AHEAD server still buys nothing — both directions closed at once', () => {
    const ahead = snapshot({ evaluatedAt: NOW + 3_600_000, freshUntil: NOW + 7_200_000, shelfLifeMs: 7_200_000 })
    expect(
      mayProceed(
        decideBudget({
          snapshot: ahead,
          receivedAt: NOW,
          now: NOW + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1,
          policy: DENY,
        })
      )
    ).toBe(false)
  })

  it('a non-positive DURATION is still malformed — skew is tolerated, nonsense is not', () => {
    // The distinction the fix rests on: an instant in the client's past is
    // ordinary skew; a shelf life of zero is an answer never good for any time.
    expect(breakerSnapshotRefusals(snapshot({ shelfLifeMs: 0 })).join(' ')).toContain('shelf_life_not_positive')
    expect(
      breakerSnapshotRefusals(withoutShelfLife(snapshot({ evaluatedAt: NOW, freshUntil: NOW }))).join(' ')
    ).toContain('shelf_life_not_positive')
  })

  it('but a `freshUntil` in the CLIENT past is NOT reported as malformed', () => {
    // Reporting it would decline the whole fleet in the first test above.
    const behind = snapshot({ evaluatedAt: NOW - 3_600_000, freshUntil: NOW - 3_590_000, shelfLifeMs: 10_000 })
    expect(breakerSnapshotRefusals(behind)).toEqual([])
  })
})

/**
 * The transit deduction (Team A's X2). A duration means the same thing whenever
 * it arrives; an absolute instant silently spends the cadence margin on the
 * network — and spends most of it exactly when the deployment is slowest, so
 * every client's hold shortens together and they all come back at once.
 */
describe('the stated shelf life is not eroded by transit', () => {
  it('a slow response is held for its full stated duration', () => {
    const held = snapshot({ shelfLifeMs: MAX_BREAKER_ANSWER_FRESHNESS_MS })
    // Five seconds of transit. Under the old absolute-instant reading this
    // answer would have been good for MAX - 5s.
    const receivedAt = NOW + 5_000
    expect(
      mayProceed(
        decideBudget({
          snapshot: held,
          receivedAt,
          now: receivedAt + MAX_BREAKER_ANSWER_FRESHNESS_MS - 1,
          policy: DENY,
        })
      )
    ).toBe(true)
  })

  it('two clients with different transit get the SAME hold — no synchronised expiry', () => {
    const held = snapshot({ shelfLifeMs: 30_000 })
    const fast = decideBudget({ snapshot: held, receivedAt: NOW, now: NOW + 29_000, policy: DENY })
    const slow = decideBudget({ snapshot: held, receivedAt: NOW + 8_000, now: NOW + 37_000, policy: DENY })
    expect(mayProceed(fast)).toBe(true)
    expect(mayProceed(slow)).toBe(true)
  })

  it('the EXPLICIT duration wins over the derived one', () => {
    // A deployment that sends both is stating its intent; the difference of two
    // timestamps is only an inference about it.
    expect(statedShelfLifeMs(snapshot({ shelfLifeMs: 42_000 }))).toBe(42_000)
    // ...and a deployment predating the field is still readable.
    expect(statedShelfLifeMs(withoutShelfLife(snapshot({ evaluatedAt: NOW, freshUntil: NOW + 7_000 })))).toBe(7_000)
    // `null`, not `0`, when there is none to state.
    expect(statedShelfLifeMs(snapshot({ shelfLifeMs: -1 }))).toBeNull()
  })
})

/**
 * N1 — the mirror image the D2 fix opened. Gating on the WHOLE refusal list
 * meant one malformed sibling field erased a genuine, evidence-backed trip.
 */
describe('N1 — a refusal is scoped to what it actually impugns', () => {
  /** A well-formed trip beside one typo'd, unrelated field. */
  const tripWithSiblingTypo = snapshot({
    states: [tripped()],
    scan: { subject: { agentId: 'agent_7' }, budgetsInScope: 1, budgetsEvaluated: 1, evaluationTruncated: 'no' as never },
  })

  it('the body IS refused — the typo is real and is reported', () => {
    expect(breakerSnapshotRefusals(tripWithSiblingTypo).join(' ')).toContain('evaluationTruncated')
  })

  it('and the trip SURVIVES it, keeping its identity and its reason', () => {
    const decision = decideBudget({ snapshot: tripWithSiblingTypo, receivedAt: NOW, now: NOW, policy: DENY })
    expect(decision.decision).toBe('declined_breaker_tripped')
    if (decision.decision === 'declined_breaker_tripped') {
      // The operator sees WHICH budget and WHY, not "no answer".
      expect(decision.declinedForBudgetId).toBe('budget_1')
      expect(decision.breakerTrippedBecause).toContain('reached the 10000 limit')
    }
  })

  it('UNDER `allow` TOO — the flip from decline to proceed is the business end', () => {
    expect(
      decideBudget({ snapshot: tripWithSiblingTypo, receivedAt: NOW, now: NOW, policy: ALLOW }).decision
    ).toBe('declined_breaker_tripped')
  })

  it('the scoping is ONE-DIRECTIONAL: headroom does NOT survive a sibling defect', () => {
    // The asymmetry is the safety argument. A defect elsewhere in the body may
    // be exactly the reason there is no room.
    const armedWithSiblingTypo = snapshot({
      states: [armed()],
      scan: { subject: { agentId: 'agent_7' }, budgetsInScope: 1, budgetsEvaluated: 1, evaluationTruncated: 'no' as never },
    })
    expect(
      decideBudget({ snapshot: armedWithSiblingTypo, receivedAt: NOW, now: NOW, policy: DENY }).decision
    ).toBe('declined_no_answer')
  })

  it('a trip impugned IN ITS OWN STATE does not survive', () => {
    // The D2 case is unchanged: an evidence-free trip still cannot decline as a
    // trip, because the refusal points inside the trip itself.
    const evil = snapshot({ states: [{ state: 'tripped', trippedBudgetId: 'evil' } as never] })
    expect(establishedTrip(evil)).toBeUndefined()
    expect(decideBudget({ snapshot: evil, receivedAt: NOW, now: NOW, policy: DENY }).decision).toBe(
      'declined_no_answer'
    )
  })

  it('nor one contradicted by its own figures', () => {
    const unsupported = snapshot({
      states: [{ ...tripped(), determinedFrom: [reconciled(12)] } as BreakerTripped],
    })
    expect(establishedTrip(unsupported)).toBeUndefined()
  })

  it('and `states[1]` is not impugned by a finding in `states[10]`', () => {
    // Substring-matching a bare `states[1]` anchor would have made this pass
    // for the wrong reason.
    const many = snapshot({
      states: [
        ...Array.from({ length: 10 }, (_, i) => armed(1_000, { ...armed().armedLimit, budgetId: `b${i}` })),
        { ...tripped(), trippedBudgetId: 'b_trip', trippedLimit: { ...tripped().trippedLimit, budgetId: 'b_trip' },
          determinedFrom: [reconciled(10_400, 'b_trip')] } as BreakerTripped,
      ],
    })
    expect(establishedTrip(many)?.trippedBudgetId).toBe('b_trip')
  })
})

/** N3 — a bound that cannot announce itself is the shape this file exists against. */
describe('N3 — the enforcement-claim walk announces its own ceiling', () => {
  /** A body nested `depth` levels below the snapshot root. */
  function nested(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
    let node: Record<string, unknown> = leaf
    for (let i = 0; i < depth; i += 1) node = { child: node }
    return { ...(snapshot() as unknown as Record<string, unknown>), deep: node }
  }

  it('a claim within the ceiling is caught, as before', () => {
    expect(breakerSnapshotRefusals(nested(8, { enforced: true }) as never).join(' ')).toContain(
      'forbidden_enforcement_claim'
    )
  })

  it('a body TOO DEEP TO AUDIT is refused rather than silently passed', () => {
    // Previously: zero findings, no explanation, indistinguishable from clean.
    const refusals = breakerSnapshotRefusals(nested(200, { enforced: true }) as never)
    expect(refusals.join(' ')).toContain('enforcement_claim_scan_truncated')
    expect(refusals.length).toBeGreaterThan(0)
  })

  it('the truncation is reported even when nothing was found below it', () => {
    // The honest statement is about the SCAN, not about the body.
    expect(breakerSnapshotRefusals(nested(200, { harmless: true }) as never).join(' ')).toContain(
      'enforcement_claim_scan_truncated'
    )
  })

  it('and a legitimate snapshot is nowhere near the ceiling', () => {
    // Otherwise the fix would refuse ordinary traffic.
    expect(breakerSnapshotRefusals(snapshot({ states: [tripped()] }))).toEqual([])
  })
})


/**
 * N7 — the SECOND pair of instants, checked for the same impossible ordering the
 * first pair already was.
 *
 * `freshUntil <= evaluatedAt -> shelf_life_not_positive` rejects two instants
 * from ONE clock in an order that clock could not have produced. `receivedAt`
 * and `now` are the same shape one layer down — both the CLIENT's — and were
 * compared without ever being related.
 *
 * Severity is genuinely low: `BudgetGuard` stamps both from a single injected
 * clock, so the shipped path cannot reach it. It is fixed because deciding that
 * an impossible ordering is a malformity for one pair and not the other is the
 * "applied at N call sites" shape, and a rule that holds only because the one
 * caller in tree happens to be careful is not a rule — the primitive is
 * exported.
 */
describe('N7 — an impossible ordering between the two CLIENT instants', () => {
  it('an arrival stamped AFTER the check is refused, not honoured', () => {
    const decision = decideBudget({
      snapshot: snapshot(),
      receivedAt: NOW + 5_000,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('declined_no_answer')
    expect(mayProceed(decision)).toBe(false)
  })

  it('a client clock moving BACKWARD cannot extend an answer without limit', () => {
    // Same observable shape, different cause: receipt at NOW, then the clock
    // jumps back an hour before the check. Unchecked, the answer's remaining
    // life became an hour plus its shelf life.
    const decision = decideBudget({
      snapshot: snapshot({ shelfLifeMs: 1_000 }),
      receivedAt: NOW,
      now: NOW - 3_600_000,
      policy: DENY,
    })
    expect(mayProceed(decision)).toBe(false)
  })

  it('and under `allow` it is still an unavailability, not a consulted breaker', () => {
    expect(
      decideBudget({ snapshot: snapshot(), receivedAt: NOW + 5_000, now: NOW, policy: ALLOW }).decision
    ).toBe('allowed_without_answer')
  })

  it('a WELL-FORMED trip still declines as a trip — the ordering check is not a blanket null', () => {
    // The trip is identified before any of this, so a clock problem does not
    // erase a breaker we were told is blown.
    expect(
      decideBudget({
        snapshot: snapshot({ states: [tripped()] }),
        receivedAt: NOW + 5_000,
        now: NOW,
        policy: ALLOW,
      }).decision
    ).toBe('declined_breaker_tripped')
  })

  it('equality is legal — same-tick receipt and check is ordinary', () => {
    expect(
      decideBudget({ snapshot: snapshot(), receivedAt: NOW, now: NOW, policy: DENY }).decision
    ).toBe('allowed_breaker_armed')
  })

  it('the guard cannot produce it, and reports no freshness if it somehow does', () => {
    // Teeth for the claim that the shipped path is safe: one clock, both stamps.
    let clock = NOW
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => clock })
    guard.absorbSnapshot(snapshot())
    clock = NOW - 3_600_000
    expect(guard.freshnessRemainingMs()).toBeNull()
    expect(guard.mayProceedNow()).toBe(false)
  })

  it('this is the SAME rule the snapshot pair already gets, one layer up', () => {
    // The parallel, asserted rather than left in a comment: an impossible
    // ordering is a malformity for both pairs or for neither.
    expect(breakerSnapshotRefusals(snapshot({ evaluatedAt: NOW, freshUntil: NOW - 1, shelfLifeMs: 0 })).join(' '))
      .toContain('shelf_life_not_positive')
    expect(
      decideBudget({ snapshot: snapshot(), receivedAt: NOW + 1, now: NOW, policy: DENY }).decision
    ).toBe('declined_no_answer')
  })
})
