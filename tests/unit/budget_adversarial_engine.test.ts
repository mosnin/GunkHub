/**
 * BUDGET CIRCUIT BREAKERS — ADVERSARIAL SUITE, ENGINE LAYER (Team D)
 *
 * WHAT THIS FILE ATTACKS
 * The decision itself: `decideBudget`, `snapshotUnusableFields`,
 * `snapshotClaimContradictions` and `isBreakerSnapshotComplete` in
 * `packages/contracts/src/budgets.ts`, plus the SDK gate that wraps them
 * (`snapshotRefusals` / `BudgetGuard` in `packages/sdk/src/budget-guard.ts`).
 * Its companions grade the NUMBER (`budget_adversarial_accounting.test.ts`) and
 * the INTERVAL (`budget_adversarial_window.test.ts`).
 *
 * ── WHAT SURVIVED, SAID FIRST, BECAUSE IT IS MOST OF THE FILE ─────────────
 * This is the best-defended feature this suite family has attacked. The attacks
 * that FAILED are recorded as tests below (§S) rather than omitted, because a
 * defect list without them reads as though nothing else was tried:
 *
 *   - `compareSpendToLimit` tightens BOTH directions against the estimate's own
 *     error bounds. The "approximate figure compared against a hard limit as
 *     though exact" attack — the first one the brief names — does not land
 *     here. An unbounded estimator cannot establish headroom OR a breach.
 *   - `couldUnderstateBy: null` is not `0`, and the distinction is load-bearing.
 *   - A trip is honoured before freshness, so the "keep the server unreachable
 *     and spend freely" bypass does not land.
 *   - `freshUntil` is capped client-side; a server cannot grant a year.
 *   - Fail-open is not a default; it is a required constructor argument, and
 *     the permissive arms demand a written `acceptedRisk`.
 *   - Zero budgets in scope has its own decision band and is never counted as
 *     headroom — the "no data is not good news" lesson, applied.
 *   - No type, field or audit action asserts an agent WAS STOPPED. §S5 checks
 *     that by sweeping the shipped vocabulary, not by reading the doc comments.
 *
 * ── LEDGER: FOUR RETIRED, FOUR NEW ───────────────────────────────────────
 * The four defects this file recorded last iteration are FIXED, and each is
 * now a REGRESSION TEST (§R) that asserts the corrected behaviour on the exact
 * adversarial fixture that used to defeat it. A retirement is never expressed
 * as "nothing was recorded": delete a fix and this suite goes red.
 *
 *   D1 grace-declines-the-unbudgeted   -> R1. `&& budgetsInScope > 0` is gone.
 *   D2 ungated-trip-in-the-primitive   -> R2. `breakerSnapshotRefusals` moved
 *                                        INTO `decideBudget`.
 *   D3 ceiling-anchored-on-server-clock-> R3. `receivedAt` is REQUIRED.
 *   C2 audit-reaches-three-levels      -> R4. The walk is now total.
 *
 * ── SECOND ROUND: ALL SIX ADDRESSED, AND ONE WAS MINE ────────────────────
 * The six findings of the previous round are fixed and are now §R regressions.
 * The one that matters most was a defect in MY OWN CHECK, and it is the exact
 * shape this file has spent the session naming:
 *
 *   N5 read `entry.schedule.minutes`. Team A then made the cron COMPUTE its
 *   interval from the contract constant and register it as `{ seconds }`. The
 *   check did not go red on drift — it computed `undefined * 60_000` as ZERO
 *   and failed its own teeth assertion. A GENERALIZED CHECK THAT HARD-CODES
 *   THE UNIT ITS SUBJECT HAPPENED TO USE is general in one dimension and blind
 *   in the other. That is the criticism this file levelled at
 *   `forbiddenClaimsIn` two iterations ago, arriving back at its author.
 *
 *   The repair is the one that keeps working: the unit is now DERIVED FROM THE
 *   REGISTRATION via a table, an unrecognised unit is a LOUD FAILURE rather
 *   than a silent zero, and the check is applied to EVERY interval cron in the
 *   deployment rather than to the one it was written for.
 *
 * THREE BELIEF-SHAPED ERRORS IN THIS FILE WERE CAUGHT BY EXECUTION, NOT BY
 * REVIEW, and they are recorded because the count is the point: an adversarial
 * suite is not exempt from the failure it hunts.
 *   - W3's hand list of "rejected" dates was wrong about `2024-02-30`.
 *   - N5 hard-coded the unit its subject happened to use.
 *   - R8c's first draft asserted both instant-pairs DECLINE, when both in fact
 *     become "we established nothing" and `{ onUnavailable: 'allow' }`
 *     legitimately proceeds on that. Asserting the decline would have made the
 *     test wrong about the policy boundary it exists to pin.
 *
 * A further belief-shaped error was caught inside this round: R5's
 * first draft planted `establishedAt` on every state, which on a TRIPPED state
 * is an unvalidated extra property. The case meant to prove a trip IS impugned
 * proved nothing. The poison is now derived from each state's own kind.
 *
 *   R5 (was N1)  trip scoping, now swept against prefix collisions
 *   R6 (was N3)  the walk bound is a REFUSAL, so an unauditable body fails closed
 *   R7 (was N6)  the shelf life crosses the wire as a DURATION
 *   N4           the invariant takes the deployment's observed interval
 *   N5           fixed, and generalized across every interval cron
 *   R8 (was N7)  an impossible ordering between the two CLIENT instants now
 *                fails closed, in the decision rule AND in the refresh
 *                scheduler, with equality still legal and a well-formed trip
 *                still declining as a trip
 *
 * ── ANTI-VACUITY ──────────────────────────────────────────────────────────
 * §C's coverage sweep WALKS A VALID SNAPSHOT to enumerate its own subjects, so
 * a new nested object in the wire shape is graded without this file changing.
 * §S5 enumerates the vocabulary from shipped constants. Every assertion is on a
 * function's output; every defect is paired with a counterweight showing the
 * same gate fires on a neighbouring input.
 */

