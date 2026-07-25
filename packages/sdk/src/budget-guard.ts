/**
 * `BudgetGuard` — THE ENFORCEMENT SEAM.
 *
 * This is the first thing in this SDK that does something other than record,
 * and the whole risk profile changes here. A recording bug loses data. AN
 * ENFORCEMENT BUG STOPS A COMPANY'S AGENTS FROM WORKING.
 *
 * Everything in this module is shaped by three properties, and they are the
 * properties the tests under `tests/unit/budget_*.test.ts` prove rather than
 * assert:
 *
 *   1. NOTHING HERE THROWS. `check()` sits inside somebody's agent loop, very
 *      possibly inside a `try/catch` whose catch block proceeds. An exception
 *      from an enforcement path is therefore an enforcement OUTCOME that nobody
 *      chose, and it is the permissive one. Every method returns a value; none
 *      of them can raise. The one exception is the CONSTRUCTOR, which throws on
 *      a caller bug (a `grace` policy with a nonsense window) before any
 *      decision has been made — failing at wiring time is the opposite of
 *      failing at decision time.
 *
 *   2. THE FAIL-CLOSED PATH IS NOT BYPASSABLE BY INDUCING AN ERROR. No
 *      snapshot, a malformed snapshot, an expired snapshot, a clock that
 *      throws, a `states` array that is a string, a proxy that raises on
 *      property access — every one of them lands on
 *      `declined_no_answer` under a `deny` policy. `tests/unit/budget_fail_closed.test.ts`
 *      induces each of them. THAT IS THE POINT: a breaker anyone can bypass by
 *      arranging a network error is not a breaker, and "the check errored" is
 *      the easiest condition in computing to arrange.
 *
 *   3. THE CHECK IS SYNCHRONOUS AND DOES NO I/O. An agent may consult the
 *      breaker before every model call, and a breaker nobody can afford to
 *      consult is a breaker that gets commented out. `check()` reads a held
 *      snapshot and returns; the network cost is one refresh per server-stated
 *      shelf life, and it can be zero if the snapshot rides back on an ingest
 *      response the agent was already paying for ({@link BudgetGuard.absorbSnapshot}).
 *
 * WHAT THIS CLASS DOES NOT DO, AND CANNOT:
 *
 *   IT DOES NOT STOP THE AGENT. It returns a `BudgetDecision`. A caller that
 *   reads the decision and proceeds is not a bug to be defended against — it is
 *   the only thing that could ever have happened, because this is a library
 *   inside someone else's loop and not a supervisor above it. No type, field or
 *   log line in this module asserts otherwise. See
 *   `packages/contracts/src/budgets.ts`, invariant 1, and
 *   {@link FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS}.
 *
 * NO `process.env`, no HTTP framework, no Convex import — CLAUDE.md's SDK
 * boundary rules apply here as everywhere else. The guard performs no network
 * I/O at all: refreshing is `FlightReader.getBudgetSnapshot()`'s job, and the
 * guard accepts what it is handed. That separation is what makes the
 * enforcement logic testable offline and instantly.
 */
import {
  breakerSnapshotRefusals,
  decideBudget,
  isBreakerSnapshotComplete,
  MAX_BREAKER_ANSWER_FRESHNESS_MS,
  MAX_BREAKER_GRACE_MS,
  mayProceed,
  statedShelfLifeMs,
} from '@agent-flight-recorder/contracts'

import type {
  BreakerSnapshot,
  BudgetDecision,
  BudgetUnavailablePolicy,
} from '@agent-flight-recorder/contracts'

/**
 * How the guard is wired.
 *
 * `unavailablePolicy` IS REQUIRED AND HAS NO DEFAULT. That is the single most
 * important line in this file. Fail-open and fail-closed have different costs
 * paid by different people — an agent that spends past its cap versus an agent
 * that stops working during an outage of OURS — and a library does not get to
 * pick on a customer's behalf. Making it required means a codebase's posture is
 * greppable rather than emergent, and it means nobody inherits a choice they
 * did not make.
 */
export interface BudgetGuardConfig {
  /**
   * REQUIRED. What to do when the breaker cannot be consulted. See
   * `BudgetUnavailablePolicy` in contracts for why `grace` is usually the right
   * answer and why the two permissive arms demand a written `acceptedRisk`.
   */
  unavailablePolicy: BudgetUnavailablePolicy
  /**
   * Injectable clock, epoch ms. Defaults to `Date.now`. Tests drive freshness
   * and grace through this rather than sleeping.
   *
   * A CLOCK THAT THROWS IS TREATED AS NO CLOCK, not as an exception: see
   * {@link BudgetGuard.check}.
   */
  now?: () => number
}

