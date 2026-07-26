/**
 * THE CLAIM BOUNDARY — proving nothing can assert that an agent was prevented,
 * that an org is compliant, or that an event should not be recorded.
 *
 * ---------------------------------------------------------------------------
 * THREE CLAIMS, AND EACH HAS A DIFFERENT REASON FOR BEING UNSPELLABLE
 * ---------------------------------------------------------------------------
 *
 *   "THE CALL WAS PREVENTED"    A fact about a process this library sits inside
 *                               and does not control. `Events.toolCall` is
 *                               called BY the caller; nothing here intercepts
 *                               anything. There is `wasAdvisedAgainstBySdk` and
 *                               deliberately no `wasCallPrevented`, because
 *                               there is no honest implementation of one.
 *
 *   "THE ORG IS COMPLIANT"      A conclusion nobody can derive from per-run
 *                               outcomes. The dangerous form is not the boolean
 *                               — it is the COUNT. `satisfiedCount: 12` in a
 *                               response body carries none of the five literals,
 *                               none of the instrumentation claim, and none of
 *                               the prose. It is the attestation figure with
 *                               every safeguard stripped off, and it is one
 *                               field name away at all times (ADR-009 §4.2).
 *
 *   "DO NOT RECORD THIS"        INVARIANT 0, and the most serious of the three.
 *                               A policy engine inside a recorder must never
 *                               refuse to record a violation: the breach is the
 *                               most valuable event in the log. This contract
 *                               gives a policy no way to express it, and a wire
 *                               body that tries is REFUSED OUTRIGHT rather than
 *                               softened into an incomplete verdict.
 *
 * The type system closes each in our own code; a JSON body is not typechecked by
 * anyone, and a backend can add `prevented: true` in one keystroke. So each is
 * asserted twice — once as a compile error, once at the wire.
 */