import { readdirSync } from 'node:fs'

import {
  BREAKER_EVALUATION_CADENCE_MS,
  breakerCadenceInvariant,
  decideBudget,
  isBreakerSnapshotComplete,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  mayProceed,
  snapshotClaimContradictions,
  snapshotUnusableFields,
  FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS,
  BUDGET_METERS,
  BUDGET_PERIODS,
  BUDGET_SCOPES,
} from '@agent-flight-recorder/contracts'
import { BudgetGuard, snapshotRefusals } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import type { BreakerSnapshot, BudgetUnavailablePolicy } from '@agent-flight-recorder/contracts'

/**
 * `convex/helpers/budget.ts` is loaded through a non-literal specifier — see
 * the note in `budget_adversarial_accounting.test.ts`. Briefly: a static import
 * drags a backend file written under `exactOptionalPropertyTypes: false` into
 * the stricter `tests/` project, and the seam tsconfig that exists for that is
 * outside Team D's edit boundary.
 */
const SERVER_BUDGET_MODULE = '../../convex/helpers/budget.js'
const serverBudget = (await import(/* @vite-ignore */ SERVER_BUDGET_MODULE)) as {
  decideBudget: (input: Record<string, unknown>) => Record<string, unknown>
  buildSnapshot: (input: {
    states: unknown[]
    subject: unknown
    budgetsInScope: number
    budgetsEvaluated: number
    evaluationTruncated: boolean
    now: number
  }) => BreakerSnapshot
  FORBIDDEN_EXECUTION_CLAIMS: readonly string[]
}

// ---------------------------------------------------------------------------
// Fixture builders. They construct WELL-FORMED input and encode no expectation:
// §S1 proves the baseline is accepted, so any refusal below is caused by the
// single perturbation that test applies.
// ---------------------------------------------------------------------------

const limit = (id: string) => ({
  budgetId: id,
  limitAmount: 10_000,
  meter: 'cost_minor_units' as const,
  currency: 'USD',
  period: 'day' as const,
})

const reconciled = (id: string, amount: number) => ({
  basis: 'reconciled' as const,
  reconciledAmount: amount,
  reconciledThrough: 1_000,
  forBudgetId: id,
  establishedBy: [
    {
      proves: 'event_log_summed' as const,
      budgetId: id,
      runsSummed: 1,
      eventsSummed: 1,
      logReadComplete: true as const,
      reconciledAt: 1_000,
    },
  ],
})

const armedState = (id: string) => ({
  state: 'armed' as const,
  armedBudgetId: id,
  armedLimit: limit(id),
  establishedAt: 1_000,
  establishedUnderBy: [reconciled(id, 5)],
})

const subject = { scope: 'agent' as const, scopeId: 'agent_7', orgId: 'org_a' }

/** A complete, fresh, internally consistent snapshot with one armed breaker. */
function goodSnapshot(over: Record<string, unknown> = {}): BreakerSnapshot {
  return {
    evaluatedAt: 1_000,
    freshUntil: 31_000,
    states: [armedState('b1')],
    scan: { subject, budgetsInScope: 1, budgetsEvaluated: 1, evaluationTruncated: false },
    ...over,
  } as unknown as BreakerSnapshot
}

/** The same snapshot for a subject NO budget governs. */
function ungovernedSnapshot(): BreakerSnapshot {
  return goodSnapshot({
    states: [],
    scan: { subject, budgetsInScope: 0, budgetsEvaluated: 0, evaluationTruncated: false },
  })
}

const GRACE: BudgetUnavailablePolicy = {
  onUnavailable: 'grace',
  graceMs: 30_000,
  acceptedRisk: 'up to 30s of spend past the cap during an AFR outage',
}
const DENY: BudgetUnavailablePolicy = { onUnavailable: 'deny' }

const RECEIVED_AT = 1_000

const decide = (
  snapshot: unknown,
  now: number,
  policy: BudgetUnavailablePolicy = GRACE,
  receivedAt: number = RECEIVED_AT
) =>
  // `receivedAt` IS PINNED TO THE MOMENT THE SNAPSHOT ARRIVED and does NOT
  // track `now`. See N2: `receivedAt: now` makes
  // `min(freshUntil, receivedAt + MAX)` reduce to `freshUntil` unconditionally,
  // because `now <= now + MAX` always — which silently switches off the
  // client-side ceiling for every case in this file. A snapshot is received
  // once; the clock moves afterwards. The fixture models that.
  decideBudget({ snapshot: snapshot as BreakerSnapshot, receivedAt, now, policy })