/**
 * What happened to a snapshot the guard was offered.
 *
 * Returned rather than thrown, because absorbing a snapshot happens on the
 * ingest response path — inside the SDK's own flush — and an exception there
 * would surface as a recording failure for what is actually a budget-plane
 * problem.
 */
export interface SnapshotAcceptance {
  accepted: boolean
  /**
   * Why it was refused, when it was. Every entry names a specific field or
   * claim, so a backend author reading a CI log knows what to fix.
   */
  refusedBecause: string[]
}

/**
 * Reasons the guard has no usable answer, phrased for
 * `BudgetDecision.noAnswerBecause`. Stated once so the sentence an operator
 * reads is stable across the SDK and the CLI.
 */
const NEVER_ASKED = 'no breaker snapshot has been received by this guard yet'

/**
 * The in-process breaker.
 *
 * ```ts
 * const guard = new BudgetGuard({
 *   unavailablePolicy: { onUnavailable: 'grace', graceMs: 30_000, acceptedRisk: 'up to 30s of spend past the cap during an AFR outage' },
 * })
 * guard.absorbSnapshot(await reader.getBudgetSnapshot({ runId }))
 *
 * const decision = guard.check()
 * if (!mayProceed(decision)) {
 *   // The SDK is declining. What happens next is YOURS — this library
 *   // cannot stop your process and does not claim to have.
 *   throw new Error(decisionStatement(decision))
 * }
 * ```
 */
export class BudgetGuard {
  private readonly policy: BudgetUnavailablePolicy
  private readonly clock: () => number
  /** The last snapshot that PASSED the gate. A refused one never lands here. */
  private held: BreakerSnapshot | null = null
  /**
   * WHEN THIS PROCESS OBSERVED THE HELD SNAPSHOT, on its own clock.
   *
   * The honouring ceiling is anchored here rather than on the server's
   * `evaluatedAt` — see `BudgetDecisionInput.receivedAt` in contracts for the
   * two-sided failure that anchoring on a server-supplied timestamp produces.
   */
  private heldReceivedAt: number = Number.NaN
  /** Why the last refresh/absorb failed, carried into the decision. */
  private lastFailure: string = NEVER_ASKED

  /**
   * @param config - `{ unavailablePolicy, now? }`. `unavailablePolicy` is
   *   required and has no default; see {@link BudgetGuardConfig}.
   * @throws {RangeError} if a `grace` policy names a non-positive or
   *   non-integer window, or if either permissive arm omits `acceptedRisk`.
   *   THROWN AT WIRING TIME, DELIBERATELY: a misconfigured guard must fail when
   *   it is constructed, not silently at the first decision. This is the one
   *   method in the class that can raise, and it cannot raise in the hot path.
   */
  constructor(config: BudgetGuardConfig) {
    const policy = config?.unavailablePolicy
    const mode = (policy as { onUnavailable?: unknown })?.onUnavailable
    if (mode !== 'deny' && mode !== 'grace' && mode !== 'allow') {
      throw new RangeError(
        `BudgetGuard: unavailablePolicy is required and must be one of { onUnavailable: 'deny' | 'grace' | ` +
          `'allow' } — got ${JSON.stringify(mode ?? null)}. There is deliberately no default: failing open and ` +
          `failing closed have different costs, paid by different people, and this library does not choose on ` +
          `your behalf.`
      )
    }
    if (mode === 'grace') {
      const graceMs = (policy as { graceMs?: unknown }).graceMs
      if (typeof graceMs !== 'number' || !Number.isInteger(graceMs) || graceMs <= 0) {
        throw new RangeError(
          `BudgetGuard: a 'grace' policy needs a positive integer graceMs — got ${JSON.stringify(graceMs ?? null)}.`
        )
      }
      if (graceMs > MAX_BREAKER_GRACE_MS) {
        throw new RangeError(
          `BudgetGuard: graceMs ${graceMs} exceeds MAX_BREAKER_GRACE_MS (${MAX_BREAKER_GRACE_MS}). Beyond that ` +
            `window, "we are inside a brief outage of theirs" stops being true and you are simply failing open on ` +
            `a timer — which is a legitimate choice, but it is { onUnavailable: 'allow' } and should say so.`
        )
      }
    }
    if ((mode === 'grace' || mode === 'allow') && !nonEmptyString((policy as { acceptedRisk?: unknown }).acceptedRisk)) {
      throw new RangeError(
        `BudgetGuard: a '${mode}' policy requires a non-empty acceptedRisk string. You may weaken the breaker; ` +
          `you may not do it without a sentence somebody can find later.`
      )
    }
    this.policy = policy
    this.clock = typeof config?.now === 'function' ? config.now : Date.now
  }

