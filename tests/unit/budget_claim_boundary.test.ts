/**
 * THE CLAIM BOUNDARY — "the agent was stopped" must not be expressible.
 *
 * This is the first feature in this product where the SDK does something other
 * than record, and the boundary it has to hold is sharper than any of the three
 * that came before it. `divergence.ts` had to keep proof apart from
 * speculation, `fleet_health.ts` observation apart from hypothesis,
 * `causality.ts` a record apart from an inference. All three were about what
 * the system KNOWS. This one is about what the system DID, and the failure mode
 * is not a wrong finding on a screen — it is a compliance claim.
 *
 * THE THREE CLAIMS, AND WHICH TWO ARE OURS:
 *
 *   OWNED   "The breaker is tripped."  A fact about the BREAKER, established by
 *                                      the server from spend it summed.
 *   OWNED   "The SDK declined."        A fact about the SDK's own return value.
 *   NEVER   "The agent halted."        A fact about a process this library sits
 *                                      inside and does not control. It cannot
 *                                      observe it, so it may not assert it.
 *
 * The third one is not merely unsupported, it is UNVERIFIABLE BY CONSTRUCTION:
 * the SDK returns a value into somebody else's loop, and whether that loop
 * honours it is invisible from here. A field named `enforced` would therefore
 * be a permanent lie with an audit trail — it would appear on a dashboard, then
 * in an incident review, then in an answer to "was spend capped?", and the gap
 * between "we returned deny" and "the spend did not happen" is exactly what the
 * person asking wants to know.
 *
 * ---------------------------------------------------------------------------
 * HOW TO READ THIS FILE — FOUR PROOFS, AND THE THIRD IS THE DURABLE ONE
 * ---------------------------------------------------------------------------
 *
 * 1. `@ts-expect-error` — the conflation does not compile TODAY, and the
 *    directive is self-verifying in both directions: if any line below ever
 *    stops erroring, TypeScript reports "Unused '@ts-expect-error' directive"
 *    AS AN ERROR and `pnpm typecheck` goes red.
 *
 * 2. Structural — no band or state OBJECT carries such a key at runtime, which
 *    covers the case where a field arrives from a wire body rather than a type.
 *
 * 3. **SOURCE-DERIVED — the vocabulary sweep.** Proofs 1 and 2 pin the types
 *    that exist now. The thing that actually goes wrong is somebody adding a
 *    SEVENTH band, or a field to an existing one, six months from now, with a
 *    perfectly reasonable name like `executionBlocked`. A hand-written list of
 *    forbidden fields cannot catch that, because the thing that goes wrong IS
 *    the list being incomplete — the same argument `fleet_export_tolerance.test.ts`
 *    made about enumerating exports from source. So this sweep reads every
 *    `export interface` in `packages/contracts/src/budgets.ts` out of the file
 *    itself and asserts no field name anywhere claims an agent was stopped.
 *    Verified by adding such a field and watching it go red.
 *
 * 4. Prose — `decisionStatement` is the only sentence a surface should render,
 *    and its decline branches must say what the SDK did AND what that does not
 *    establish, in the same breath. An operator at 3am will not supply the
 *    caveat for themselves.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  decideBudget,
  decisionStatement,
  FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS,
  mayProceed,
  snapshotUnusableFields,
  wasDeclinedBySdk,
} from '@agent-flight-recorder/contracts'
// A NAMESPACE import, not a named one, because the assertion below is about
// what the module does NOT export. A named import of an absent symbol is a
// compile error, so the absence has to be observed at runtime — and a static
// namespace import does that while still being checked at build time, which
// `require()` is not.
import * as contractsModule from '@agent-flight-recorder/contracts'
import { BudgetGuard, snapshotRefusals } from '@agent-flight-recorder/sdk'
import { describe, expect, it } from 'vitest'

import { NOW, armed, snapshot, tripped } from './budget_fixtures.js'

import type { BreakerState, BudgetDecision } from '@agent-flight-recorder/contracts'

const DENY = { onUnavailable: 'deny' } as const

/** Every band, so a sweep covers the union rather than the two somebody thought of. */
function everyBand(): BudgetDecision[] {
  return [
    decideBudget({ snapshot: snapshot(), receivedAt: NOW, now: NOW, policy: DENY }),
    decideBudget({ snapshot: snapshot({ states: [tripped()] }), receivedAt: NOW, now: NOW, policy: DENY }),
    decideBudget({ snapshot: null, unavailableBecause: 'network', receivedAt: NOW, now: NOW, policy: DENY }),
    decideBudget({
      snapshot: null,
      unavailableBecause: 'network',
      receivedAt: NOW, now: NOW,
      policy: { onUnavailable: 'allow', acceptedRisk: 'unbounded spend while AFR is unreachable' },
    }),
    decideBudget({
      // Stale by RECEIPT: a one-second shelf life received ten seconds ago.
      // Expressed as a duration plus an arrival instant, because absolute
      // server timestamps no longer decide anything.
      snapshot: snapshot({ shelfLifeMs: 1_000 }),
      unavailableBecause: 'network',
      receivedAt: NOW - 10_000, now: NOW,
      policy: { onUnavailable: 'grace', graceMs: 30_000, acceptedRisk: 'up to 30s past cap' },
    }),
    decideBudget({
      snapshot: {
        evaluatedAt: NOW - 1_000,
        freshUntil: NOW + 10_000,
        states: [],
        scan: { subject: { agentId: 'agent_7' }, budgetsInScope: 0, budgetsEvaluated: 0, evaluationTruncated: false },
      },
      receivedAt: NOW, now: NOW,
      policy: DENY,
    }),
  ]
}