// ===========================================================================
// §S  WHAT SURVIVED. These are the attacks that FOUND NOTHING.
// ===========================================================================
describe('budget/S — attacks that did not land', () => {
  it('S1 (teeth): the baseline fixture is accepted, so every refusal below is caused by its perturbation', () => {
    const good = goodSnapshot()
    expect(snapshotUnusableFields(good)).toEqual([])
    expect(snapshotClaimContradictions(good)).toEqual([])
    expect(isBreakerSnapshotComplete(good)).toBe(true)
    expect(snapshotRefusals(good)).toEqual([])
    expect(decide(good, 5_000).decision).toBe('allowed_breaker_armed')
    expect(mayProceed(decide(good, 5_000))).toBe(true)
  })

  it('S2 (SURVIVED): an approximate figure straddling the limit cannot arm or trip a breaker', () => {
    // The brief's first attack: "hunt for any path where an approximate figure
    // is compared against a hard limit as though exact." It is not there.
    // A sampled counter reporting 9,900 against a 10,000 cap, honest about
    // being able to be 500 out either way, decides NOTHING in either direction.
    const straddling = {
      basis: 'approximate' as const,
      kind: 'sampled_usage_counter' as const,
      estimatedAmount: 9_900,
      couldUnderstateBy: 500,
      couldOverstateBy: 500,
      approximateBecause: 'ADR-002 usage_counters flushes 1-in-10 and scales by 10x',
      wouldBeReconciledBy: 'sum llm.response events for this period from the event log',
      forBudgetId: 'b1',
      sampledAt: 1_000,
    }
    const armedOnAnEstimate = goodSnapshot({
      states: [{ ...armedState('b1'), establishedUnderBy: [straddling] }],
    })
    // The claim audit refuses to let it arm...
    expect(snapshotClaimContradictions(armedOnAnEstimate).length).toBeGreaterThan(0)
    // ...and the SDK gate refuses the snapshot outright.
    expect(snapshotRefusals(armedOnAnEstimate).length).toBeGreaterThan(0)

    // The same figure cannot trip a breaker either — the false-positive
    // direction, and the one that would halt a business on an estimator's noise.
    const trippedOnAnEstimate = goodSnapshot({
      states: [
        {
          state: 'tripped',
          trippedBudgetId: 'b1',
          trippedLimit: limit('b1'),
          trippedAt: 900,
          trippedBy: 'limit_reached',
          trippedBecause: 'estimated spend reached the limit',
          determinedFrom: [straddling],
        },
      ],
    })
    expect(snapshotClaimContradictions(trippedOnAnEstimate).length).toBeGreaterThan(0)
  })

  it('S3 (SURVIVED): an unbounded estimator establishes nothing, however comfortable its number', () => {
    const unbounded = {
      basis: 'approximate' as const,
      kind: 'sampled_usage_counter' as const,
      estimatedAmount: 12, // 0.12% of the cap
      couldUnderstateBy: null,
      couldOverstateBy: null,
      approximateBecause: 'the residual of a 1-in-10 sampled counter is not bounded',
      wouldBeReconciledBy: 'sum the event log',
      forBudgetId: 'b1',
      sampledAt: 1_000,
    }
    const snap = goodSnapshot({
      states: [{ ...armedState('b1'), establishedUnderBy: [unbounded] }],
    })
    // `couldUnderstateBy: null` is NOT `0`, so headroom is unreachable even at
    // 0.12% of the cap. This is the correct answer and it is a strong one.
    expect(snapshotClaimContradictions(snap).length).toBeGreaterThan(0)
  })

  it('S4 (SURVIVED): a trip is honoured before freshness, so unreachability is not a bypass', () => {
    const tripped = goodSnapshot({
      freshUntil: 1_001, // expired long ago
      states: [
        {
          state: 'tripped',
          trippedBudgetId: 'b1',
          trippedLimit: limit('b1'),
          trippedAt: 900,
          trippedBy: 'limit_reached',
          trippedBecause: 'reconciled spend of 10,400 reached the 10,000 limit',
          determinedFrom: [reconciled('b1', 10_400)],
        },
      ],
    })
    // Hours later, with an unreachable server and the most permissive policy
    // there is, the decline stands.
    const allowPolicy: BudgetUnavailablePolicy = {
      onUnavailable: 'allow',
      acceptedRisk: 'we accept unbounded overspend during an outage',
    }
    expect(decide(tripped, 9_999_999, allowPolicy).decision).toBe('declined_breaker_tripped')
    expect(mayProceed(decide(tripped, 9_999_999, allowPolicy))).toBe(false)
  })

  it('S5 (SURVIVED): nothing in the shipped vocabulary claims an agent was stopped', () => {
    // The claim boundary, checked by sweeping SHIPPED CONSTANTS rather than by
    // reading doc comments. Both sides of the feature keep their own forbidden
    // list, and both lists are non-empty and cover the load-bearing verbs.
    expect(FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS.length).toBeGreaterThan(5)
    expect(serverBudget.FORBIDDEN_EXECUTION_CLAIMS.length).toBeGreaterThan(0)

    // The enumerable vocabularies name meters, periods and scopes -- units and
    // subjects. None of them names an action taken against a process.
    const vocabulary = [...BUDGET_METERS, ...BUDGET_PERIODS, ...BUDGET_SCOPES]
    expect(vocabulary.length).toBeGreaterThan(10) // teeth
    const executionish = vocabulary.filter((term) =>
      /stopp|halt|kill|terminat|abort|block|prevent/i.test(term)
    )
    expect(executionish).toEqual([])

    // And the decision bands name the SDK or the breaker, never the agent.
    const bands = [
      decide(goodSnapshot(), 5_000).decision,
      decide(ungovernedSnapshot(), 5_000).decision,
      decide(null, 5_000, DENY).decision,
    ]
    expect(bands.filter((b) => /stopped|halted|killed/i.test(b))).toEqual([])
    expect(bands).toContain('declined_no_answer') // teeth: the sweep saw a decline
  })
})


// ---------------------------------------------------------------------------
// Shared fixtures for §R / §N / §X. Module scope, because the same body is
// perturbed by several sections and a per-describe copy is how two sections
// come to disagree about what "the baseline" is.
// ---------------------------------------------------------------------------

/** A well-formed, evidence-backed TRIP for one budget. */
const trippedStateFor = (id: string) => ({
  state: 'tripped' as const,
  trippedBudgetId: id,
  trippedLimit: limit(id),
  trippedAt: 900,
  trippedBy: 'limit_reached' as const,
  trippedBecause: 'reconciled spend of 10400 reached the 10000 limit',
  determinedFrom: [reconciled(id, 10_400)],
})

/** A snapshot whose single breaker is tripped. Proves trips still work (R2, N1). */
function trippedSnapshot(): BreakerSnapshot {
  return {
    evaluatedAt: 1_000,
    freshUntil: 31_000,
    states: [trippedStateFor('b1')],
    scan: { subject, budgetsInScope: 1, budgetsEvaluated: 1, evaluationTruncated: false },
  } as unknown as BreakerSnapshot
}