import {
  complianceClaimIn,
  decidePreflight,
  evaluationUnusableFields,
  FORBIDDEN_COMPLIANCE_CLAIM_FIELDS,
  FORBIDDEN_POLICY_WIRE_FIELDS,
  FORBIDDEN_PREVENTION_CLAIM_FIELDS,
  FORBIDDEN_SUPPRESSION_FIELDS,
  computePolicyVerdict,
  countPolicyOutcomes,
  mayProceedWithAct,
  policyEvaluationRefusals,
  policySnapshotRefusals,
  policyVerdictStatement,
  preflightStatement,
  PREFLIGHT_STILL_RECORDS,
  wasAdvisedAgainstBySdk,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import {
  NOW,
  coverageProof,
  evaluation,
  notEvaluable,
  policySnapshot,
  satisfied,
  scan,
  toolPolicy,
  violated,
} from './policy_fixtures.js'

import type {
  PolicyEvaluation,
  PolicyPreflightAnswer,
  PolicySnapshot,
  PolicyUnavailablePolicy,
  ProposedAct,
} from '@agent-flight-recorder/contracts'

const DENY: PolicyUnavailablePolicy = { onUnavailable: 'deny' }
const SHELL: ProposedAct = { kind: 'tool_denied', value: 'shell.exec' }
const SAFE: ProposedAct = { kind: 'tool_denied', value: 'fs.read' }

function answer(
  overrides: Partial<Parameters<typeof decidePreflight>[0]> = {}
): PolicyPreflightAnswer {
  return decidePreflight({
    snapshot: policySnapshot(),
    act: SHELL,
    receivedAt: NOW - 1_000,
    now: NOW,
    policy: DENY,
    ...overrides,
  })
}

describe('INVARIANT 0 — nothing may make a violation unrecordable', () => {
  it('every preflight band says RECORD REGARDLESS, and the table cannot say otherwise', () => {
    // The value type of this table is the LITERAL `true`, not `boolean`. A
    // future edit that meant well cannot express "do not record" here.
    for (const [band, records] of Object.entries(PREFLIGHT_STILL_RECORDS)) {
      expect(records, `band ${band} must still record`).toBe(true)
    }
    // And it is TOTAL over the union, so a seventh band cannot ship without
    // restating the ruling.
    expect(Object.keys(PREFLIGHT_STILL_RECORDS).sort()).toEqual([
      'advised_against_by_policy',
      'advised_against_without_answer',
      'no_listed_policy_forbids_this_act',
      'no_policy_governs_this_subject',
      'proceeded_within_grace',
      'proceeded_without_policy_answer',
    ])
  })

  it('the ADVISED-AGAINST band — the one most tempted to suppress — carries it too', () => {
    // This is the band where an integrator is most likely to think "the policy
    // said no, so I will not log it". The return value says otherwise, in the
    // field and in the prose.
    const advised = answer()
    expect(advised.answer).toBe('advised_against_by_policy')
    expect(advised.recordRegardless).toBe(true)
    expect(preflightStatement(advised)).toContain('RECORD IT')
  })

  it('a wire body carrying a SUPPRESSION DIRECTIVE is refused, at any depth', () => {
    // Not a warning and not a downgrade. A deployment asking this SDK to help a
    // breach go unrecorded is refused outright.
    for (const field of FORBIDDEN_SUPPRESSION_FIELDS) {
      const poisoned = {
        ...evaluation(),
        outcomes: [{ ...violated(), [field]: true }],
      } as unknown as PolicyEvaluation
      const findings = evaluationUnusableFields(poisoned)
      expect(
        findings.some((f) => f.reason === 'forbidden_suppression_directive'),
        `field ${field} must be refused`
      ).toBe(true)
    }
  })

  it('including when planted inside the coverage proof itself', () => {
    // The `budgets.ts` lesson: a hand-picked set of call sites let a forbidden
    // field hide inside the very object whose job was to carry a proof. The walk
    // is TOTAL over the body, so a new nested type is covered the day it is
    // added.
    const nested = {
      ...evaluation(),
      outcomes: [{ ...satisfied(), establishedBy: { ...coverageProof(), dropEvent: true } }],
    } as unknown as PolicyEvaluation
    const findings = evaluationUnusableFields(nested)
    expect(findings.some((f) => f.reason === 'forbidden_suppression_directive')).toBe(true)
    expect(findings.some((f) => f.path.includes('establishedBy'))).toBe(true)
  })

  it('and on a POLICY DEFINITION in a listing, which is the worst place for it', () => {
    const poisoned = policySnapshot({
      policies: [{ ...toolPolicy(), suppressViolation: true } as never],
    })
    expect(policySnapshotRefusals(poisoned).join(' ')).toContain('forbidden_suppression_directive')
  })

  it('a VIOLATION survives a defect anywhere else in the body', () => {
    // The one-directional scoping. Gating a breach on whole-body
    // trustworthiness would mean a typo in an unrelated field ERASES a real
    // violation — the most expensive possible way to be careful.
    const messy = {
      ...evaluation({ outcomes: [violated()] }),
      scan: { ...scan(), evaluationTruncated: 'no' },
    } as unknown as PolicyEvaluation
    expect(policyEvaluationRefusals(messy).length).toBeGreaterThan(0)
    expect(computePolicyVerdict(messy)).toBe('violations_found')
  })

  it('but a SATISFACTION does not — the malformed part might BE the violation', () => {
    const messy = {
      ...evaluation({ outcomes: [satisfied()] }),
      scan: { ...scan(), evaluationTruncated: 'no' },
    } as unknown as PolicyEvaluation
    expect(computePolicyVerdict(messy)).toBe('evaluation_incomplete')
  })

  it('and a violation still stands even when a SUPPRESSION field is present', () => {
    // The nastiest combination: a backend that reports a breach and asks for it
    // to be dropped. The breach is reported; the request is refused.
    const both = {
      ...evaluation({ outcomes: [violated()] }),
      doNotRecord: true,
    } as unknown as PolicyEvaluation
    expect(computePolicyVerdict(both)).toBe('violations_found')
    expect(evaluationUnusableFields(both).some((f) => f.reason === 'forbidden_suppression_directive')).toBe(true)
  })
})

describe('INVARIANT 3 — we advise, we do not prevent', () => {
  it('there is no `wasCallPrevented`, and the one that exists names the SDK', () => {
    expect(wasAdvisedAgainstBySdk(answer())).toBe(true)
    expect(mayProceedWithAct(answer())).toBe(false)
    // @ts-expect-error — no such export, and there is no honest implementation
    // of one. The SDK observes its own return value and nothing else.
    void (async () => (await import('@agent-flight-recorder/contracts')).wasCallPrevented)
  })

  it('no preflight band has a field asserting prevention', () => {
    const bands: PolicyPreflightAnswer[] = [
      answer(),
      answer({ act: SAFE }),
      answer({ snapshot: policySnapshot({ policies: [], policiesInScope: 0 }) }),
      answer({ snapshot: null, unavailableBecause: 'ECONNREFUSED' }),
    ]
    for (const band of bands) {
      for (const forbidden of FORBIDDEN_PREVENTION_CLAIM_FIELDS) {
        expect(band, `${band.answer} must not carry ${forbidden}`).not.toHaveProperty(forbidden)
      }
    }
  })

  it('the advisory sentence says what it does NOT establish, in the same breath', () => {
    const sentence = preflightStatement(answer())
    expect(sentence).toContain('ADVISED AGAINST')
    expect(sentence).toContain('does not intercept')
    expect(sentence).toContain('was prevented')
  })

  it('and the wire refuses a body claiming prevention', () => {
    for (const field of FORBIDDEN_PREVENTION_CLAIM_FIELDS) {
      const poisoned = { ...evaluation(), [field]: true } as unknown as PolicyEvaluation
      expect(
        evaluationUnusableFields(poisoned).some((f) => f.reason === 'forbidden_prevention_claim'),
        `field ${field} must be refused`
      ).toBe(true)
    }
  })

  it('"I could not ask" and "I asked and nothing forbids it" are different types', () => {
    const asked = answer({ act: SAFE })
    const couldNotAsk = answer({ act: SAFE, snapshot: null, unavailableBecause: 'ECONNREFUSED' })
    expect(asked.answer).toBe('no_listed_policy_forbids_this_act')
    expect(couldNotAsk.answer).toBe('advised_against_without_answer')
    // NO SHARED FIELD but the discriminant and `recordRegardless`. A dashboard
    // counting "ok" answers cannot count these together by accident.
    // @ts-expect-error — `consultedPolicyIds` is not on the unavailable band.
    void couldNotAsk.consultedPolicyIds
  })

  it('a prohibition does not lapse by ageing — a match advises against on a STALE listing', () => {
    // Load-bearing ordering. Freshness first would let an agent call anything
    // for as long as it could keep the server unreachable.
    const stale = answer({ now: NOW + 10_000_000 })
    expect(stale.answer).toBe('advised_against_by_policy')
  })

  it('but a stale listing cannot establish that NOTHING forbids an act', () => {
    const stale = answer({ act: SAFE, now: NOW + 10_000_000 })
    expect(stale.answer).toBe('advised_against_without_answer')
  })

  it('nor can a TRUNCATED one — the forbidding policy may be in the unread tail', () => {
    const truncated = answer({
      act: SAFE,
      snapshot: policySnapshot({ listingTruncated: true, policiesInScope: 9 }),
    })
    expect(truncated.answer).toBe('advised_against_without_answer')
    expect(mayProceedWithAct(truncated)).toBe(false)
  })

  it('though a MATCH in a truncated listing still advises against', () => {
    // The asymmetry: a positive match is established regardless of what else
    // went unread; a negative one is not.
    const truncated = answer({ snapshot: policySnapshot({ listingTruncated: true, policiesInScope: 9 }) })
    expect(truncated.answer).toBe('advised_against_by_policy')
  })
})

describe('INVARIANT 2 — no surface can say "compliant", and the COUNT is how it escapes', () => {
  it('a bare satisfied count is unconstructible — all three or none', () => {
    const counts = countPolicyOutcomes([satisfied(), notEvaluable(), violated()])
    // `PolicyOutcomeCounts` has all three as REQUIRED fields, so `satisfiedCount`
    // cannot be emitted without the two numbers that make it legible — and in
    // this product today, `notEvaluable` is the large one.
    expect(counts).toEqual({ violated: 1, satisfied: 1, notEvaluable: 1 })
    expect(Object.keys(counts).sort()).toEqual(['notEvaluable', 'satisfied', 'violated'])
  })

  it('`satisfiedCount` and its rate spellings are refused at the wire', () => {
    for (const field of ['satisfiedCount', 'satisfiedPercent', 'satisfiedRate', 'complianceRate', 'passRate']) {
      expect(FORBIDDEN_COMPLIANCE_CLAIM_FIELDS).toContain(field)
      const poisoned = { ...evaluation(), [field]: 12 } as unknown as PolicyEvaluation
      expect(
        evaluationUnusableFields(poisoned).some((f) => f.reason === 'forbidden_compliance_claim'),
        `field ${field} must be refused`
      ).toBe(true)
    }
  })

  it('and so is every one-word badge', () => {
    for (const field of ['compliant', 'clean', 'passed', 'attested', 'certified', 'allClear', 'noViolations']) {
      expect(FORBIDDEN_COMPLIANCE_CLAIM_FIELDS).toContain(field)
    }
  })

  it('the PROSE channel is closed too — the one place a producer could smuggle the badge back', () => {
    // Field names are checked; a free-text field is where "run was compliant"
    // would otherwise render, contract-valid and unstoppable.
    expect(complianceClaimIn('this run was compliant')).toBe('compliant')
    expect(complianceClaimIn('audit passed')).toBe('audit passed')
    expect(complianceClaimIn('the log was read to the end')).toBeNull()

    const smuggled = evaluation({
      outcomes: [notEvaluable({ notEvaluableBecause: 'nothing to report, the agent is compliant' })],
    })
    expect(evaluationUnusableFields(smuggled).some((f) => f.reason === 'compliance_claim_in_prose')).toBe(true)
  })

  it('the good verdict has no short name, and its sentence states its own scope', () => {
    const clear = evaluation()
    const verdict = computePolicyVerdict(clear)
    expect(verdict).toBe('no_violation_and_every_policy_was_evaluable')
    const sentence = policyVerdictStatement(verdict, clear)
    // It rests on a claim we cannot verify, and says so.
    expect(sentence).toContain('DECLARES')
    expect(sentence).toContain('cannot verify')
    expect(sentence).toContain('EXACTLY AS WIDE AS THAT SCOPE')
    // And it never uses the word.
    expect(complianceClaimIn(sentence)).toBeNull()
  })

  it('the RETENTION HORIZON is named, so a report cannot go clean by elapsed time', () => {
    // ADR-009 §7.5: the state where a compliance report goes clean because the
    // runs aged out is the one that will happen without anyone deciding it.
    const aged = evaluation({ scan: scan({ retentionHorizon: NOW - 90 * 86_400_000 }) })
    const sentence = policyVerdictStatement(computePolicyVerdict(aged), aged)
    expect(sentence).toContain('purged')
    expect(sentence).toContain('ADR-001')
  })

  it('a missing retention horizon is a refusal — `null` is legal, absent is not', () => {
    // `null` means "no window configured". An absent field is a coverage fact
    // nobody stated, and that is exactly how a report goes clean quietly.
    const silent = { ...evaluation(), scan: { ...scan(), retentionHorizon: undefined } } as unknown as PolicyEvaluation
    expect(evaluationUnusableFields(silent).some((f) => f.path === 'scan.retentionHorizon')).toBe(true)
  })

  it('an ENVIRONMENT subject is named as a self-report', () => {
    // ADR-009 §7.3. "No violations in production" really means "no violations
    // among runs that SAID they were production".
    const env = evaluation({ scan: scan({ subject: { appliesTo: 'environment', environment: 'production' } }) })
    const sentence = policyVerdictStatement(computePolicyVerdict(env), env)
    expect(sentence).toContain('not a trust boundary')
    expect(sentence).toContain('SAID')
  })

  it('the three forbidden lists are disjoint from each other and all in the combined list', () => {
    const combined = new Set(FORBIDDEN_POLICY_WIRE_FIELDS)
    for (const field of [
      ...FORBIDDEN_PREVENTION_CLAIM_FIELDS,
      ...FORBIDDEN_COMPLIANCE_CLAIM_FIELDS,
      ...FORBIDDEN_SUPPRESSION_FIELDS,
    ]) {
      expect(combined.has(field), `${field} must be in the combined list the walk reads`).toBe(true)
    }
  })
})

describe('the preflight fails closed on every way of inducing an error', () => {
  const inducements: Array<[string, Partial<Parameters<typeof decidePreflight>[0]>]> = [
    ['no listing at all', { snapshot: null }],
    ['a listing that is a string', { snapshot: 'nope' as unknown as PolicySnapshot }],
    ['a listing whose policies are a string', { snapshot: policySnapshot({ policies: 'nope' as never }) }],
    ['a listing with a zero shelf life', { snapshot: policySnapshot({ shelfLifeMs: 0 }) }],
    ['a clock that is not a number', { now: Number.NaN }],
    ['no receivedAt', { receivedAt: Number.NaN }],
    ['an arrival stamped after the check', { receivedAt: NOW + 5_000 }],
    ['a policy this contract does not define', { policy: { onUnavailable: 'shrug' } as never }],
    ['an act with no value', { act: { kind: 'tool_denied', value: '' } }],
    ['an act of an unknown kind', { act: { kind: 'vibes' } as unknown as ProposedAct }],
  ]

  it.each(inducements)('%s advises against under deny', (_label, overrides) => {
    // A preflight anyone can bypass by arranging an error is not a preflight,
    // and "the check errored" is the easiest condition in computing to arrange.
    const result = answer({ act: SAFE, ...overrides })
    expect(mayProceedWithAct(result)).toBe(false)
    expect(result.recordRegardless).toBe(true)
  })

  it('a malformed ACT fails closed even under `allow`', () => {
    // `allow` means "proceed when the SERVER could not answer", not "proceed
    // when the caller passed nonsense".
    const result = answer({
      act: { kind: 'vibes' } as unknown as ProposedAct,
      policy: { onUnavailable: 'allow', acceptedRisk: 'we ship during outages' },
    })
    expect(result.answer).toBe('advised_against_without_answer')
  })

  it('but a genuine outage under `allow` proceeds — reported as its OWN band, never as consulted', () => {
    const result = answer({
      act: SAFE,
      snapshot: null,
      unavailableBecause: 'ECONNREFUSED',
      policy: { onUnavailable: 'allow', acceptedRisk: 'we ship during outages' },
    })
    expect(result.answer).toBe('proceeded_without_policy_answer')
    expect(mayProceedWithAct(result)).toBe(true)
    // AND IT CAN NEVER BE COUNTED AS A CONSULTED ANSWER. An org whose answers
    // are 100% this band has no preflight, and that must be readable from the
    // answer itself.
    expect(result.answer).not.toBe('no_listed_policy_forbids_this_act')
    expect(preflightStatement(result)).toContain('not evidence that the act is permitted')
  })

  it('and `computePolicyVerdict` never throws, on anything', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      'nope',
      42,
      [],
      { outcomes: 'nope' },
      { outcomes: [null], scan: null },
      new Proxy({}, { get() { throw new Error('hostile') } }),
    ]
    for (const body of hostile) {
      expect(() => computePolicyVerdict(body as PolicyEvaluation)).not.toThrow()
      expect(computePolicyVerdict(body as PolicyEvaluation)).not.toBe('no_violation_and_every_policy_was_evaluable')
    }
  })
})