describe('the type system cannot express "the agent was stopped"', () => {
  it('no decision band carries an enforcement claim', () => {
    const decision = decideBudget({ snapshot: snapshot({ states: [tripped()] }), receivedAt: NOW, now: NOW, policy: DENY })

    // @ts-expect-error - `enforced` is not a field on any band, and never will be.
    void decision.enforced
    // @ts-expect-error - nor `halted`.
    void decision.halted
    // @ts-expect-error - nor `agentStopped`.
    void decision.agentStopped
    // @ts-expect-error - nor `spendPrevented`.
    void decision.spendPrevented
    // @ts-expect-error - and there is no `allowed: boolean` either. Four bands
    // mean proceed and they mean it for four different reasons; a single flag
    // would have made an org that lost every budget look like one with cost
    // control. `mayProceed()` is the classified answer.
    void decision.allowed

    expect(wasDeclinedBySdk(decision)).toBe(true)
  })

  it('no breaker state carries one either', () => {
    const state: BreakerState = armed()
    // @ts-expect-error - a breaker's state is about the BREAKER.
    void state.enforced
    // @ts-expect-error - it never says anything happened to an agent.
    void state.blocked
    expect(state.state).toBe('armed')
  })

  it('there is no `wasAgentStopped` to import — only `wasDeclinedBySdk`', () => {
    // The observable half: what the SDK exports is a question about ITSELF.
    // A `wasAgentStopped` would have no honest implementation, so it does not
    // exist, and the absence is asserted rather than assumed.
    const contracts = contractsModule as unknown as Record<string, unknown>
    expect(typeof contracts['wasDeclinedBySdk']).toBe('function')
    for (const forbidden of ['wasAgentStopped', 'wasEnforced', 'wasSpendPrevented', 'didAgentHalt']) {
      expect(contracts[forbidden]).toBeUndefined()
    }
  })
})

describe('no decision object carries a stopping claim at runtime', () => {
  it('every band, swept', () => {
    for (const decision of everyBand()) {
      for (const key of Object.keys(decision)) {
        expect(FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS).not.toContain(key)
      }
    }
  })

  it('covers all six bands, so the sweep is not proving something about two of them', () => {
    expect(new Set(everyBand().map((d) => d.decision)).size).toBe(6)
  })
})

/**
 * THE DURABLE PROOF. Reads the contract's own source and enumerates every field
 * of every exported interface, so a field added tomorrow is covered by a test
 * written today.
 */