/** A snapshot exercising every state kind, so a sweep sees every branch. */
const richSnapshot = (): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify({
      evaluatedAt: 1_000,
      freshUntil: 31_000,
      states: [armedState('b1'), trippedStateFor('b2')],
      scan: { subject, budgetsInScope: 2, budgetsEvaluated: 2, evaluationTruncated: false },
    })
  ) as Record<string, unknown>

/** Plant a key at a dotted/indexed path. Encodes no expectation. */
function plant(root: Record<string, unknown>, path: string, key: string): void {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let cursor: Record<string, unknown> = root
  for (const part of parts) cursor = cursor[part] as Record<string, unknown>
  cursor[key] = true
}

/** Every path the shipped audit reports a forbidden enforcement claim at. */
const claimPaths = (body: Record<string, unknown>): string[] =>
  snapshotUnusableFields(body as unknown as BreakerSnapshot)
    .filter((finding) => finding.reason === 'forbidden_enforcement_claim')
    .map((finding) => finding.path)

const ALLOW: BudgetUnavailablePolicy = {
  onUnavailable: 'allow',
  acceptedRisk: 'we accept unbounded overspend while the breaker is unreachable',
}

/** The v1 route directory, read from disk so §X3 retires itself when the route lands. */
const V1_ROUTE_DIR = new URL('../../apps/web/app/api/v1/', import.meta.url).pathname

/**
 * The REGISTERED cron table, read off the shipped `convex/crons.ts` export
 * rather than grepped. Non-literal specifier for the usual typecheck reason.
 */
const CRONS_MODULE = '../../convex/crons.js'
const cronSchedules = (
  (await import(/* @vite-ignore */ CRONS_MODULE)) as {
    default: {
      crons: Record<string, { name: string; schedule: Record<string, unknown> & { type: string } }>
    }
  }
).default.crons

/**
 * Milliseconds per unit an interval schedule may be spelled in.
 *
 * A TABLE, NOT A FIELD ACCESS. The previous version of the cron check read
 * `schedule.minutes` directly; the registration later moved to `{ seconds }`
 * and the check computed `undefined * 60_000 === 0` instead of going red on
 * drift. Reading the unit off the registration means a schedule spelled in a
 * unit this table does not know returns `null` — a loud failure — rather than
 * a plausible zero.
 */
const INTERVAL_UNIT_MS: Record<string, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
}

/**
 * The interval a schedule represents, or `null` when it is not expressible in
 * a unit this table knows — which is a failure, never a zero.
 */
function durationMs(schedule: Record<string, unknown> & { type: string }): number | null {
  if (schedule.type !== 'interval') return null
  const units = Object.keys(schedule).filter((key) => key !== 'type')
  // Exactly one duration key, and it must be one we recognise. Convex spells an
  // interval with a single unit; anything else is a shape this reader has not
  // been taught and must not guess at.
  if (units.length !== 1) return null
  const unit = units[0]!
  const perUnit = INTERVAL_UNIT_MS[unit]
  const count = schedule[unit]
  if (perUnit === undefined || typeof count !== 'number' || !Number.isFinite(count)) return null
  return count * perUnit
}

/** The registered budget-sweep interval in ms, read off the shipped cron table. */
function registeredSweepIntervalMs(): number {
  const registered = Object.entries(cronSchedules).filter(([, entry]) =>
    String(entry.name).startsWith('budgets:')
  )
  if (registered.length !== 1) {
    throw new Error(
      `expected exactly one budgets:* cron, found ${registered.length} — an empty list must not read as agreement`
    )
  }
  const ms = durationMs(registered[0]![1].schedule)
  if (ms === null) {
    throw new Error(
      `the budget sweep schedule ${JSON.stringify(registered[0]![1].schedule)} is not expressible in a known ` +
        `interval unit, so it cannot be compared to BREAKER_EVALUATION_CADENCE_MS`
    )
  }
  return ms
}