  /**
   * Accept a breaker snapshot — from `FlightReader.getBudgetSnapshot()`, or
   * piggybacked on an ingest response.
   *
   * THE GATE RUNS HERE, NOT AT DECISION TIME, and that placement is
   * deliberate: `check()` must be cheap enough to call before every model call,
   * so the expensive verification happens once per snapshot rather than once
   * per question.
   *
   * A REFUSED SNAPSHOT IS NOT STORED, AND DOES NOT DISPLACE A GOOD ONE. A
   * malformed body cannot poison the guard, and — the direction that matters —
   * it cannot EXTEND a shelf life either: the held snapshot keeps its own
   * `freshUntil`. The refusal is recorded as the reason a subsequent
   * unavailable decision cites, so a backend that starts serving garbage shows
   * up as declines with a specific message rather than as silence.
   *
   * NEVER THROWS.
   *
   * @param snapshot - anything at all; a refusal is a valid outcome.
   * @returns whether it was accepted, and every reason it was not.
   */
  absorbSnapshot(snapshot: BreakerSnapshot): SnapshotAcceptance {
    const refusedBecause = snapshotRefusals(snapshot)
    if (refusedBecause.length > 0) {
      this.lastFailure = `the last breaker snapshot was refused: ${refusedBecause.join('; ')}`
      return { accepted: false, refusedBecause }
    }
    // The receipt moment is read from the clock we control, once, here — not
    // recomputed at decision time, and never taken from the body.
    let receivedAt: number
    try {
      receivedAt = this.clock()
    } catch (err) {
      const reason = `the injected clock threw while stamping receipt (${err instanceof Error ? err.message : String(err)})`
      this.lastFailure = reason
      return { accepted: false, refusedBecause: [reason] }
    }
    if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt)) {
      const reason = 'the injected clock did not return a finite epoch-ms value, so receipt could not be stamped'
      this.lastFailure = reason
      return { accepted: false, refusedBecause: [reason] }
    }
    this.held = snapshot
    this.heldReceivedAt = receivedAt
    this.lastFailure = ''
    return { accepted: true, refusedBecause: [] }
  }

  /**
   * Record why the breaker could not be reached, so the next decision cites a
   * real reason instead of a shrug.
   *
   * Call this from a failed refresh. It does NOT clear the held snapshot: an
   * answer we already have stays valid for exactly as long as the server said
   * it would, and under a `grace` policy for a bounded window after that. A
   * transport error is a reason we could not get a NEW answer; it is not a
   * reason to discard the one we have.
   *
   * NEVER THROWS.
   *
   * @param reason - what went wrong, in prose. Empty input is replaced with a stated fallback.
   */
  noteUnavailable(reason: string): void {
    this.lastFailure = nonEmptyString(reason) ? reason : 'the breaker could not be consulted, and no reason was given'
  }

  /**
   * MAY THE AGENT PROCEED? Synchronous, no I/O, safe to call in a hot loop.
   *
   * ---------------------------------------------------------------------------
   * READ THE RETURN VALUE, NOT A BOOLEAN YOU CACHED
   * ---------------------------------------------------------------------------
   *
   * The six bands are not interchangeable. Three of them mean proceed and they
   * mean it for different reasons — a consulted breaker with headroom, an
   * expired answer inside a grace window, and a policy that proceeds without any
   * answer at all. Use `mayProceed(decision)` for control flow and record the
   * band itself, so an org that has quietly lost all budget enforcement does not
   * look identical to one that has it.
   *
   * WHAT IT DOES NOT DO: it does not stop anything. It returns a decision. If
   * this guard declines and your loop proceeds, the loop proceeded — nothing
   * here claims otherwise, and nothing here could have prevented it.
   *
   * NEVER THROWS, INCLUDING WHEN THE INJECTED CLOCK DOES. A `now()` that raises
   * is treated as no clock at all, which under a `deny` or `grace` policy is a
   * decline. That is not defensive padding: it is the difference between an
   * enforcement outcome the caller chose and one an exception chose for them.
   *
   * @returns one of six `BudgetDecision` bands. Pair with `mayProceed` and
   *   `decisionStatement` from contracts.
   */
  check(): BudgetDecision {
    let now: number
    try {
      now = this.clock()
    } catch (err) {
      // A clock that throws is an unavailability, not an exception to propagate.
      return decideBudget({
        snapshot: null,
        unavailableBecause: `the injected clock threw (${err instanceof Error ? err.message : String(err)})`,
        receivedAt: Number.NaN,
        now: Number.NaN,
        policy: this.policy,
      })
    }
    return decideBudget({
      snapshot: this.held,
      ...(this.lastFailure.length > 0 && { unavailableBecause: this.lastFailure }),
      receivedAt: this.heldReceivedAt,
      now: typeof now === 'number' ? now : Number.NaN,
      policy: this.policy,
    })
  }

  /**
   * Convenience for a control-flow site that genuinely only needs the boolean.
   *
   * Prefer {@link check} and record the band. This exists because the
   * alternative — callers writing their own `decision.decision.startsWith('allowed')`
   * — is worse, and because a shared helper is one place to keep the
   * fail-closed default for an unrecognised band.
   *
   * @returns whether the SDK is declining to proceed right now.
   */
  mayProceedNow(): boolean {
    return mayProceed(this.check())
  }

  /**
   * How long the held answer is still good for, in ms, or `null` for NO USABLE
   * ANSWER.
   *
   * `null` RATHER THAN `0`, and the distinction is the one this codebase keeps
   * having to make: `0` would be "the answer we have just expired" and `null` is
   * "we do not have one". A refresh scheduler that treated them alike would
   * hammer the server in the second case and, worse, would report an
   * un-consulted guard as a momentarily-stale one.
   *
   * Already capped by `MAX_BREAKER_ANSWER_FRESHNESS_MS`, so a server that
   * claims a year of shelf life gets a minute.
   *
   * @returns milliseconds of remaining freshness (never negative), or `null`.
   */
  freshnessRemainingMs(): number | null {
    const held = this.held
    if (held === null) return null
    let now: number
    try {
      now = this.clock()
    } catch {
      return null
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) return null
    // MUST MIRROR `decideBudget` EXACTLY: the server contributes a DURATION and
    // no absolute instant, and both ends of the window are anchored on the
    // receipt moment. A scheduler that computed freshness any other way would
    // refresh on one clock and expire on another — and a scheduler that took
    // `freshUntil` as an absolute floor would report every answer as expired
    // the moment a server's clock drifted behind, which is the halt-a-business
    // direction. See `BreakerSnapshot.freshUntil`.
    if (!Number.isFinite(this.heldReceivedAt)) return null
    // Same ordering rule as `decideBudget`. This class stamps both instants
    // from one injected clock so it should be unreachable — but a scheduler
    // that reported remaining freshness where the decision rule reports "no
    // usable answer" would send a caller back to a guard that is declining.
    if (this.heldReceivedAt > now) return null
    const shelfLifeMs = statedShelfLifeMs(held)
    if (shelfLifeMs === null) return null
    const effective = this.heldReceivedAt + Math.min(shelfLifeMs, MAX_BREAKER_ANSWER_FRESHNESS_MS)
    return Math.max(0, effective - now)
  }

  /**
   * Should the caller refresh before its next check?
   *
   * The scheduling hint that makes the cheap ask cheap: refresh when the held
   * answer is inside its last `leadMs`, not on every call.
   *
   * @param leadMs - how far ahead of expiry to refresh. Defaults to a quarter
   *   of the maximum shelf life.
   * @returns true when there is no usable answer, or the one held is close to
   *   expiring.
   */
  shouldRefresh(leadMs: number = MAX_BREAKER_ANSWER_FRESHNESS_MS / 4): boolean {
    const remaining = this.freshnessRemainingMs()
    if (remaining === null) return true
    return remaining <= (Number.isFinite(leadMs) && leadMs >= 0 ? leadMs : 0)
  }
}

