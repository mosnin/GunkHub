/**
 * `PolicyPreflight` — THE ADVISORY SEAM.
 *
 * The second thing in this SDK that does something other than record, and the
 * same three properties shape it as `BudgetGuard`:
 *
 *   1. NOTHING HERE THROWS. `check()` sits inside somebody's agent loop, very
 *      possibly inside a `try/catch` whose catch block proceeds. An exception
 *      from an advisory path is therefore an ADVISORY OUTCOME nobody chose, and
 *      it is the permissive one. Every method returns a value; none can raise.
 *      The one exception is the CONSTRUCTOR, which throws on a caller bug
 *      (a `grace` policy with a nonsense window) BEFORE any answer has been
 *      given — failing at wiring time is the opposite of failing at decision
 *      time.
 *
 *   2. THE FAIL-CLOSED PATH IS NOT BYPASSABLE BY INDUCING AN ERROR. No listing,
 *      a malformed listing, an expired listing, a clock that throws, a
 *      `policies` array that is a string, a proxy that raises on property access
 *      — every one lands on `advised_against_without_answer` under a `deny`
 *      policy. A preflight anyone can bypass by arranging a network error is not
 *      a preflight, and "the check errored" is the easiest condition in
 *      computing to arrange.
 *
 *   3. THE CHECK IS SYNCHRONOUS AND DOES NO I/O. An agent may consult the
 *      preflight before every tool call. Unlike a budget breaker, the answer is
 *      computed ENTIRELY LOCALLY from the held listing and the proposed act —
 *      only the server can sum spend, but a prohibition is decidable in the
 *      client — so the network cost is one refresh per server-stated shelf life
 *      and nothing at all per question.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLASS DOES NOT DO, AND CANNOT
 * ---------------------------------------------------------------------------
 *
 *   IT DOES NOT PREVENT THE CALL. It returns a `PolicyPreflightAnswer`. A caller
 *   that reads the answer and calls the tool anyway is not a bug to be defended
 *   against — it is the only thing that could ever have happened, because this
 *   is a library inside someone else's loop and not a supervisor above it.
 *
 *   IT DOES NOT DECIDE AN ACT. It decides A DESCRIPTION OF ONE (ADR-009 §7.7).
 *   Nothing binds the tool name passed to `check()` to the call subsequently
 *   made, and nothing re-checks. That gap is unclosable from inside a library,
 *   and it is exactly why the RECORDED RUN is the only thing that can ever
 *   contradict the description.
 *
 *   IT HAS NO CHANNEL TO THE RECORDER. There is no way — not a constructor
 *   argument, not a callback, not a shared object — for an answer from this
 *   class to cause an event not to be recorded. That absence is INVARIANT 0 of
 *   `packages/contracts/src/policy.ts`, and every answer carries
 *   `recordRegardless: true` (the literal type) to say so in the value an
 *   integrator reads.
 *
 * NO `process.env`, no HTTP framework, no Convex import — CLAUDE.md's SDK
 * boundary rules apply here as everywhere else. The preflight performs no
 * network I/O at all: refreshing is `FlightReader.getPolicySnapshot()`'s job and
 * this class accepts what it is handed. That separation is what makes the logic
 * testable offline and instantly.
 */
import {
  decidePreflight,
  MAX_POLICY_ANSWER_FRESHNESS_MS,
  MAX_POLICY_GRACE_MS,
  mayProceedWithAct,
  policySnapshotRefusals,
} from '@agent-flight-recorder/contracts'

import type {
  PolicyPreflightAnswer,
  PolicySnapshot,
  PolicyUnavailablePolicy,
  ProposedAct,
} from '@agent-flight-recorder/contracts'

/**
 * How the preflight is wired.
 *
 * `unavailablePolicy` IS REQUIRED AND HAS NO DEFAULT. That is the single most
 * important line in this file, and it is the same argument `BudgetGuardConfig`
 * makes: fail-open and fail-closed have different costs paid by different people
 * — an agent that calls a forbidden tool versus an agent that stops working
 * during an outage of OURS — and a library does not get to pick on a customer's
 * behalf. Making it required means a codebase's posture is greppable rather than
 * emergent.
 */