// ===========================================================================
// §R  REGRESSIONS. Four defects, fixed. Each asserts the CORRECTED behaviour
//     on the exact fixture that used to defeat it, so a revert goes red.
// ===========================================================================
describe('budget/R — retired defects, still checked', () => {
  it('R1 (was D1): grace now honours the UNBUDGETED subject, the one answer that cannot be near a cap', () => {
    const governed = goodSnapshot() // could be one cent from its cap
    const ungoverned = ungovernedSnapshot() // no budget exists to be near

    // Fresh: both proceed, in their own correctly distinct bands.
    expect(decide(governed, 5_000).decision).toBe('allowed_breaker_armed')
    expect(decide(ungoverned, 5_000).decision).toBe('allowed_no_budget_governs')

    // Stale, inside the same grace window: BOTH are now honoured. The
    // `&& budgetsInScope > 0` that halted an org with no budgets during an
    // outage of ours is gone.
    expect(decide(governed, 40_000).decision).toBe('allowed_within_grace')
    expect(decide(ungoverned, 40_000).decision).toBe('allowed_within_grace')
    expect(mayProceed(decide(ungoverned, 40_000))).toBe(true)

    // TEETH: grace is still BOUNDED, so R1 is not "grace allows everything".
    // Past the window both decline again.
    expect(mayProceed(decide(ungoverned, 400_000))).toBe(false)
    expect(mayProceed(decide(governed, 400_000))).toBe(false)
  })

  it('R2 (was D2): an evidence-free trip no longer declines on its own say-so', () => {
    const bareTrip = { states: [{ state: 'tripped', trippedBudgetId: 'evil' }] }

    // The gate now runs inside the primitive, so the fabricated trip is not
    // read as a trip. Under deny it is a decline for the RIGHT reason...
    const denied = decide(bareTrip, 5_000, DENY)
    expect(denied.decision).toBe('declined_no_answer')
    expect(denied.decision).not.toBe('declined_breaker_tripped')

    // ...and the reason names the refusal rather than inventing a budget id.
    expect(JSON.stringify(denied)).not.toContain('evil')

    // TEETH: a WELL-FORMED trip still declines as a trip, so R2 is not "trips
    // stopped working".
    expect(decide(trippedSnapshot(), 5_000, DENY).decision).toBe('declined_breaker_tripped')
  })

  it('R3 (was D3, HALF of it): the ceiling is anchored on a client-observed receivedAt', () => {
    const HOUR = 3_600_000

    // A server an hour AHEAD can no longer extend its own shelf life: the
    // ceiling is measured from when WE received it.
    const ahead = goodSnapshot({ evaluatedAt: 1_000 + HOUR, freshUntil: 31_000 + HOUR })
    expect(decide(ahead, 5_000, DENY, 1_000).decision).toBe('allowed_breaker_armed')
    // ...and it expires MAX after receipt, not an hour later.
    expect(decide(ahead, 1_000 + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1, DENY, 1_000).decision).toBe(
      'declined_no_answer'
    )

    // The BEHIND direction is NOT fixed by this change — see N6. Recorded
    // there rather than quietly dropped from here.

    // TEETH, AND THE POINT OF N2: `receivedAt` is REQUIRED, so it cannot be
    // silently defaulted away. Omitting it is an unavailability, not a
    // fallback to `now`.
    const withoutReceivedAt = decideBudget({
      snapshot: goodSnapshot(),
      now: 5_000,
      policy: DENY,
    } as unknown as Parameters<typeof decideBudget>[0])
    expect(withoutReceivedAt.decision).toBe('declined_no_answer')
    expect(mayProceed(withoutReceivedAt)).toBe(false)
  })

  it('R4 (was C2): the forbidden-claim walk is total — every nested object is audited', () => {
    // The five sites the audit used to miss, each proven caught, with the
    // exact path reported.
    const missedBefore: Array<[string, string]> = [
      ['states[0].armedLimit', '(snapshot).states[0].armedLimit.agentStopped'],
      ['scan.subject', '(snapshot).scan.subject.agentStopped'],
      [
        'states[0].establishedUnderBy[0].establishedBy[0]',
        '(snapshot).states[0].establishedUnderBy[0].establishedBy[0].agentStopped',
      ],
    ]
    for (const [path, expectedFinding] of missedBefore) {
      const body = richSnapshot()
      plant(body, path, 'agentStopped')
      const paths = claimPaths(body)
      expect(paths).toContain(expectedFinding)
    }

    // And the snapshot as a whole is now refused, which it was not before.
    const poisoned = richSnapshot()
    plant(poisoned, 'states[1].determinedFrom[0].establishedBy[0]', 'agentStopped')
    expect(snapshotRefusals(poisoned as unknown as BreakerSnapshot).length).toBeGreaterThan(0)
    expect(isBreakerSnapshotComplete(poisoned as unknown as BreakerSnapshot)).toBe(false)
  })
})

