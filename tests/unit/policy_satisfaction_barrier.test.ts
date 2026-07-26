/**
 * THE SATISFACTION BARRIER — proving `not_evaluable` cannot render as
 * `satisfied`, and that `satisfied` cannot be constructed without a claim no
 * amount of reading can supply.
 *
 * ---------------------------------------------------------------------------
 * A COMPILE FAILURE IS THE EVIDENCE, AND `@ts-expect-error` IS HOW IT IS
 * ASSERTED
 * ---------------------------------------------------------------------------
 *
 * Most of this file does not run anything. `@ts-expect-error` inverts the build:
 * the annotated line MUST fail to typecheck, and if a future edit ever makes the
 * conflation LEGAL, the annotation becomes unused and `tsc` fails the build with
 * "Unused '@ts-expect-error' directive". That is a barrier that cannot rot
 * silently, which an ordinary runtime assertion can — a runtime test proves the
 * current implementation refuses something; these prove the type system cannot
 * express it at all.
 *
 * FIVE PROPERTIES ARE PROVEN HERE:
 *
 *  1. THE THREE OUTCOMES SHARE NO FIELD. Every shortcut that flattens them —
 *     `o.satisfiedPolicyId ?? o.undecidedPolicyId`, a template reading
 *     `o.policyId` — is a compile error rather than a code-review catch.
 *
 *  2. A COVERAGE PROOF NEEDS FIVE LITERAL-TYPED FIELDS. A truncated read, an
 *     in-flight run, an externalized deciding field, contaminated rows, or a
 *     found violation each make it unspellable.
 *
 *  3. AND A SIXTH FIELD THAT READING CANNOT SUPPLY. `{ claims: 'undeclared' }`
 *     is not assignable, so `satisfied` is UNREACHABLE for an agent that has
 *     not declared its instrumentation — which is every agent in the product
 *     today. This is the deepest limit in the feature (ADR-009 §7.1) and it is
 *     asserted here as a type error, not a paragraph.
 *
 *  4. `SatisfactionLicence` IS A ONE-MEMBER UNION, and a violation proof is not
 *     assignable to it. The cheap positive proof cannot be recycled into the
 *     expensive negative one.
 *
 *  5. VACUOUS SATISFACTION IS UNCONSTRUCTIBLE. An evaluation over zero runs
 *     never reaches the all-clear verdict, at the type level and at the wire.
 */