describe('SOURCE SWEEP — no field of any budget type claims an agent was stopped', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../packages/contracts/src/budgets.ts', import.meta.url)),
    'utf8'
  )

  /**
   * Verbs that assert something happened to a process we do not control.
   * Deliberately broader than {@link FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS}, which
   * is an exact-match list for wire keys: a NEW field would be named something
   * nobody put on that list, which is the whole point of scanning by stem.
   */
  const STOPPING_STEMS = /(enforc|halt|stopp|stopped|blocked|prevent|kill|terminat|abort|throttl)/i

  /** Field declarations inside `export interface` bodies, stripped of comments. */
  function declaredFields(): { iface: string; field: string }[] {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const found: { iface: string; field: string }[] = []
    const ifaceRe = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g
    let match: RegExpExecArray | null
    while ((match = ifaceRe.exec(withoutComments)) !== null) {
      const [, iface, body] = match
      for (const line of body.split('\n')) {
        const field = /^\s*(\w+)\??\s*:/.exec(line)
        if (field) found.push({ iface, field: field[1] })
      }
    }
    return found
  }

  it('the sweep actually found the interfaces (a regex that matches nothing proves nothing)', () => {
    const fields = declaredFields()
    expect(fields.length).toBeGreaterThan(40)
    // Anchors: if the parse silently stops working, these disappear and the
    // sweep below becomes vacuously true.
    expect(fields).toContainEqual({ iface: 'BreakerTripped', field: 'trippedBecause' })
    expect(fields).toContainEqual({ iface: 'ApproximateSpend', field: 'couldUnderstateBy' })
    expect(fields).toContainEqual({ iface: 'DeclinedNoAnswer', field: 'declinedByPolicy' })
  })

  it('no declared field name asserts an agent stopped', () => {
    const offenders = declaredFields().filter(({ field }) => STOPPING_STEMS.test(field))
    expect(offenders).toEqual([])
  })

  it('no exported type NAME asserts it either', () => {
    const names = [...source.matchAll(/export (?:interface|type) (\w+)/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(20)
    expect(names.filter((n) => STOPPING_STEMS.test(n))).toEqual([])
  })
})

describe('the wire gate refuses a body that makes the claim for us', () => {
  it('a snapshot carrying `enforced` is refused, not rendered', () => {
    const forged = snapshot({ states: [{ ...tripped(), enforced: true } as unknown as BreakerState] })
    const findings = snapshotUnusableFields(forged)
    expect(findings.some((f) => f.reason === 'forbidden_enforcement_claim')).toBe(true)
    expect(snapshotRefusals(forged).join(' ')).toContain('forbidden_enforcement_claim')
  })

  it.each(FORBIDDEN_ENFORCEMENT_CLAIM_FIELDS)('refuses `%s` at the top level too', (field) => {
    const forged = { ...snapshot(), [field]: true } as unknown as Parameters<typeof snapshotUnusableFields>[0]
    expect(snapshotUnusableFields(forged).some((f) => f.reason === 'forbidden_enforcement_claim')).toBe(true)
  })

  it('a refused snapshot never reaches the guard, so the claim cannot survive one hop', () => {
    const guard = new BudgetGuard({ unavailablePolicy: DENY, now: () => NOW })
    const forged = snapshot({ states: [{ ...armed(), halted: true } as unknown as BreakerState] })
    expect(guard.absorbSnapshot(forged).accepted).toBe(false)
    // And the guard is now DECLINING, not silently holding a poisoned answer.
    expect(mayProceed(guard.check())).toBe(false)
  })
})

describe('the composed sentence states the limit of what we know', () => {
  it('a decline names the SDK as the subject and disclaims the rest', () => {
    const decision = decideBudget({ snapshot: snapshot({ states: [tripped()] }), receivedAt: NOW, now: NOW, policy: DENY })
    const sentence = decisionStatement(decision)
    expect(sentence).toContain('THE SDK DECLINED TO PROCEED')
    expect(sentence).toContain('does not stop a process')
    expect(sentence.toLowerCase()).toContain('agent halted')
    // ...and it says agent-halted only to DENY it. The assertion that matters
    // is that the denial is present, which the two lines above establish
    // together: the sentence mentions the claim exclusively inside a negation.
    expect(/nothing in this record establishes that the agent halted/i.test(sentence)).toBe(true)
  })

  it('a fail-closed decline does NOT claim a breaker is tripped', () => {
    // The other direction of dishonesty, and the easier one to ship: we do not
    // know the breaker's state, and saying we do would stop deploys on our own
    // outage while blaming the customer's spend.
    const sentence = decisionStatement(
      decideBudget({ snapshot: null, unavailableBecause: 'timeout', receivedAt: NOW, now: NOW, policy: DENY })
    )
    expect(sentence).toContain('could not be consulted')
    expect(sentence).toContain('not a statement that a breaker is tripped')
  })

  it('a fail-open allow says outright that it is not evidence of headroom', () => {
    const sentence = decisionStatement(
      decideBudget({
        snapshot: null,
        unavailableBecause: 'timeout',
        receivedAt: NOW, now: NOW,
        policy: { onUnavailable: 'allow', acceptedRisk: 'unbounded spend during an outage' },
      })
    )
    expect(sentence).toContain('THE BREAKER WAS NOT CONSULTED')
    expect(sentence).toContain('not evidence of headroom')
    expect(sentence).toContain('unbounded spend during an outage')
  })

  it('every band has a sentence, and no sentence is empty', () => {
    for (const decision of everyBand()) {
      expect(decisionStatement(decision).length).toBeGreaterThan(40)
    }
  })
})