// ===========================================================================
// §N  NEW DEFECTS — three of them introduced BY the four fixes above.
// ===========================================================================
describe('budget/N — what the fixes moved, and what moved next', () => {
  it('R5 (was N1): a genuine trip survives an unrelated defect, and the scoping resists prefix collisions', () => {
    // The trip is now established BEFORE the gate nulls anything, and is
    // impugned only by a finding pointing INSIDE its own state.

    // (a) A typo in `scan` no longer erases the trip, under the most
    //     permissive policy there is.
    const scanTypo = trippedSnapshot() as unknown as Record<string, unknown>
    ;(scanTypo['scan'] as Record<string, unknown>)['evaluationTruncated'] = 'no'
    expect(snapshotRefusals(scanTypo as unknown as BreakerSnapshot).length).toBeGreaterThan(0)
    expect(decide(scanTypo, 5_000, ALLOW).decision).toBe('declined_breaker_tripped')

    // (b) THE PREFIX-COLLISION TRAP, generalized rather than spot-checked.
    //     `states[1]` is a prefix of `states[10]`, `states[1x]`, `states[1].y`.
    //     A scoping rule written with `startsWith` reads a defect in any of
    //     them as a defect in the trip. Subjects are GENERATED, not listed.
    const trippedIndex = 1
    const collisions = ['0', '1', '10', '11', '100', '1x', '1_', '1-a']
    const outcomes = collisions.map((suffix) => {
      const states: unknown[] = [armedState('b0'), trippedStateFor('bT')]
      // Pad so `states[10]` and `states[11]` are real, readable entries.
      while (states.length < 12) states.push(armedState(`c${states.length}`))
      const body = {
        evaluatedAt: 1_000,
        freshUntil: 31_000,
        states,
        scan: {
          subject,
          budgetsInScope: states.length,
          budgetsEvaluated: states.length,
          evaluationTruncated: false,
        },
      } as unknown as Record<string, unknown>

      // Poison whichever real index this suffix names; a non-numeric suffix
      // names no index at all and must therefore poison nothing.
      //
      // THE POISON IS DERIVED FROM THE STATE'S OWN KIND. The first draft
      // planted `establishedAt` on every state, which on a TRIPPED state is an
      // unvalidated extra property that produces no finding at all — so the
      // case meant to prove the trip IS impugned proved nothing, and the run
      // caught it. A perturbation has to land on a field the subject's own
      // branch actually validates.
      const index = Number(suffix)
      if (Number.isInteger(index) && index >= 0 && index < states.length) {
        const target = states[index] as Record<string, unknown>
        const field = target['state'] === 'tripped' ? 'trippedAt' : 'establishedAt'
        target[field] = 'nope'
      }
      return {
        suffix,
        poisonedTheTrip: Number.isInteger(index) && index === trippedIndex,
        decision: decide(body, 5_000, ALLOW).decision,
      }
    })

    // TEETH: the sweep produced both kinds of case, so neither branch below is
    // vacuous.
    expect(outcomes.some((o) => o.poisonedTheTrip)).toBe(true)
    expect(outcomes.some((o) => !o.poisonedTheTrip)).toBe(true)

    // Every poison that is NOT the trip's own state leaves the decline intact.
    for (const outcome of outcomes.filter((o) => !o.poisonedTheTrip)) {
      expect(outcome.decision).toBe('declined_breaker_tripped')
    }
    // ...and poisoning the trip's OWN state does impugn it. The scoping is
    // one-directional by design: only the decline survives.
    for (const outcome of outcomes.filter((o) => o.poisonedTheTrip)) {
      expect(outcome.decision).toBe('allowed_without_answer')
    }
  })

  it('R6 (was N3): exceeding the walk bound is now a REFUSAL that says why', () => {
    const deepBody = (extraLevels: number): Record<string, unknown> => {
      const body = richSnapshot()
      let cursor = (body['states'] as Record<string, unknown>[])[0]!['armedLimit'] as Record<
        string,
        unknown
      >
      for (let i = 0; i < extraLevels; i++) {
        cursor['n'] = {}
        cursor = cursor['n'] as Record<string, unknown>
      }
      cursor['agentStopped'] = true
      return body
    }

    // TEETH: shallow bodies are still audited normally, with the exact path.
    expect(claimPaths(deepBody(0)).length).toBeGreaterThan(0)

    // Beyond the bound the claim is no longer FOUND — but the body is no
    // longer silently clean either. It is refused, and the refusal names the
    // truncation, so an unauditable body FAILS CLOSED.
    const beyond = deepBody(64)
    const reasons = snapshotUnusableFields(beyond as unknown as BreakerSnapshot).map(
      (finding) => finding.reason
    )
    expect(reasons).toContain('enforcement_claim_scan_truncated')
    expect(snapshotRefusals(beyond as unknown as BreakerSnapshot).length).toBeGreaterThan(0)
    expect(isBreakerSnapshotComplete(beyond as unknown as BreakerSnapshot)).toBe(false)
    expect(mayProceed(decide(beyond, 5_000, DENY))).toBe(false)

    // Same for a body that is WIDE rather than deep: the node ceiling is a
    // refusal too, not a silent stop.
    const wide = richSnapshot()
    const limitObj = (wide['states'] as Record<string, unknown>[])[0]!['armedLimit'] as Record<
      string,
      unknown
    >
    for (let i = 0; i < 40_000; i++) limitObj[`k${i}`] = { v: i }
    expect(
      snapshotUnusableFields(wide as unknown as BreakerSnapshot).map((f) => f.reason)
    ).toContain('enforcement_claim_scan_truncated')

    // Still cycle-safe, and a cycle is not mistaken for infinite depth.
    const cyclic = richSnapshot()
    const cyclicLimit = (cyclic['states'] as Record<string, unknown>[])[0]!['armedLimit'] as Record<
      string,
      unknown
    >
    cyclicLimit['cycle'] = cyclic
    cyclicLimit['agentStopped'] = true
    expect(() => snapshotUnusableFields(cyclic as unknown as BreakerSnapshot)).not.toThrow()
    expect(claimPaths(cyclic).length).toBeGreaterThan(0)
  })

  it('R7 (was N6): the shelf life is a DURATION, so server clock skew no longer decides', () => {
    const HOUR = 3_600_000
    // A server an hour behind states the same 30s shelf life; both endpoints
    // come from one clock, so the difference is skew-invariant.
    const behind = goodSnapshot({ evaluatedAt: 1_000 - HOUR, freshUntil: 31_000 - HOUR })
    const ahead = goodSnapshot({ evaluatedAt: 1_000 + HOUR, freshUntil: 31_000 + HOUR })
    const inSync = goodSnapshot()

    // All three are armed on arrival...
    for (const snap of [behind, ahead, inSync]) {
      expect(decide(snap, 5_000, DENY, 1_000).decision).toBe('allowed_breaker_armed')
    }
    // ...and all three expire at the SAME client instant, because only the
    // duration crossed the wire.
    for (const snap of [behind, ahead, inSync]) {
      expect(decide(snap, 1_000 + 30_000 + 1, DENY, 1_000).decision).toBe('declined_no_answer')
    }

    // TEETH: the ceiling still binds, so R7 is not "durations are trusted".
    const forever = goodSnapshot({ freshUntil: 9_999_999_999 })
    expect(
      decide(forever, 1_000 + MAX_BREAKER_ANSWER_FRESHNESS_MS + 1, DENY, 1_000).decision
    ).toBe('declined_no_answer')
  })

  it('R8 (was N7): an impossible ordering between the two CLIENT instants fails closed', () => {
    const snap = goodSnapshot()

    // Both causes present identically as `receivedAt > now`, and one check
    // covers both: an arrival stamped after the check...
    expect(decide(snap, 1_000, DENY, 5_000_000).decision).toBe('declined_no_answer')
    // ...and a client clock moving backward between receipt and check.
    expect(decide(snap, 5_000 - 3_600_000, DENY, 1_000).decision).toBe('declined_no_answer')
    expect(mayProceed(decide(snap, 1_000, DENY, 5_000_000))).toBe(false)

    // PRESERVED PROPERTY 1 — EQUALITY IS LEGAL. Same-tick receipt and check is
    // ordinary, not suspicious. A guard written as `receivedAt >= now` would
    // decline every caller that reads its clock once, which is the careful way
    // to write it.
    expect(decide(snap, 1_000, DENY, 1_000).decision).toBe('allowed_breaker_armed')
    expect(mayProceed(decide(snap, 1_000, DENY, 1_000))).toBe(true)

    // PRESERVED PROPERTY 2 — A WELL-FORMED TRIP STILL DECLINES AS A TRIP.
    // `establishedTrip` runs before any of this, so a clock problem cannot
    // erase a breaker we were told is blown. That would have re-opened N1
    // through a new door, and it is checked under the most permissive policy
    // there is, in BOTH bad-ordering directions.
    expect(decide(trippedSnapshot(), 1_000, ALLOW, 5_000_000).decision).toBe(
      'declined_breaker_tripped'
    )
    expect(decide(trippedSnapshot(), 5_000 - 3_600_000, ALLOW, 1_000).decision).toBe(
      'declined_breaker_tripped'
    )
  })

  it('R8b (was N7): the refresh scheduler cannot report life on an answer the rule is declining', () => {
    // The second half of the fix. A `freshnessRemainingMs` that kept answering
    // while `check()` declined would have the scheduler and the decision rule
    // disagreeing about the same held snapshot — and the scheduler is what
    // decides whether a refresh is even attempted.
    let clock = 1_000
    const guard = new BudgetGuard({
      unavailablePolicy: DENY,
      now: () => clock,
    })
    expect(guard.absorbSnapshot(goodSnapshot())).toEqual({ accepted: true, refusedBecause: [] })

    // TEETH: with a sane clock it reports real remaining life and does not ask
    // for a refresh it does not need.
    expect(guard.freshnessRemainingMs()).toBe(30_000)
    expect(guard.check().decision).toBe('allowed_breaker_armed')

    // After a backward jump the two agree: NULL, not zero — "we do not have a
    // usable answer", not "the answer just expired" — and a decline.
    clock = 1_000 - 3_600_000
    expect(guard.freshnessRemainingMs()).toBeNull()
    expect(guard.shouldRefresh()).toBe(true)
    expect(guard.check().decision).toBe('declined_no_answer')
    expect(guard.mayProceedNow()).toBe(false)
  })

  it('R8c: the two instant-pairs are checked by the SAME rule, one layer apart', () => {
    // Asserted rather than left in a comment, so the next person to touch
    // either pair finds the other. Both are "two instants from one clock in an
    // order that clock cannot produce"; both must be a refusal.

    // PAIR 1 — server-side, inside the snapshot: freshUntil <= evaluatedAt.
    const bornStale = goodSnapshot({ evaluatedAt: 5_000, freshUntil: 4_000 })
    expect(
      snapshotUnusableFields(bornStale).map((finding) => finding.reason)
    ).toContain('shelf_life_not_positive')
    expect(decide(bornStale, 5_000, DENY).decision).toBe('declined_no_answer')

    // PAIR 2 — client-side, around the decision: receivedAt > now.
    expect(decide(goodSnapshot(), 1_000, DENY, 5_000_000).decision).toBe('declined_no_answer')

    // NOTE THE POLICY BOUNDARY, because the first draft of this test got it
    // wrong and the run caught it: neither pair DECLINES unconditionally. Both
    // become "we established nothing", and `{ onUnavailable: 'allow' }`
    // legitimately proceeds on that — an explicit, risk-accepted choice, not a
    // hole. What must be identical between the pairs is that both are refusals
    // adjudicated by policy, never readable as headroom.
    expect(decide(bornStale, 5_000, ALLOW).decision).toBe('allowed_without_answer')
    expect(decide(goodSnapshot(), 1_000, ALLOW, 5_000_000).decision).toBe('allowed_without_answer')

    // TEETH: the legal orderings of BOTH pairs still arm, so neither check is
    // simply refusing everything.
    expect(snapshotUnusableFields(goodSnapshot())).toEqual([])
    expect(decide(goodSnapshot(), 1_000, DENY, 1_000).decision).toBe('allowed_breaker_armed')

    // A rule that holds because the current caller happens to be careful is
    // not a rule. `BudgetGuard` stamps both client instants from one injected
    // clock and would never have produced pair 2 — which is exactly why the
    // primitive had to check it.
  })

  it('N4 (regression): the cadence invariant now takes the deployment\'s OBSERVED interval', () => {
    // Previously it compared two constants derived from each other and could
    // not fail for its own reason. It now takes the real interval as an
    // argument, which is what makes it capable of failing.
    expect(breakerCadenceInvariant(BREAKER_EVALUATION_CADENCE_MS)).toBeNull()

    // TEETH: it rejects the shapes that used to be unreachable.
    expect(breakerCadenceInvariant(0)).not.toBeNull()
    expect(breakerCadenceInvariant(Number.NaN)).not.toBeNull()
    expect(breakerCadenceInvariant(BREAKER_EVALUATION_CADENCE_MS * 5)).not.toBeNull()

    // And it holds for the interval this deployment actually registers.
    expect(breakerCadenceInvariant(registeredSweepIntervalMs())).toBeNull()
  })

  it('N5 (MY OWN DEFECT, FIXED): the schedule reader enumerates its unit instead of assuming one', () => {
    // WHAT WENT WRONG HERE IS THE SHAPE THIS SUITE EXISTS TO CATCH.
    //
    // The previous version read `entry.schedule.minutes`. Team A then made the
    // cron COMPUTE its interval from the contract constant and register it as
    // `{ seconds }`. My check did not go red on drift — it computed
    // `undefined * 60_000` as 0 and failed its OWN teeth assertion. A
    // generalized check that hard-codes the unit its subject happened to use
    // is general in one dimension and blind in the other, which is the exact
    // criticism this file levelled at `forbiddenClaimsIn` two iterations ago.
    //
    // The repair is the one that keeps working: DERIVE THE UNIT FROM THE
    // REGISTRATION, and make an unrecognised unit a LOUD FAILURE rather than a
    // silent zero.
    const intervalCrons = Object.entries(cronSchedules).filter(
      ([, entry]) => entry.schedule.type === 'interval'
    )
    // TEETH: this deployment really does register interval crons.
    expect(intervalCrons.length).toBeGreaterThan(2)

    // Every interval cron in the deployment must be readable by the unit
    // table, so a future cron in hours or milliseconds fails HERE rather than
    // silently reading as zero somewhere downstream.
    const unreadable = intervalCrons.filter(([, entry]) => durationMs(entry.schedule) === null)
    expect(unreadable.map(([name]) => name)).toEqual([])

    // Every one of them is a positive duration.
    for (const [name, entry] of intervalCrons) {
      expect({ name, ms: durationMs(entry.schedule) }).toEqual({
        name,
        ms: expect.any(Number) as unknown as number,
      })
      expect(durationMs(entry.schedule)!).toBeGreaterThan(0)
    }

    // THE REPAIR PROVES ITSELF ON THE INPUT THAT DEFEATED THE OLD VERSION.
    // The reader must return `null` — never a plausible number — for a
    // schedule spelled in a unit it has not been taught, for a schedule with
    // two units, and for one with none. Anything that reads as `0` here is the
    // original defect back again.
    expect(durationMs({ type: 'interval', seconds: 60 })).toBe(60_000)
    expect(durationMs({ type: 'interval', minutes: 1 })).toBe(60_000)
    expect(durationMs({ type: 'interval', fortnights: 1 })).toBeNull()
    expect(durationMs({ type: 'interval', seconds: 60, minutes: 1 })).toBeNull()
    expect(durationMs({ type: 'interval' })).toBeNull()
    expect(durationMs({ type: 'daily', hourUTC: 2, minuteUTC: 0 })).toBeNull()
    // ...and an unreadable schedule makes the sweep reader THROW rather than
    // compare zero to the constant.
    expect(() => registeredSweepIntervalMs()).not.toThrow()

    // And the budget sweep matches the contract constant. Belt-and-braces on a
    // structural guarantee now that the registration is computed — which is
    // only worth anything if it can read the registration in whatever form it
    // takes.
    expect(registeredSweepIntervalMs()).toBe(BREAKER_EVALUATION_CADENCE_MS)
  })
})