/** A non-empty string, and nothing else. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Every reason a snapshot must be refused, in the order a reader wants them.
 *
 * A THIN WRAPPER OVER CONTRACTS' `breakerSnapshotRefusals`, which is the single
 * definition — the structural checks used to live here, and having them here
 * meant `decideBudget` (the rule every other consumer calls) was ungated while
 * `BudgetGuard` was gated. An evidence-free `{ state: 'tripped' }` therefore
 * produced a decline from the shared rule and four refusals from this function,
 * on the same body. Redundancy above a hole is what hides the hole.
 *
 * What this adds on top is the COMPLETENESS reading, which is a refusal for
 * enforcement purposes but not a structural defect.
 *
 * MUST NEVER THROW — it runs on a body nothing has vouched for.
 *
 * @param snapshot - anything at all.
 * @returns every refusal reason. Empty means the snapshot may be enforced on.
 */
export function snapshotRefusals(snapshot: BreakerSnapshot): string[] {
  const refusals = breakerSnapshotRefusals(snapshot)
  if (refusals.length > 0) return refusals

  // Completeness is NOT a structural refusal — a truncated evaluation is the
  // server telling the truth in a field — but an incomplete evaluation still
  // cannot establish headroom, so it is reported here and `decideBudget` turns
  // it into a policy decision rather than an exception.
  if (!isBreakerSnapshotComplete(snapshot)) {
    return [
      'the evaluation is incomplete (scan.budgetsEvaluated does not cover scan.budgetsInScope, or the ' +
        'evaluation was truncated) — an incomplete evaluation cannot establish headroom',
    ]
  }
  return []
}