export interface PolicyPreflightConfig {
  /** REQUIRED. What to do when the policy set cannot be consulted. */
  unavailablePolicy: PolicyUnavailablePolicy
  /**
   * Injectable clock, epoch ms. Defaults to `Date.now`. Tests drive freshness
   * and grace through this rather than sleeping.
   *
   * A CLOCK THAT THROWS IS TREATED AS NO CLOCK, not as an exception — see
   * {@link PolicyPreflight.check}.
   */
  now?: () => number
}

/**
 * What happened to a listing the preflight was offered.
 *
 * Returned rather than thrown, because absorbing a listing may happen on a
 * response path inside the SDK's own flush, and an exception there would surface
 * as a recording failure for what is actually a policy-plane problem.
 */
export interface PolicySnapshotAcceptance {
  accepted: boolean
  /**
   * Why it was refused, when it was. Every entry names a specific field, so a
   * backend author reading a CI log knows what to fix.
   */
  refusedBecause: string[]
}

/** Stated once so the sentence an operator reads is stable across the SDK and the CLI. */
const NEVER_ASKED = 'no policy listing has been received by this preflight yet'

/**
 * The in-process policy preflight.
 *
 * ```ts
 * const preflight = new PolicyPreflight({
 *   unavailablePolicy: { onUnavailable: 'deny' },
 * })
 * preflight.absorbSnapshot(await reader.getPolicySnapshot({ agentId }))
 *
 * const answer = preflight.check({ kind: 'tool_denied', value: 'shell.exec' })
 * if (!mayProceedWithAct(answer)) {
 *   // The SDK is advising against. What happens next is YOURS — this library
 *   // cannot intercept your call and does not claim to have.
 *   throw new Error(preflightStatement(answer))
 * }
 * // AND EITHER WAY, RECORD IT. `answer.recordRegardless` is the literal `true`
 * // on every band; if the act proceeds, that event is the most valuable row in
 * // the log.
 * ```
 */
export class PolicyPreflight {
  private readonly policy: PolicyUnavailablePolicy
  private readonly clock: () => number
  /** The last listing that PASSED the gate. A refused one never lands here. */
  private held: PolicySnapshot | null = null
  /**
   * WHEN THIS PROCESS OBSERVED THE HELD LISTING, on its own clock.
   *
   * The honouring ceiling is anchored here rather than on the server's
   * `evaluatedAt` — see `PolicyPreflightInput.receivedAt` in contracts for the
   * two-sided failure that anchoring on a server-supplied timestamp produces.
   */
  private heldReceivedAt: number = Number.NaN
  /** Why the last refresh/absorb failed, carried into the answer. */
  private lastFailure: string = NEVER_ASKED

  /**
   * @param config - `{ unavailablePolicy, now? }`. `unavailablePolicy` is
   *   required and has no default; see {@link PolicyPreflightConfig}.
   * @throws {RangeError} if a `grace` policy names a non-positive or non-integer
   *   window, or if either permissive arm omits `acceptedRisk`. THROWN AT WIRING
   *   TIME, DELIBERATELY: a misconfigured preflight must fail when it is
   *   constructed, not silently at the first answer. This is the one method in
   *   the class that can raise, and it cannot raise in the hot path.
   */
  constructor(config: PolicyPreflightConfig) {
    const policy = config?.unavailablePolicy
    const mode = (policy as { onUnavailable?: unknown })?.onUnavailable
    if (mode !== 'deny' && mode !== 'grace' && mode !== 'allow') {
      throw new RangeError(
        `PolicyPreflight: unavailablePolicy is required and must be one of { onUnavailable: 'deny' | 'grace' | ` +
          `'allow' } — got ${JSON.stringify(mode ?? null)}. There is deliberately no default: failing open and ` +
          `failing closed have different costs, paid by different people, and this library does not choose on ` +
          `your behalf.`
      )
    }
    if (mode === 'grace') {
      const graceMs = (policy as { graceMs?: unknown }).graceMs
      if (typeof graceMs !== 'number' || !Number.isInteger(graceMs) || graceMs <= 0) {
        throw new RangeError(
          `PolicyPreflight: a 'grace' policy needs a positive integer graceMs — got ${JSON.stringify(graceMs ?? null)}.`
        )
      }
      if (graceMs > MAX_POLICY_GRACE_MS) {
        throw new RangeError(
          `PolicyPreflight: graceMs ${graceMs} exceeds MAX_POLICY_GRACE_MS (${MAX_POLICY_GRACE_MS}). Beyond that ` +
            `window, "we are inside a brief outage of theirs" stops being true and you are simply failing open on ` +
            `a timer — which is a legitimate choice, but it is { onUnavailable: 'allow' } and should say so.`
        )
      }
    }
    if (
      (mode === 'grace' || mode === 'allow') &&
      !nonEmptyString((policy as { acceptedRisk?: unknown }).acceptedRisk)
    ) {
      throw new RangeError(
        `PolicyPreflight: a '${mode}' policy requires a non-empty acceptedRisk string. You may weaken the ` +
          `preflight; you may not do it without a sentence somebody can find later.`
      )
    }
    this.policy = policy
    this.clock = typeof config?.now === 'function' ? config.now : Date.now
  }