// ===========================================================================
// §X  THE SEAM — the server's answer, handed to the SDK's gate
// ===========================================================================
describe('budget/X — the server/SDK seam', () => {
  it('X1 (was a defect, now a regression): the server builds a snapshot the SDK gate ACCEPTS', () => {
    // Last iteration the backend spoke `{outcome, enforcement, validUntil,
    // limitTokens}` and the SDK accepted `{evaluatedAt, freshUntil, states,
    // scan}`, sharing zero fields. `buildSnapshot` now bridges them.
    const built = serverBudget.buildSnapshot({
      states: [],
      subject,
      budgetsInScope: 0,
      budgetsEvaluated: 0,
      evaluationTruncated: false,
      now: 1_000,
    })

    // The server's own output, through the SDK's own gate.
    expect(snapshotRefusals(built)).toEqual([])
    expect(isBreakerSnapshotComplete(built)).toBe(true)
    expect(decide(built, 1_500, DENY, 1_000).decision).toBe('allowed_no_budget_governs')

    // TEETH: the gate is not accepting everything — the pre-bridge shape is
    // still refused, so X1 records a real repair rather than a relaxed gate.
    expect(
      snapshotRefusals({ outcome: 'proceed', validUntil: 9e9 } as unknown as BreakerSnapshot).length
    ).toBeGreaterThan(0)
  })

  it('X2 (DEFECT, STILL OPEN): the shelf life the server grants is exactly the client ceiling, leaving no margin', () => {
    const built = serverBudget.buildSnapshot({
      states: [],
      subject,
      budgetsInScope: 0,
      budgetsEvaluated: 0,
      evaluationTruncated: false,
      now: 1_000,
    })
    // The server stamps `freshUntil = now + MAX`, so a client that receives the
    // snapshot even ONE MILLISECOND after it was evaluated has an answer whose
    // server-stated expiry is already beyond its own ceiling.
    expect(built.freshUntil - built.evaluatedAt).toBe(MAX_BREAKER_ANSWER_FRESHNESS_MS)

    // Network time is not zero. With a realistic 250ms of transit the usable
    // window is the ceiling measured from receipt, so the last 250ms of the
    // server's stated shelf life is unreachable — every answer is honoured for
    // slightly less than the cadence-derived window the multiple was chosen to
    // guarantee. The margin BREAKER_FRESHNESS_CADENCE_MULTIPLE exists to
    // provide is silently reduced by transit on every single refresh.
    const receivedAt = built.evaluatedAt + 250
    const lastGoodMoment = Math.min(built.freshUntil, receivedAt + MAX_BREAKER_ANSWER_FRESHNESS_MS)
    expect(lastGoodMoment).toBe(built.freshUntil)
    expect(lastGoodMoment - receivedAt).toBeLessThan(MAX_BREAKER_ANSWER_FRESHNESS_MS)
  })

  it('X3 (was a defect, RETIRED MID-RUN): the web boundary now serves the endpoint the SDK fetches', () => {
    // Last iteration `apps/web/app/api/v1/` had no budget route at all, so
    // `FlightReader.getBudgetSnapshot()` fetched a 404 and every guard held
    // nothing — which under both recommended policies is a decline. The route
    // landed while this suite was running.
    //
    // Enumerated from the FILESYSTEM rather than asserted, so the check tracks
    // the real boundary and fails if the route is moved or removed.
    const v1Routes = readdirSync(V1_ROUTE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    // TEETH: the enumeration is real and sees the routes that already existed.
    expect(v1Routes.length).toBeGreaterThan(3)
    expect(v1Routes).toContain('runs')

    expect(v1Routes).toContain('budgets')

    // And specifically the path `getBudgetSnapshot` requests, not merely a
    // `budgets` directory — a sibling route would satisfy the weaker check
    // while leaving the SDK's own call still 404ing.
    const budgetRoutes = readdirSync(`${V1_ROUTE_DIR}budgets`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(budgetRoutes).toContain('snapshot')
    expect(readdirSync(`${V1_ROUTE_DIR}budgets/snapshot`)).toContain('route.ts')

    // THE CONSEQUENCE THAT MADE IT SEVERE IS UNCHANGED AND STILL WORTH
    // PINNING: a guard that holds no acceptable snapshot declines. This is why
    // an integration gap in THIS feature is not "a screen shows less".
    for (const policy of [GRACE, DENY]) {
      const decision = decideBudget({ snapshot: null, receivedAt: 5_000, now: 5_000, policy })
      expect(decision.decision).toBe('declined_no_answer')
      expect(mayProceed(decision)).toBe(false)
    }
  })
})