import {
  computePolicyVerdict,
  isAllClear,
  isCoverageProof,
  isEstablishedSatisfied,
  policyEvaluationRefusals,
  policyOutcomeStatement,
  ruleIsDecidableFromEventTypeAlone,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import {
  coverageProof,
  declared,
  evaluation,
  notEvaluable,
  satisfied,
  scan,
  violated,
  violationProof,
} from './policy_fixtures.js'

import type {
  PolicyCoverageProof,
  PolicyOutcome,
  SatisfactionLicence,
} from '@agent-flight-recorder/contracts'

describe('1 — the three outcomes share no field, so no template handles two', () => {
  it('there is no `policyId` common to the three', () => {
    const outcome: PolicyOutcome = notEvaluable()
    // @ts-expect-error — `policyId` exists on none of the three bands. A renderer
    // that reaches for it cannot compile, which is the whole reason the ids are
    // spelled `violatedPolicyId` / `satisfiedPolicyId` / `undecidedPolicyId`.
    void outcome.policyId
  })

  it('the flattening shortcut does not compile', () => {
    const outcome: PolicyOutcome = notEvaluable()
    // @ts-expect-error — `satisfiedPolicyId` is not a property of the union.
    // `o.satisfiedPolicyId ?? o.undecidedPolicyId` is the exact expression that
    // turns "we could not look" into "there was nothing to find", and it is a
    // compile error rather than a review catch.
    void outcome.satisfiedPolicyId
  })

  it('a not-evaluable outcome is not assignable to a satisfied one', () => {
    // @ts-expect-error — distinct discriminants and NO shared field. This is the
    // single conflation this whole feature exists to prevent.
    const asSatisfied: import('@agent-flight-recorder/contracts').PolicySatisfied = notEvaluable()
    void asSatisfied
  })

  it('and neither is a violated one, in either direction', () => {
    // @ts-expect-error — a violation is not a satisfaction.
    const a: import('@agent-flight-recorder/contracts').PolicySatisfied = violated()
    // @ts-expect-error — nor the reverse.
    const b: import('@agent-flight-recorder/contracts').PolicyViolated = satisfied()
    void a
    void b
  })

  it('at runtime, only `satisfied` reads as an established satisfaction', () => {
    expect(isEstablishedSatisfied(satisfied())).toBe(true)
    expect(isEstablishedSatisfied(notEvaluable())).toBe(false)
    expect(isEstablishedSatisfied(violated())).toBe(false)
    // A band this contract does not define fails CLOSED. The dangerous guess is
    // `true`.
    expect(isEstablishedSatisfied({ outcome: 'probably_fine' } as unknown as PolicyOutcome)).toBe(false)
  })

  it('and the rendered sentence for not-evaluable says it is NOT an all-clear', () => {
    const sentence = policyOutcomeStatement(notEvaluable())
    expect(sentence).toContain('NOT EVALUABLE')
    expect(sentence).toContain('NOT an all-clear')
    // The remedy travels with it. A band that reads as a shrug is one people
    // learn to configure around, and configuring around this one means turning
    // it into a green tick.
    expect(sentence).toContain('To decide it:')
  })
})

describe('2 — a coverage proof needs five literal-typed fields', () => {
  it('a TRUNCATED read cannot be spelled', () => {
    // @ts-expect-error — `false` is not assignable to `true`. An engine that
    // stopped on a page ceiling cannot construct a licence.
    const proof: PolicyCoverageProof = { ...coverageProof(), logReadComplete: false }
    void proof
  })

  it('an IN-FLIGHT run cannot be spelled', () => {
    // @ts-expect-error — a run with no terminal event may yet do the forbidden
    // thing. "No violation so far" is a stopwatch, not a finding.
    const proof: PolicyCoverageProof = { ...coverageProof(), runIsTerminal: false }
    void proof
  })

  it('an EXTERNALIZED deciding field cannot be spelled', () => {
    // @ts-expect-error — Event Log Rule 3 sends payloads over 10 KB to blob
    // storage and the tool name goes with them. This is the common production
    // case, and it is `not_evaluable`, not a pass.
    const proof: PolicyCoverageProof = { ...coverageProof(), payloadsAllReadable: false }
    void proof
  })

  it('CONTAMINATED rows cannot be spelled', () => {
    // @ts-expect-error — `0` is the literal type. A read that touched rows it
    // could not account for has not established a tenancy-clean result.
    const proof: PolicyCoverageProof = { ...coverageProof(), crossOrgRowsSkipped: 1 }
    void proof
  })

  it('and a proof that FOUND something cannot establish satisfaction', () => {
    // @ts-expect-error — self-refuting, and it will not compile.
    const proof: PolicyCoverageProof = { ...coverageProof(), forbiddenOperationsFound: 2 }
    void proof
  })

  it('each of those is ALSO refused at the wire, where types do not reach', () => {
    // The type system stops at the JSON boundary. Every literal is re-checked
    // with `===`, because `"false"` is truthy and `undefined` is not `0` — and
    // either would otherwise license an all-clear.
    const rule = { kind: 'tool_denied' } as const
    expect(isCoverageProof(coverageProof(), rule)).toBe(true)
    for (const broken of [
      { logReadComplete: 'yes' },
      { logReadComplete: undefined },
      { runIsTerminal: false },
      { payloadsAllReadable: 'true' },
      { crossOrgRowsSkipped: '0' },
      { forbiddenOperationsFound: 1 },
    ]) {
      const proof = { ...coverageProof(), ...broken } as unknown as SatisfactionLicence
      expect(isCoverageProof(proof, rule)).toBe(false)
    }
  })
})

describe('3 — THE SIXTH FIELD: satisfaction is unreachable without an agent declaration', () => {
  /**
   * ADR-009 §7.1, and the reason it is a type error rather than a comment:
   *
   * All five fields above are properties of THE READ. Every one is satisfiable
   * over a run that egressed to a forbidden host through an uninstrumented
   * `fetch` — `Events.httpRequest` is a manual builder and there is no
   * interception anywhere in `packages/sdk/src`. A complete read of an
   * incomplete recording proves nothing about the world, and no sixth field
   * obtainable BY READING would change that, because the missing fact was never
   * written.
   */
  it('an UNDECLARED agent cannot be given a coverage proof', () => {
    // @ts-expect-error — `{ claims: 'undeclared' }` is not assignable to
    // `CompleteInstrumentationClaim`. THIS IS THE DEEPEST BARRIER IN THE
    // FEATURE: today no agent declares, so `satisfied` is unconstructible for
    // every agent in the product — which is the honest answer, exactly as
    // `provably_under` is unreachable for a counter-backed budget.
    const proof: PolicyCoverageProof = { ...coverageProof(), instrumentation: { claims: 'undeclared' } }
    void proof
  })

  it('a declaration covering NOTHING cannot be spelled', () => {
    const claim: import('@agent-flight-recorder/contracts').CompleteInstrumentationClaim = {
      ...declared(),
      // @ts-expect-error — `coversOperations` is non-empty by type. A claim that
      // covers nothing is not a claim.
      coversOperations: [],
    }
    void claim
  })

  it('a TOOL-CALL declaration does not license an EGRESS all-clear', () => {
    // The conflation the `coversOperations` field exists to prevent, checked at
    // the wire because a JSON body can pair any claim with any rule. An agent
    // that says "I record all my tool calls" has said NOTHING about whether it
    // records its HTTP.
    const toolOnly = coverageProof({ instrumentation: declared({ coversOperations: ['tool_denied'] }) })
    expect(isCoverageProof(toolOnly, { kind: 'tool_denied' })).toBe(true)
    expect(isCoverageProof(toolOnly, { kind: 'egress_denied' })).toBe(false)
  })

  it('a declaration with no stated MECHANISM is refused at the wire', () => {
    // "How" is what makes the claim falsifiable. A declaration nobody can check
    // against a mechanism is an assertion, and an assertion cannot license an
    // all-clear.
    const vague = coverageProof({ instrumentation: declared({ mechanism: '' }) })
    expect(isCoverageProof(vague, { kind: 'tool_denied' })).toBe(false)
  })

  it('and an evaluation whose satisfied outcome lacks a declaration is refused', () => {
    const undeclaredBody = evaluation({
      outcomes: [
        satisfied({
          establishedBy: {
            ...coverageProof(),
            instrumentation: { claims: 'undeclared' },
          } as unknown as SatisfactionLicence,
        }),
      ],
    })
    expect(policyEvaluationRefusals(undeclaredBody)).toContain(
      'outcomes[0].establishedBy: unusable_coverage_proof'
    )
    // AND THE VERDICT IS NOT THE ALL-CLEAR. That is the property that actually
    // matters: a refusal nobody acts on is decoration.
    expect(computePolicyVerdict(undeclaredBody)).toBe('evaluation_incomplete')
    expect(isAllClear(computePolicyVerdict(undeclaredBody))).toBe(false)
  })

  it('the honest path — a DECLARED agent CAN reach the all-clear', () => {
    // The discriminating test. Without this the suite above would pass just as
    // well if `satisfied` were unreachable for every reason, including a bug.
    expect(computePolicyVerdict(evaluation())).toBe('no_violation_and_every_policy_was_evaluable')
    expect(isAllClear(computePolicyVerdict(evaluation()))).toBe(true)
  })
})

describe('4 — the licence is a one-member union, and a violation proof is not one', () => {
  it('a violation proof is not assignable to a satisfaction licence', () => {
    // @ts-expect-error — `proves: "forbidden_operation_recorded"` is not
    // `proves: "complete_log_read_found_nothing"`. The CHEAP positive proof
    // cannot be recycled into the EXPENSIVE negative one, which is the entire
    // evidential asymmetry of this feature expressed as an assignability rule.
    const licence: SatisfactionLicence = violationProof()
    void licence
  })

  it('and the wire agrees', () => {
    expect(isCoverageProof(violationProof() as unknown as SatisfactionLicence, { kind: 'tool_denied' })).toBe(false)
  })

  it('a licence for a DIFFERENT policy is a claim contradiction, not a pass', () => {
    const crossed = evaluation({
      outcomes: [satisfied({ establishedBy: coverageProof({ forPolicyId: 'policy_OTHER' }) })],
    })
    expect(policyEvaluationRefusals(crossed).join(' ')).toContain('proof_for_a_different_policy_or_run')
    expect(computePolicyVerdict(crossed)).toBe('evaluation_incomplete')
  })
})

describe('5 — vacuous satisfaction is unreachable', () => {
  it('zero policies in scope is its OWN verdict, never the all-clear', () => {
    const nothing = evaluation({
      outcomes: [],
      scan: scan({ policiesInScope: 0, policiesEvaluated: 0, runsInScope: 0, runsRead: 0 }),
    })
    const verdict = computePolicyVerdict(nothing)
    expect(verdict).toBe('no_policy_governs_this_subject')
    expect(isAllClear(verdict)).toBe(false)
  })

  it('an UNREAD run narrows every satisfaction in the body', () => {
    // Each outcome may be individually well-licensed and the evaluation still
    // not cover the subject somebody asked about.
    const partial = evaluation({ scan: scan({ runsInScope: 10, runsRead: 1 }) })
    expect(computePolicyVerdict(partial)).toBe('evaluation_incomplete')
  })

  it('an UNEVALUATED policy does too', () => {
    const partial = evaluation({ scan: scan({ policiesInScope: 4, policiesEvaluated: 1 }) })
    expect(computePolicyVerdict(partial)).toBe('evaluation_incomplete')
  })

  it('a TRUNCATED scan does too', () => {
    expect(computePolicyVerdict(evaluation({ scan: scan({ evaluationTruncated: true }) }))).toBe(
      'evaluation_incomplete'
    )
  })

  it('and a single not-evaluable outcome beside a satisfied one does too', () => {
    const mixed = evaluation({
      outcomes: [satisfied(), notEvaluable({ undecidedPolicyId: 'policy_2' })],
      scan: scan({ policiesInScope: 2, policiesEvaluated: 2 }),
    })
    expect(computePolicyVerdict(mixed)).toBe('evaluation_incomplete')
  })
})

describe('the one case where an externalized payload still proves a violation', () => {
  /**
   * ADR-009 §4.3, and the boundary matters as much as the rule. When a rule
   * denies the OPERATION itself, the event TYPE decides it, and the type
   * survives externalization. Which tool it was cannot change the answer,
   * because nothing is permitted.
   */
  it('a rule denying ALL tools is decidable from the event type alone', () => {
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied' })).toBe(true)
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'egress_denied' })).toBe(true)
  })

  it('a rule naming EVEN ONE target is not', () => {
    // THE BOUNDARY IS `undefined`, NEVER "a short list". A contributor who
    // widens this has manufactured proofs: the type says a tool was called, and
    // the rule only forbids some tools.
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied', deniedTools: ['shell.exec'] })).toBe(false)
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'egress_denied', deniedHosts: ['evil.example'] })).toBe(false)
    // Even an EMPTY list is a list — the producer said "these specific ones",
    // and named none. That is a misconfiguration, not a deny-all.
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
  })

  it('a type-alone proof against a TARGETED rule is a claim contradiction', () => {
    const manufactured = evaluation({
      outcomes: [
        violated({
          violatedRule: { kind: 'tool_denied', deniedTools: ['shell.exec'] },
          provenBy: [violationProof({ decidedBy: 'event_type_alone', observedValue: null })],
        }),
      ],
    })
    expect(policyEvaluationRefusals(manufactured).join(' ')).toContain('type_alone_against_a_targeted_rule')
  })

  it('but against a DENY-ALL rule the same proof is sound', () => {
    const sound = evaluation({
      outcomes: [
        violated({
          violatedRule: { kind: 'tool_denied' },
          provenBy: [violationProof({ decidedBy: 'event_type_alone', observedValue: null })],
        }),
      ],
    })
    expect(policyEvaluationRefusals(sound).join(' ')).not.toContain('type_alone_against_a_targeted_rule')
    expect(computePolicyVerdict(sound)).toBe('violations_found')
  })
})