  /**
   * Accept a policy listing — from `FlightReader.getPolicySnapshot()`.
   *
   * THE GATE RUNS HERE, NOT AT ANSWER TIME, and that placement is deliberate:
   * `check()` must be cheap enough to call before every tool call, so the
   * verification happens once per listing rather than once per question.
   *
   * A REFUSED LISTING IS NOT STORED, AND DOES NOT DISPLACE A GOOD ONE. A
   * malformed body cannot poison the preflight, and — the direction that matters
   * — it cannot EXTEND a shelf life either. The refusal is recorded as the reason
   * a subsequent unavailable answer cites, so a backend that starts serving
   * garbage shows up as advisories with a specific message rather than as
   * silence.
   *
   * NEVER THROWS.
   *
   * @param snapshot - anything at all; a refusal is a valid outcome.
   * @returns whether it was accepted, and every reason it was not.
   */
  absorbSnapshot(snapshot: PolicySnapshot): PolicySnapshotAcceptance {
    const refusedBecause = policySnapshotRefusals(snapshot)
    if (refusedBecause.length > 0) {
      this.lastFailure = `the last policy listing was refused: ${refusedBecause.join('; ')}`
      return { accepted: false, refusedBecause }
    }
    // The receipt moment is read from the clock we control, once, here — not
    // recomputed at answer time, and never taken from the body.
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
   * Record why the policy set could not be reached, so the next answer cites a
   * real reason instead of a shrug.
   *
   * Call this from a failed refresh. It does NOT clear the held listing: a
   * listing we already have stays valid for exactly as long as the server said,
   * and under a `grace` policy for a bounded window after. A transport error is a
   * reason we could not get a NEW listing; it is not a reason to discard the one
   * we have — and discarding it would be the permissive direction, because a
   * prohibition we are holding is the thing keeping an act off the table.
   *
   * NEVER THROWS.
   *
   * @param reason - what went wrong, in prose. Empty input is replaced with a stated fallback.
   */
  noteUnavailable(reason: string): void {
    this.lastFailure = nonEmptyString(reason)
      ? reason
      : 'the policy set could not be consulted, and no reason was given'
  }

  /**
   * MAY THE AGENT PERFORM THIS ACT? Synchronous, no I/O, safe to call in a hot
   * loop.
   *
   * ---------------------------------------------------------------------------
   * READ THE RETURN VALUE, NOT A BOOLEAN YOU CACHED
   * ---------------------------------------------------------------------------
   *
   * The six bands are not interchangeable. Four mean proceed and they mean it for
   * different reasons — a policy set consulted in full, a subject nothing
   * governs, an expired listing inside a grace window, and a policy that proceeds
   * without any listing at all. Use `mayProceedWithAct(answer)` for control flow
   * and RECORD THE BAND, so an org that has quietly lost all policy coverage does
   * not look identical to one that has it.
   *
   * WHAT IT DOES NOT DO: it does not prevent anything, and it does not decide the
   * call you make — only the call you described. If this advises against and your
   * loop proceeds, the loop proceeded; nothing here claims otherwise and nothing
   * here could have stopped it. THE RECORDED EVENT IS WHAT MATTERS THEN, which is
   * why every band carries `recordRegardless: true`.
   *
   * NEVER THROWS, INCLUDING WHEN THE INJECTED CLOCK DOES. A `now()` that raises is
   * treated as no clock at all, which under `deny` or `grace` is an advisory
   * against. That is not defensive padding: it is the difference between an
   * outcome the caller chose and one an exception chose for them.
   *
   * @param act - `{ kind, value }` — the tool name or URL about to be used. A
   *   malformed act is answered `advised_against_without_answer` under every
   *   policy including `allow`, because `allow` means "proceed when the SERVER
   *   could not answer", not "proceed when the caller passed nonsense".
   * @returns one of six `PolicyPreflightAnswer` bands. Pair with
   *   `mayProceedWithAct` and `preflightStatement` from contracts.
   */
  check(act: ProposedAct): PolicyPreflightAnswer {
    let now: number
    try {
      now = this.clock()
    } catch (err) {
      // A clock that throws is an unavailability, not an exception to propagate.
      return decidePreflight({
        snapshot: null,
        act,
        unavailableBecause: `the injected clock threw (${err instanceof Error ? err.message : String(err)})`,
        receivedAt: Number.NaN,
        now: Number.NaN,
        policy: this.policy,
      })
    }
    return decidePreflight({
      snapshot: this.held,
      act,
      ...(this.lastFailure.length > 0 && { unavailableBecause: this.lastFailure }),
      receivedAt: this.heldReceivedAt,
      now: typeof now === 'number' ? now : Number.NaN,
      policy: this.policy,
    })
  }

  /**
   * Convenience for a control-flow site that genuinely only needs the boolean.
   *
   * Prefer {@link check} and record the band. This exists because the alternative
   * — callers writing their own `answer.answer.startsWith('proceeded')` — is
   * worse, and because a shared helper is one place to keep the fail-closed
   * default for an unrecognised band.
   *
   * @param act - the act being proposed.
   * @returns whether the SDK is declining to advise against right now.
   */
  mayProceedNow(act: ProposedAct): boolean {
    return mayProceedWithAct(this.check(act))
  }

  /**
   * How long the held listing is still good for, in ms, or `null` for NO USABLE
   * LISTING.
   *
   * `null` RATHER THAN `0`: `0` would be "the listing we have just expired" and
   * `null` is "we do not have one". A refresh scheduler that treated them alike
   * would hammer the server in the second case and would report an un-consulted
   * preflight as a momentarily-stale one.
   *
   * Already capped by `MAX_POLICY_ANSWER_FRESHNESS_MS`, so a server that claims a
   * year of shelf life gets ten minutes.
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
    if (!Number.isFinite(this.heldReceivedAt)) return null
    // MUST MIRROR `decidePreflight` EXACTLY: the server contributes a DURATION
    // and no absolute instant, and both ends of the window are anchored on the
    // receipt moment. A scheduler computing freshness any other way would
    // refresh on one clock and expire on another.
    if (this.heldReceivedAt > now) return null
    const shelfLifeMs = held.shelfLifeMs
    if (typeof shelfLifeMs !== 'number' || !Number.isInteger(shelfLifeMs) || shelfLifeMs <= 0) return null
    const effective = this.heldReceivedAt + Math.min(shelfLifeMs, MAX_POLICY_ANSWER_FRESHNESS_MS)
    return Math.max(0, effective - now)
  }

  /**
   * Should the caller refresh before its next check?
   *
   * The scheduling hint that makes the cheap ask cheap: refresh when the held
   * listing is inside its last `leadMs`, not on every call.
   *
   * @param leadMs - how far ahead of expiry to refresh. Defaults to a quarter of
   *   the maximum shelf life.
   * @returns true when there is no usable listing, or the one held is close to
   *   expiring.
   */
  shouldRefresh(leadMs: number = MAX_POLICY_ANSWER_FRESHNESS_MS / 4): boolean {
    const remaining = this.freshnessRemainingMs()
    if (remaining === null) return true
    return remaining <= (Number.isFinite(leadMs) && leadMs >= 0 ? leadMs : 0)
  }
}

/** A non-empty string, and nothing else. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
