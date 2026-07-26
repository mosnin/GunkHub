/**
 * DECLARATIVE TOOL POLICY — ADVERSARIAL SUITE, ENGINE LAYER (Team D)
 *
 * SUBJECT: `convex/helpers/policy.ts` — `observeRunAgainstPolicy`,
 * `foldPolicyOutcome`, `isPolicyCoverageComplete`, `buildPolicyScanReport`,
 * `isInterpretableRule`, `policyGovernsRun`, and the deciding-field readers —
 * plus the contract predicates the engine now delegates to
 * (`instrumentationCovers`, `ruleIsDecidableFromEventTypeAlone`).
 *
 * ── LIVE DEFECT (§D6) ────────────────────────────────────────────────────
 * A recorded egress to a denied host can be reported as an all-clear. Host
 * EXTRACTION and host MATCHING now live in different modules with different
 * vocabularies: `readEgressHost` returns a bare hostname for a `host`-shaped
 * payload, and the contract's `actIsForbiddenBy` only parses full URLs, so the
 * bare-host spelling matches nothing and — with a complete instrumentation
 * claim — clears. `readEgressHost`'s own doc comment records this module having
 * already paid for this exact split once, with the polarity reversed. §D6
 * asserts the CURRENT behaviour with `toBe`, so the fix cannot land silently.
 *
 * ── STATUS: ALL FOUR OF THIS SUITE'S EARLIER DEFECTS ARE FIXED ───────────
 * Every earlier §D finding is retired, and each is now a REGRESSION
 * (§R) asserting the corrected behaviour ON THE EXACT ADVERSARIAL FIXTURE THAT
 * USED TO DEFEAT IT. A retirement is never expressed as "nothing was recorded":
 * delete a fix and this suite goes red.
 *
 *   D0 clean-path-throws          -> R0. Every branch returns; and every
 *                                   sentence the module can emit is swept
 *                                   through both claim guards, which is the
 *                                   check that would have caught it blind.
 *   D5 tool-kind-has-no-gate      -> R5. `satisfied` now requires a
 *                                   `CompleteInstrumentationClaim` STRUCTURALLY,
 *                                   for both rule kinds.
 *   D1 unmapped-spans-invisible   -> R1. `otel.span.unmapped` is undecidable for
 *                                   EVERY rule kind, not merely for the kind
 *                                   whose deciding type it is not.
 *   D2 empty-list-widens-silently -> R2. `isInterpretableRule` rejects `[]` as a
 *                                   misconfiguration, checked at EVALUATION time
 *                                   and not only at write time.
 *   D3 lossy-provenance-swallowed -> R3. `PolicyObservableEvent.provenance`
 *                                   exists; a lossy derived event is undecidable
 *                                   and `orderingCaveat` propagates.
 *
 * ── THE NEW ATTACK THIS ITERATION (§N) ───────────────────────────────────
 * The fix for D5 moved the precondition into the TYPE, which is stronger than a
 * gate — so the question becomes whether the type can be got round. §N attacks
 * exactly that: is there ANY path to `satisfied` without a complete claim, and
 * does a claim scoped to one operation class license an all-clear about the
 * other? Both are swept over every rule kind rather than spot-checked.
 *
 * ── THE LESSON THIS FILE CARRIES ─────────────────────────────────────────
 * From `budget_adversarial_engine.test.ts`: AN ADVERSARIAL SUITE IS NOT EXEMPT
 * FROM THE FAILURE IT HUNTS. It has now happened three times in this file, all
 * three caught by execution, all three recorded rather than quietly corrected:
 *
 *   1. The first version asserted `satisfied` in eight places, in the direction
 *      of my own belief that the fold RETURNS. It threw (D0).
 *   2. The second version then asserted the THROW in eight places. The owning
 *      team fixed D0 minutes later and all eight went red. A check pinned to a
 *      DEFECT is as brittle as one pinned to a belief.
 *   3. This version's predecessor called `observeRunAgainstPolicy(rule, ...)`
 *      with a bare RULE. The signature now takes a POLICY DEFINITION, and that
 *      is not a cosmetic widening: `ruleForbidsValue` delegates to the
 *      contract's `actIsForbiddenBy`, which ALSO honours `enabled`. Every D2
 *      check I wrote was therefore exercising a narrower predicate than it
 *      claimed — matching alone, never the policy. §N3 tests the part I was
 *      missing.
 *
 * The repair is the one that keeps working: assertions grade a captured
 * OUTCOME-OR-THROW, branch coverage is derived by MUTATING INPUTS rather than
 * from any list of what the engine currently does, and subjects are enumerated
 * from shipped constants (`POLICY_RULE_KINDS`, `POLICY_NOT_EVALUABLE_KINDS`).
 */
import {
  instrumentationCovers,
  isEstablishedSatisfied,
  ruleIsDecidableFromEventTypeAlone,
  POLICY_NOT_EVALUABLE_KINDS,
  POLICY_RULE_KINDS,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import * as engine from '../../convex/helpers/policy.js'
import {
  buildPolicyScanReport,
  executionClaimIn,
  foldPolicyOutcome,
  isInterpretableRule,
  isPolicyCoverageComplete,
  noRunsInScopeOutcome,
  observeRunAgainstPolicy,
  policyGovernsRun,
  producerComplianceClaimIn,
  unopenedRunOutcome,
} from '../../convex/helpers/policy.js'

import type { PolicyObservableEvent, PolicyOutcome, PolicyRunReadFacts } from '../../convex/helpers/policy.js'
import type {
  InstrumentationClaim,
  PolicyDefinition,
  PolicyEvaluationScan,
  PolicyRule,
  PolicyRuleKind,
} from '@agent-flight-recorder/contracts'

const FORBIDDEN_TOOL = 'prod-db:delete_all_rows'
const RUN = 'run_1'
const AT = 1_700_000_000_000

/** The only claim arm that can license an all-clear, scoped to the kinds named. */
function completeClaim(...covers: PolicyRuleKind[]): InstrumentationClaim {
  return {
    claims: 'complete',
    coversOperations: covers as [PolicyRuleKind, ...PolicyRuleKind[]],
    mechanism: 'all outbound HTTP goes through recordedFetch(); every tool is invoked via recordedTool()',
    claimedByAgentVersionId: 'ver_1',
    claimedAt: AT,
  }
}

function policy(rule: PolicyRule, overrides: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    policyId: 'pol_1',
    orgId: 'org_1',
    name: 'no destructive tools',
    rationale: 'Destructive database tools are not permitted from agent code.',
    revision: 3,
    rule,
    subject: { appliesTo: 'org' },
    enabled: true,
    createdAt: AT,
    ...overrides,
  } as PolicyDefinition
}

/**
 * The BEST POSSIBLE read facts. `instrumentation` is left ABSENT by default,
 * because absent is the state of every agent in the product today and a fixture
 * that quietly declares completeness would test a world that does not exist.
 */
function perfectFacts(overrides: Partial<PolicyRunReadFacts> = {}): PolicyRunReadFacts {
  return {
    runId: RUN,
    runObserved: true,
    runIsTerminal: true,
    logReadComplete: true,
    crossOrgRowsSkipped: 0,
    observedAt: AT,
    ...overrides,
  }
}

/** Perfect facts PLUS a complete claim covering the kinds named — the only road to `satisfied`. */
function licensedFacts(...covers: PolicyRuleKind[]): PolicyRunReadFacts {
  return perfectFacts({ instrumentation: completeClaim(...covers) })
}

let seq = 0
function ev(type: string, payload: unknown, extra: Partial<PolicyObservableEvent> = {}): PolicyObservableEvent {
  seq += 1
  return { eventId: `ev_${seq}`, runId: RUN, type, sequenceNumber: seq, timestamp: AT, payload, ...extra }
}

/** CAPTURE, never assume — see lesson 1/2 in the header. */
type Result = { returned: true; outcome: PolicyOutcome } | { returned: false; error: string }

function fold(def: PolicyDefinition, events: PolicyObservableEvent[], facts = perfectFacts()): Result {
  try {
    return {
      returned: true,
      outcome: foldPolicyOutcome({
        policy: def,
        observation: observeRunAgainstPolicy(def, events, facts),
        evaluatedAt: AT,
      }),
    }
  } catch (err) {
    return { returned: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function outcomeOf(r: Result): PolicyOutcome {
  if (!r.returned) throw new Error(`expected an outcome, got a throw: ${r.error}`)
  return r.outcome
}

/**
 * Narrow to `violated`, or fail loudly.
 *
 * DELIBERATELY A NARROWING AND NOT A CAST. My first version of §S3/§S4 wrote
 * `as { provenBy: ... }` and the compiler refused it — `PolicyNotEvaluable` has
 * no `provenBy`, so the assertion "neither type sufficiently overlaps". That
 * refusal IS the property §S1 asserts, arriving as a compile error in my own
 * test. Casting past it would have disabled the very guarantee under test.
 */
function violatedOf(r: Result): Extract<PolicyOutcome, { outcome: 'violated' }> {
  const o = outcomeOf(r)
  if (o.outcome !== 'violated') throw new Error(`expected a violation, got ${bandOf(r)}`)
  return o
}

/** The band reached: the outcome word, or the not-evaluable `kind`. One string per branch. */
function bandOf(r: Result): string {
  const o = outcomeOf(r)
  return o.outcome === 'not_evaluable' ? o.kind : o.outcome
}

const TOOL_RULE: PolicyRule = { kind: 'tool_denied', deniedTools: [FORBIDDEN_TOOL] }
const EGRESS_RULE: PolicyRule = { kind: 'egress_denied', deniedHosts: ['evil.example.com'] }
const TOOL_DENIED = policy(TOOL_RULE)

/** A canonical NON-VACUOUS rule for each shipped kind, built from the kind constant. */
function ruleFor(kind: PolicyRuleKind): PolicyRule {
  return kind === 'tool_denied' ? TOOL_RULE : EGRESS_RULE
}

const CLEAN_CALL = () => ev('tool.call', { type: 'tool.call', name: 'docs:search' })
const VIOLATING_CALL = () => ev('tool.call', { type: 'tool.call', name: FORBIDDEN_TOOL })
const EXTERNALIZED_CALL = () =>
  ev('tool.call', { type: '_externalized', originalType: 'tool.call', _artifact: { artifactId: 'a' } })
const UNMAPPED_SPAN = () =>
  ev(
    'otel.span.unmapped',
    {
      type: 'otel.span.unmapped',
      spanName: 'execute_tool prod-db.delete_all_rows',
      spanKind: 'internal',
      reason: 'no-matching-rule',
      attributes: { 'tool.name': FORBIDDEN_TOOL },
      attributesTruncated: false,
    },
    { provenance: { source: 'otel' } },
  )

const EMPTY_SCAN: PolicyEvaluationScan = {
  subject: { appliesTo: 'org' },
  policiesInScope: 0,
  policiesEvaluated: 0,
  runsInScope: 0,
  runsRead: 0,
  evaluationTruncated: false,
  retentionHorizon: null,
  orderingCaveat: false,
}

// ===========================================================================
// §N — THE NEW ATTACK: CAN THE INSTRUMENTATION PRECONDITION BE GOT ROUND?
// ===========================================================================

describe('§N1 there is no path to `satisfied` without a complete, covering claim', () => {
  /**
   * The D5 fix moved the precondition into the TYPE:
   * `PolicyCoverageProof.instrumentation` is a `CompleteInstrumentationClaim`,
   * and `{ claims: "undeclared" }` is not assignable. That is stronger than a
   * gate somebody remembered to add — but a type only binds a caller that
   * typechecks, and the engine reads the claim off a `PolicyRunReadFacts` whose
   * field is OPTIONAL. So the question is whether any runtime path reaches the
   * `satisfied` band with the claim absent, malformed, or wrong-shaped.
   *
   * SWEPT, not spot-checked: every claim shape below, against every shipped
   * rule kind, on the otherwise-perfect fixture.
   */
  const NON_LICENSING_CLAIMS: Array<[string, unknown]> = [
    ['absent', undefined],
    ['undeclared', { claims: 'undeclared' }],
    ['complete but covering nothing', { ...completeClaim('tool_denied'), coversOperations: [] }],
    ['complete but coversOperations not an array', { ...completeClaim('tool_denied'), coversOperations: 'tool_denied' }],
    ['a bare true', true],
    ['null', null],
    ['a string', 'complete'],
    ['claims spelled wrong', { ...completeClaim('tool_denied'), claims: 'Complete' }],
    ['an empty object', {}],
  ]

  for (const kind of POLICY_RULE_KINDS) {
    for (const [label, claim] of NON_LICENSING_CLAIMS) {
      it(`${kind} + ${label} => NOT satisfied`, () => {
        const def = policy(ruleFor(kind))
        const facts = perfectFacts({ instrumentation: claim as InstrumentationClaim })
        const band = bandOf(fold(def, [CLEAN_CALL()], facts))
        expect(band).not.toBe('satisfied')
        // And it says WHICH thing is missing, rather than a bare refusal.
        expect(band).toBe('instrumentation_undeclared')
      })
    }
  }

  it('TEETH — the SAME fixture WITH a covering claim IS satisfied, for every kind', () => {
    // Without this the sweep above would pass just as happily against an engine
    // that could never say `satisfied` at all.
    for (const kind of POLICY_RULE_KINDS) {
      const def = policy(ruleFor(kind))
      const out = outcomeOf(fold(def, [CLEAN_CALL()], licensedFacts(kind)))
      expect(out.outcome).toBe('satisfied')
      expect(isEstablishedSatisfied(out)).toBe(true)
    }
  })

  it('the licence rides INSIDE the proof, so a satisfied outcome names who vouched', () => {
    const out = outcomeOf(fold(TOOL_DENIED, [CLEAN_CALL()], licensedFacts('tool_denied')))
    expect(out).toMatchObject({
      outcome: 'satisfied',
      establishedBy: {
        instrumentation: { claims: 'complete', claimedByAgentVersionId: 'ver_1' },
      },
    })
    // An all-clear that cannot be traced to a falsifiable, attributable claim is
    // the attestation this whole design exists to refuse.
    const proof = (out as { establishedBy: { instrumentation: { mechanism: string } } }).establishedBy
    expect(proof.instrumentation.mechanism.length).toBeGreaterThan(20)
  })
})

describe('§N2 a claim scoped to one operation class does not license the other', () => {
  /**
   * The sharpest remaining shape: the type requires A claim; only
   * `instrumentationCovers` establishes it is the RIGHT one. A tool-call
   * declaration licensing an egress all-clear would be an attestation about
   * network egress resting on a promise about tool calls.
   */
  it('a tool-only claim does NOT license an egress all-clear (and vice versa)', () => {
    const cross: Array<[PolicyRuleKind, PolicyRuleKind]> = [
      ['tool_denied', 'egress_denied'],
      ['egress_denied', 'tool_denied'],
    ]
    for (const [claimed, ruled] of cross) {
      const band = bandOf(fold(policy(ruleFor(ruled)), [CLEAN_CALL()], licensedFacts(claimed)))
      expect(band).toBe('instrumentation_undeclared')
    }
  })

  it('a claim covering BOTH licenses both — teeth for the cross-check above', () => {
    for (const kind of POLICY_RULE_KINDS) {
      const band = bandOf(fold(policy(ruleFor(kind)), [CLEAN_CALL()], licensedFacts(...POLICY_RULE_KINDS)))
      expect(band).toBe('satisfied')
    }
  })

  it('`instrumentationCovers` is total over the shipped kinds and fails closed', () => {
    // Graded against the contract predicate's OUTPUT, over the full cross
    // product, so a third rule kind added without a claim class shows up here.
    for (const claimed of POLICY_RULE_KINDS) {
      for (const ruled of POLICY_RULE_KINDS) {
        expect(instrumentationCovers(completeClaim(claimed), ruleFor(ruled))).toBe(claimed === ruled)
      }
    }
    for (const junk of [null, undefined, {}, { claims: 'undeclared' }, 'complete', 42]) {
      expect(instrumentationCovers(junk as InstrumentationClaim, TOOL_RULE)).toBe(false)
    }
  })
})

describe('§N3 the predicate I was previously NOT exercising: a disabled policy', () => {
  /**
   * `observeRunAgainstPolicy` takes a POLICY DEFINITION where it used to take a
   * bare rule. My earlier checks passed a rule and were therefore testing
   * MATCHING, never the policy.
   *
   * THE GUARANTEE MOVED, WHICH IS WHY THIS BLOCK MATTERS MORE THAN IT LOOKS. It
   * used to come free from `actIsForbiddenBy(policy, …)`, which honours
   * `enabled` internally. The D6 fix replaced that with a RULE-ONLY primitive,
   * and a rule has no enabled flag — so the property silently depended on callers
   * filtering first, which is the same split as D6 one level up. Contracts has
   * since moved the primitive to `matchRecordedEventAgainstPolicy`, and the
   * engine guards it explicitly as well, so the two are belt and braces.
   *
   * THE ASYMMETRY IS WHY THIS WAS WORTH A REBASE RATHER THAN A CALLER-SIDE
   * FILTER: a false all-clear is MISSED, but a false violation is ACTED ON —
   * somebody rolls back or blocks a deploy on a rule that was switched off.
   *
   * The safe direction here is NOT obvious, so it is worth stating which one
   * this asserts: a disabled policy must not manufacture a VIOLATION, and it
   * must equally not manufacture an ALL-CLEAR — a rule nobody is enforcing has
   * not cleared anything.
   */
  it('a DISABLED policy produces no violation on a run that plainly breaches it', () => {
    const disabled = policy(TOOL_RULE, { enabled: false })
    const obs = observeRunAgainstPolicy(disabled, [VIOLATING_CALL()], perfectFacts())
    expect(obs.proofs).toEqual([])
    expect(obs.operationsMatched).toBe(0)
  })

  it('TEETH — the identical policy ENABLED does produce the violation', () => {
    const obs = observeRunAgainstPolicy(policy(TOOL_RULE), [VIOLATING_CALL()], perfectFacts())
    expect(obs.proofs.length).toBe(1)
    expect(obs.operationsMatched).toBe(1)
  })

  it('and a disabled policy is never reported as an all-clear either', () => {
    // The asymmetry that matters: silence from a rule nobody is enforcing is
    // not evidence. With no licence it withholds; the engine must not have a
    // path where disabling a policy is how you get a green tick.
    // It used to land on `instrumentation_undeclared` — true, but only because
    // it fell through to the LAST gate. The engine now names the actual reason,
    // which is the difference between an operator re-reading the log and an
    // operator switching the rule back on.
    const disabled = policy(TOOL_RULE, { enabled: false })
    const out = outcomeOf(fold(disabled, [VIOLATING_CALL()], perfectFacts()))
    expect(out.outcome).toBe('not_evaluable')
    if (out.outcome !== 'not_evaluable') return
    // ITS OWN KIND now that the contract ships one. It briefly landed on
    // `policy_unreadable` — the nearest neighbour while the vocabulary had
    // nothing better — and "switched off" and "malformed" send an operator to two
    // different places.
    expect(out.kind).toBe('policy_disabled')
    // THE CONTRACT'S OWN SENTENCE, not one the backend composed — the same
    // single-subject repair as D6 and rule-versus-policy, applied to the prose.
    expect(out.notEvaluableBecause).toContain('disabled')
    expect(out.notEvaluableBecause).toContain('neither be violated nor')
  })
})

describe('§N4 subject scoping is decided positively — nothing defaults to governed', () => {
  it('an environment rule does NOT govern a run whose environment is unset', () => {
    // `runs.environment` is optional (ADR-002) and absent on every run recorded
    // before it existed, so "unset matches everything" would apply an
    // environment rule to the entire historical corpus.
    const subject = { appliesTo: 'environment', environment: 'production' } as const
    expect(policyGovernsRun(subject, { projectId: 'p', agentId: 'a' })).toBe(false)
    expect(policyGovernsRun(subject, { projectId: 'p', agentId: 'a', environment: 'staging' })).toBe(false)
    // Teeth: it governs the run that says so.
    expect(policyGovernsRun(subject, { projectId: 'p', agentId: 'a', environment: 'production' })).toBe(true)
  })

  it('project and agent scoping never match a foreign id', () => {
    expect(policyGovernsRun({ appliesTo: 'project', projectId: 'p1' }, { projectId: 'p2', agentId: 'a' })).toBe(false)
    expect(policyGovernsRun({ appliesTo: 'agent', agentId: 'a1' }, { projectId: 'p', agentId: 'a2' })).toBe(false)
    expect(policyGovernsRun({ appliesTo: 'org' }, { projectId: 'p', agentId: 'a' })).toBe(true)
  })
})

// ===========================================================================
// §R — RETIRED DEFECTS, AS POSITIVE REGRESSIONS
// ===========================================================================

describe('§R0 RETIRED — the clean path used to throw', () => {
  /**
   * FOUND AND FIXED WITHIN THIS SESSION. Three paths raised an unconditional
   * `Error`: `satisfied`, `log_not_read_to_end`, and EVERY call to
   * `buildPolicyScanReport`.
   *
   * ROOT CAUSE, kept because the reasoning that produced it was RIGHT. PART B
   * imports `assertNoExecutionClaim` from `budget.ts` rather than
   * reimplementing it — correct, and this repo has paid three times for the
   * alternative. But that vocabulary was written for BUDGET prose, where
   * "terminated" and "stopped" can only describe an agent being killed. In
   * POLICY prose they described a RUN's lifecycle (Event Log Rule 5's own
   * concept) and this engine's OWN read hitting its OWN ceiling. The guard fired
   * on the right words in the wrong sense. A shared claim guard reused across
   * domains needs its vocabulary re-validated against the new domain's prose.
   *
   * WHY THE DIRECTION MATTERED: the engine worked when there WAS a violation and
   * crashed when there was not, so any suite written around "does it catch the
   * breach?" passed.
   */
  const BRANCHES: Array<[string, PolicyObservableEvent[], Partial<PolicyRunReadFacts>]> = [
    ['violated', [VIOLATING_CALL()], {}],
    ['policy_unreadable', [CLEAN_CALL()], {}],
    ['run_unreadable', [CLEAN_CALL()], { runObserved: false }],
    ['log_not_read_to_end', [CLEAN_CALL()], { logReadComplete: false }],
    ['run_in_flight', [CLEAN_CALL()], { runIsTerminal: false }],
    ['scan_contaminated', [CLEAN_CALL()], { crossOrgRowsSkipped: 1 }],
    ['evidence_externalized', [EXTERNALIZED_CALL()], {}],
    // An unmapped span may have been ANY operation, so it is undecidable for
    // every rule kind — the contract gives that its own band rather than letting
    // it fall through to the "we did not identify it" one.
    ['deciding_field_unreadable', [UNMAPPED_SPAN()], {}],
    // A rule nobody is enforcing: neither violated nor cleared. Added to
    // BRANCHES rather than bolted on beside the sweep, so R0d's prose guard
    // covers its sentences as well.
    ['policy_disabled', [VIOLATING_CALL()], {}],
    ['instrumentation_undeclared', [CLEAN_CALL()], {}],
    ['satisfied', [CLEAN_CALL()], { instrumentation: completeClaim('tool_denied') }],
  ]

  /** The definition each branch needs — only `policy_unreadable` wants a broken rule. */
  function defFor(branch: string): PolicyDefinition {
    if (branch === 'policy_unreadable') return policy({ kind: 'tool_denied', deniedTools: [] })
    if (branch === 'policy_disabled') return policy(TOOL_RULE, { enabled: false })
    return TOOL_DENIED
  }

  it('R0a — EVERY branch returns; none throws', () => {
    const throwing = BRANCHES.filter(([n, e, f]) => !fold(defFor(n), e, perfectFacts(f)).returned).map(([n]) => n)
    // TEETH: the sweep is total over every band the fold can emit, checked
    // against the CONTRACT's vocabulary rather than a number somebody typed —
    // a hard-coded count silently stops covering a band the day one is added,
    // which is exactly what happened when `deciding_field_unreadable` and
    // `policy_disabled` landed.
    const covered = new Set(BRANCHES.map(([n]) => n))
    for (const kind of POLICY_NOT_EVALUABLE_KINDS) {
      if (kind === 'coverage_unestablished') continue // the fallthrough — see R0f
      if (kind === 'run_not_opened' || kind === 'no_runs_in_scope') continue // constructed directly
      expect(covered, kind).toContain(kind)
    }
    expect(covered.has('violated') && covered.has('satisfied')).toBe(true)
    expect(throwing).toEqual([])
  })

  it('R0b — and each branch reaches the band it is named for (teeth for R0a)', () => {
    const reached = BRANCHES.map(([n, e, f]) => bandOf(fold(defFor(n), e, perfectFacts(f))))
    expect(reached).toEqual(BRANCHES.map(([n]) => n))
  })

  it('R0c — `buildPolicyScanReport` builds, including on zero outcomes', () => {
    const report = buildPolicyScanReport({ outcomes: [], scan: EMPTY_SCAN, evaluatedAt: AT })
    expect(report.counts).toMatchObject({ violated: 0, satisfied: 0, notEvaluable: 0 })
    expect(typeof report.coverageStatement).toBe('string')
  })

  /**
   * THE STANDING PROOF, and the one that generalises: every sentence the module
   * can emit, from every branch, swept through both claim guards. This is what
   * would have caught D0 without anyone predicting which word was wrong.
   */
  it('R0d — every emitted sentence survives BOTH guards', () => {
    const sentences: string[] = []
    const undecidedSentences: string[] = []

    const harvest = (o: PolicyOutcome): void => {
      for (const v of Object.values(o)) if (typeof v === 'string' && v.includes(' ')) sentences.push(v)
      if (o.outcome === 'not_evaluable') undecidedSentences.push(o.notEvaluableBecause, o.wouldBeEvaluableBy)
    }
    for (const [n, e, f] of BRANCHES) harvest(outcomeOf(fold(defFor(n), e, perfectFacts(f))))
    for (const r of ['event_budget_exhausted', 'run_budget_exhausted'] as const) {
      harvest(unopenedRunOutcome(TOOL_DENIED, 'run_x', r))
    }
    harvest(noRunsInScopeOutcome(TOOL_DENIED))
    sentences.push(buildPolicyScanReport({ outcomes: [], scan: EMPTY_SCAN, evaluatedAt: AT }).coverageStatement)

    expect(sentences.length).toBeGreaterThan(10) // teeth: prose was actually collected
    expect(undecidedSentences.length).toBeGreaterThan(10)
    for (const t of sentences) expect(executionClaimIn(t)).toBeNull()
    // Compliance vocabulary is banned on UNDECIDED prose only; a genuinely
    // satisfied outcome is entitled to say so — it carries a licence.
    for (const t of undecidedSentences) expect(producerComplianceClaimIn(t)).toBeNull()

    // Teeth: both guards can fire.
    expect(executionClaimIn('the agent was stopped')).toBe('stopped')
    expect(producerComplianceClaimIn('this run is compliant')).toBe('compliant')
  })

  it('R0e — the margin is still one letter wide, and that is worth knowing', () => {
    // `run_in_flight` says "no terminal event". The regex matches
    // terminated/terminates/terminating, not "terminal". That branch survives by
    // spelling, and a rephrase to "has not terminated" reintroduces D0.
    expect(executionClaimIn('this run has recorded no terminal event')).toBeNull()
    expect(executionClaimIn('this run has not terminated')).toBe('terminated')
  })

  it('R0f — every not-evaluable kind the contract ships is a real, distinct band', () => {
    // Enumerated from the CONTRACT constant, so a kind added without a fold
    // branch is visible as an unreachable band rather than assumed present.
    const reachedHere = new Set(
      BRANCHES.map(([n, e, f]) => bandOf(fold(defFor(n), e, perfectFacts(f)))).filter((b) =>
        (POLICY_NOT_EVALUABLE_KINDS as readonly string[]).includes(b),
      ),
    )
    reachedHere.add(unopenedRunOutcome(TOOL_DENIED, 'r', 'run_budget_exhausted').kind)
    reachedHere.add(noRunsInScopeOutcome(TOOL_DENIED).kind)
    const unreached = POLICY_NOT_EVALUABLE_KINDS.filter((k) => !reachedHere.has(k))
    // `coverage_unestablished` is the documented fallthrough and is not reachable
    // by mutating a single input — it exists for a field a future contributor
    // adds without thinking about the fold. Everything else must be live.
    expect(unreached).toEqual(['coverage_unestablished'])
  })
})

describe('§R5 RETIRED — `tool_denied` had no instrumentation gate', () => {
  /**
   * The declaration requirement was written for `egress_denied` and omitted for
   * `tool_denied`, although the argument for it is identical: `Events.toolCall`
   * is a MANUAL BUILDER and there is no interception anywhere in
   * `packages/sdk/src`. An agent that calls the forbidden tool without recording
   * it produces a run with zero `tool.call` events, byte-identical to a run that
   * called no tools.
   *
   * The fix is better than the one I asked for: the precondition is now a
   * property of `PolicyCoverageProof`'s TYPE rather than a branch, and it
   * applies to both kinds. §N1/§N2 attack the type; this is the regression on
   * the exact fixture that used to defeat it.
   */
  it('R5 — the emptiest possible evidence is no longer an all-clear, for EITHER kind', () => {
    // A terminated run recording only `run.started`: nothing here distinguishes
    // "did nothing" from "did it without recording it".
    for (const kind of POLICY_RULE_KINDS) {
      const emptyRun = [ev('run.started', { type: 'run.started', input: {}, config: {} })]
      expect(bandOf(fold(policy(ruleFor(kind)), emptyRun, perfectFacts()))).toBe('instrumentation_undeclared')
    }
  })

  it('R5 — and with a covering claim the same emptiness IS an all-clear, symmetrically', () => {
    // Teeth, and the point of the fix: a declaration makes absence meaningful.
    // The two kinds must behave the SAME way, which is what D5 was about.
    const bands = POLICY_RULE_KINDS.map((kind) =>
      bandOf(
        fold(
          policy(ruleFor(kind)),
          [ev('run.started', { type: 'run.started', input: {}, config: {} })],
          licensedFacts(kind),
        ),
      ),
    )
    expect(bands).toEqual(POLICY_RULE_KINDS.map(() => 'satisfied'))
  })
})

describe('§R1 RETIRED — `otel.span.unmapped` was invisible to the engine', () => {
  /**
   * ADR-007 records a span matching no mapping rule as an `otel.span.unmapped`
   * EVENT, kept "precisely because it mapped to nothing". It was previously
   * counted as neither relevant NOR unreadable — invisible — so coverage was
   * declared COMPLETE over a run whose every act was a span the mapper could not
   * read, even when the span payload named the denied tool.
   *
   * It is now undecidable for EVERY rule kind, not merely for the kind whose
   * deciding event type it is not — which is the stronger reading: an unmapped
   * span may have been ANY operation.
   */
  it('R1a — an unmapped span is undecidable, and blocks coverage', () => {
    const spans = [UNMAPPED_SPAN(), UNMAPPED_SPAN()]
    const obs = observeRunAgainstPolicy(TOOL_DENIED, spans, perfectFacts())
    expect(obs.undecidableCount).toBe(2)
    // The engine now carries the CONTRACT's own kind alongside its prose, rather
    // than a locally-invented availability enum — one classification of one
    // condition, which is the same lesson as D6.
    expect(obs.undecidableKinds).toContain('deciding_field_unreadable')
    expect(obs.undecidableReasons.join(' ')).toContain('unmapped OpenTelemetry span')
    expect(isPolicyCoverageComplete(obs)).toBe(false)
    // Teeth: the fixture really does name the forbidden tool in its payload.
    expect(JSON.stringify(spans)).toContain(FORBIDDEN_TOOL)
  })

  it('R1b — it blocks the all-clear EVEN WITH a complete instrumentation claim', () => {
    // The sharpest form: a declaration says recording is complete, and this run
    // still cannot be cleared, because what was recorded is unreadable. A
    // declaration must not be able to buy past unreadable evidence.
    for (const kind of POLICY_RULE_KINDS) {
      const band = bandOf(fold(policy(ruleFor(kind)), [UNMAPPED_SPAN()], licensedFacts(kind)))
      expect(band).not.toBe('satisfied')
    }
  })

  it('R1c — undecidable for EVERY kind, not only the one whose type it is not', () => {
    for (const kind of POLICY_RULE_KINDS) {
      const obs = observeRunAgainstPolicy(policy(ruleFor(kind)), [UNMAPPED_SPAN()], perfectFacts())
      expect(obs.undecidableCount).toBe(1)
    }
  })

  it('R1d — TEETH: an ordinary irrelevant event is still correctly ignored', () => {
    // Without this, R1a/R1c would pass against an engine that called EVERY event
    // undecidable, which would be a different defect wearing the same green.
    const obs = observeRunAgainstPolicy(
      TOOL_DENIED,
      [ev('llm.request', { type: 'llm.request', model: 'm', messages: [] })],
      perfectFacts(),
    )
    expect(obs.undecidableCount).toBe(0)
    expect(obs.relevantEventsSeen).toBe(0)
    expect(isPolicyCoverageComplete(obs)).toBe(true)
  })
})

describe('§R2 RETIRED — an empty target list silently widened the rule', () => {
  /**
   * `deniedTools: undefined` denies EVERY tool call; `deniedTools: []` denied
   * NOTHING, forever, and nothing validated the difference. Two adjacent
   * representations with opposite meanings, one serialization step apart, and
   * the `[]` side reported an all-clear indistinguishable from a rule that
   * genuinely checked.
   *
   * `isInterpretableRule` now rejects it as a MISCONFIGURATION rather than a
   * widened rule, and — the part that matters most — it is checked at
   * EVALUATION time, not only at write time. A row written before the guard
   * existed, or restored from a backup, is still caught.
   *
   * (My earlier name for this defect used "vacuous" in a certifying position,
   * which `causal_adversarial_substrate.test.ts` correctly flags — my own
   * polarity discriminator from iteration 8 firing on me. The names below
   * describe the ENGINE'S handling rather than pronouncing on the rule.)
   */
  it('R2a — an empty target list is uninterpretable, for every rule kind', () => {
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
    expect(isInterpretableRule({ kind: 'egress_denied', deniedHosts: [] })).toBe(false)
    // Teeth, and the boundary that must NOT be collapsed with it: an ABSENT
    // list is the deny-the-operation form and is perfectly interpretable.
    expect(isInterpretableRule({ kind: 'tool_denied' })).toBe(true)
    expect(isInterpretableRule(TOOL_RULE)).toBe(true)
  })

  it('R2b — an unknown kind is uninterpretable; a blank ENTRY is a narrower, still-open gap', () => {
    expect(isInterpretableRule({ kind: 'nonsense' } as unknown as PolicyRule)).toBe(false)
    // NOT A DEFECT IN THE BACKEND, and deliberately not patched there. The
    // contract's predicate gates on the list being NON-EMPTY, not on each entry
    // being non-blank, so `['  ']` is a live rule that matches no tool — weaker
    // than `[]` (which forbids nothing and IS rejected) but still a control that
    // grades nothing. A second, stricter predicate in `convex/` would be the
    // reader/matcher split of D6 in a new costume: two places deciding what a
    // valid rule is. The WRITE PATH refuses it, so it cannot arrive through the
    // product; closing it for rows that arrive otherwise is contracts' to do.
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: ['  '] })).toBe(true)
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
  })

  it('R2c — an empty-list rule now reports `policy_unreadable`, never an all-clear', () => {
    // The exact adversarial fixture that used to defeat it: a run that called
    // the tool an operator meant to ban, graded against the `[]` spelling. It
    // used to come back `satisfied`. Now it names the misconfiguration.
    for (const empty of [
      { kind: 'tool_denied', deniedTools: [] } as PolicyRule,
      { kind: 'egress_denied', deniedHosts: [] } as PolicyRule,
    ]) {
      const band = bandOf(fold(policy(empty), [VIOLATING_CALL()], licensedFacts(...POLICY_RULE_KINDS)))
      expect(band).toBe('policy_unreadable')
    }
  })

  it('R2d — the two spellings are no longer one step apart in MEANING', () => {
    // `undefined` still denies the operation itself; `[]` is now a refusal to
    // grade rather than the opposite verdict. The dangerous adjacency is gone.
    const events = [CLEAN_CALL()]
    expect(bandOf(fold(policy({ kind: 'tool_denied' }), events, perfectFacts()))).toBe('violated')
    expect(bandOf(fold(policy({ kind: 'tool_denied', deniedTools: [] }), events, perfectFacts()))).toBe(
      'policy_unreadable',
    )
  })

  it('R2e — `ruleIsDecidableFromEventTypeAlone` draws the boundary in one place', () => {
    // The empty-set route is what makes an externalized payload still decisive,
    // so its boundary is load-bearing: it must be true ONLY for the absent-list
    // form, never for a partial list and never for `[]`.
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied' })).toBe(true)
    expect(ruleIsDecidableFromEventTypeAlone(TOOL_RULE)).toBe(false)
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
  })
})

describe('§R3 RETIRED — OTel `lossy` provenance was swallowed', () => {
  /**
   * `PolicyObservableEvent` had five fields and none was `provenance`, so the
   * I/O layer had nowhere to put it: a `tool.call` the OTel mapper flagged
   * `lossy` graded byte-identically to a first-party one, including into a
   * coverage proof asserting every payload was legible. The sibling engine
   * answering the same question over the same rows (`extractRunObservation` in
   * `helpers/divergence.ts`) correctly raised `LOSSY_DERIVED_EVENT`.
   */
  const lossyCall = () =>
    ev('tool.call', { type: 'tool.call', name: 'docs:search' }, { provenance: { source: 'otel', lossy: true } })

  it('R3a — a lossy derived event is undecidable and blocks coverage', () => {
    const obs = observeRunAgainstPolicy(TOOL_DENIED, [lossyCall()], perfectFacts())
    expect(obs.undecidableCount).toBe(1)
    expect(isPolicyCoverageComplete(obs)).toBe(false)
  })

  it('R3b — TEETH: the identical event WITHOUT the lossy flag is decidable', () => {
    const obs = observeRunAgainstPolicy(TOOL_DENIED, [CLEAN_CALL()], perfectFacts())
    expect(obs.undecidableCount).toBe(0)
    expect(isPolicyCoverageComplete(obs)).toBe(true)
  })

  it('R3c — `orderingCaveat` propagates from ANY OTel-derived event, lossy or not', () => {
    // ADR-007: on an OTel run a cited `sequenceNumber` is ARRIVAL order, not
    // occurrence order. Forwarded, not swallowed — including for a NON-lossy
    // derived event, which is the case a narrower fix would have missed.
    const derived = ev('tool.call', { type: 'tool.call', name: 'docs:search' }, { provenance: { source: 'otel' } })
    expect(observeRunAgainstPolicy(TOOL_DENIED, [derived], perfectFacts()).orderingCaveat).toBe(true)
    expect(observeRunAgainstPolicy(TOOL_DENIED, [CLEAN_CALL()], perfectFacts()).orderingCaveat).toBe(false)
  })

  it('R3d — a lossy event blocks the all-clear even WITH a complete claim', () => {
    expect(bandOf(fold(TOOL_DENIED, [lossyCall()], licensedFacts('tool_denied')))).not.toBe('satisfied')
  })
})

// ===========================================================================
// §S — WHAT SURVIVED EVERY ITERATION
// ===========================================================================

describe('§S1 the three states cannot be flattened', () => {
  const states = (): PolicyOutcome[] => [
    outcomeOf(fold(TOOL_DENIED, [VIOLATING_CALL()], perfectFacts())),
    outcomeOf(fold(TOOL_DENIED, [CLEAN_CALL()], licensedFacts('tool_denied'))),
    outcomeOf(fold(TOOL_DENIED, [EXTERNALIZED_CALL()], perfectFacts())),
  ]

  it('no property name is shared by any two of the three except the discriminant', () => {
    const s = states()
    expect(s.map((o) => o.outcome)).toEqual(['violated', 'satisfied', 'not_evaluable']) // teeth
    const keys = s.map((o) => new Set(Object.keys(o)))
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as Array<[number, number]>) {
      const shared = [...(keys[a] as Set<string>)].filter((k) => (keys[b] as Set<string>).has(k))
      expect(shared).toEqual(['outcome'])
    }
  })

  it('no state carries a boolean a caller could read as a pass/fail', () => {
    for (const o of states()) {
      const names = Object.entries(o)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k]) => k)
      expect(names.filter((n) => /^(allowed|ok|pass|passed|compliant|clean|safe|enforced)$/i.test(n))).toEqual([])
    }
  })

  it('`isEstablishedSatisfied` is the ONLY all-clear predicate and fails closed', () => {
    const s = states()
    expect(s.map((o) => isEstablishedSatisfied(o))).toEqual([false, true, false])
    for (const junk of [null, undefined, {}, { outcome: 'compliant' }, 'satisfied']) {
      expect(isEstablishedSatisfied(junk as PolicyOutcome)).toBe(false)
    }
  })
})

describe('§S2 a proven violation outranks every coverage failure', () => {
  it('a breach seen inside a TRUNCATED, IN-FLIGHT, CONTAMINATED, UNDECLARED scan is still `violated`', () => {
    const worst = perfectFacts({ logReadComplete: false, runIsTerminal: false, crossOrgRowsSkipped: 4 })
    const out = outcomeOf(fold(TOOL_DENIED, [VIOLATING_CALL()], worst))
    expect(out.outcome).toBe('violated')
    expect(out).toMatchObject({ violationCountIsFloor: true })
  })

  it('TEETH — the same worst-case facts with NO breach do NOT produce `violated`', () => {
    const worst = perfectFacts({ logReadComplete: false, runIsTerminal: false, crossOrgRowsSkipped: 4 })
    expect(bandOf(fold(TOOL_DENIED, [CLEAN_CALL()], worst))).not.toBe('violated')
  })
})

describe('§S3 every violation cites the events that prove it', () => {
  it('each proof resolves to a stored row and declares HOW it was decided', () => {
    const out = violatedOf(fold(TOOL_DENIED, [VIOLATING_CALL(), VIOLATING_CALL()], perfectFacts()))
    expect(out.provenBy.length).toBe(2)
    for (const p of out.provenBy) {
      expect(Object.keys(p.citedEvent).sort()).toEqual([
        'eventId',
        'eventType',
        'recordedAt',
        'runId',
        'sequenceNumber',
      ])
      expect(p.observedValue).toBe(FORBIDDEN_TOOL)
      expect(p.decidedBy).toBe('inline_payload')
    }
  })

  it('a run with zero relevant events NEVER produces `violated`, over every rule kind', () => {
    for (const kind of POLICY_RULE_KINDS) {
      const r = fold(policy(ruleFor(kind)), [ev('llm.request', { type: 'llm.request', model: 'm', messages: [] })])
      expect(bandOf(r)).not.toBe('violated')
    }
  })
})

describe('§S4 the empty-set rule is correctly BOUNDED', () => {
  it('deny-the-OPERATION decides an externalized payload — the type alone suffices', () => {
    const out = violatedOf(fold(policy({ kind: 'tool_denied' }), [EXTERNALIZED_CALL()], perfectFacts()))
    const p = out.provenBy[0]
    // `null` rather than a placeholder string, so no reader mistakes a sentinel
    // for a tool name — and `decidedBy` says which route was taken.
    expect(p?.observedValue).toBeNull()
    expect(p?.decidedBy).toBe('event_type_alone')
  })

  it('deny-a-NAMED-tool declines the same payload — the boundary holds', () => {
    expect(bandOf(fold(TOOL_DENIED, [EXTERNALIZED_CALL()], perfectFacts()))).toBe('evidence_externalized')
  })

  it('the type-alone route does NOT survive a lossy derived event', () => {
    // An unreliable TYPE defeats the one route that survives an unreadable
    // PAYLOAD. Easy to miss, and it is handled.
    const lossy = ev('tool.call', { type: '_externalized' }, { provenance: { source: 'otel', lossy: true } })
    expect(bandOf(fold(policy({ kind: 'tool_denied' }), [lossy], perfectFacts()))).not.toBe('violated')
  })
})

describe('§S5 RETIRED — the field readers are gone, and their absence is the fix', () => {
  /**
   * THE READERS THIS BLOCK USED TO EXERCISE NO LONGER EXIST. `readToolName`,
   * `readEgressHost`, `readDecidingField`, `ruleForbidsValue` and
   * `relevantEventTypes` were deleted from `convex/helpers/policy.ts` when D6 was
   * fixed, because the reader/matcher PAIR was the defect — not either half of
   * it. Contracts' `matchRecordedEventAgainstRule` takes the whole event and the
   * rule and returns all four bands, so the backend cannot perform half of the
   * operation and cannot disagree with itself about what a host is.
   *
   * The checks are kept, rewritten to grade BEHAVIOUR rather than the deleted
   * functions: hostile payloads must still withhold rather than guess, and an
   * externalized envelope must still be refused. A block deleted along with the
   * code it tested would take its adversarial pressure with it.
   */
  const HOSTILE: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    [{ name: FORBIDDEN_TOOL }],
    { name: 42 },
    { name: '   ' },
    { function: null },
    { function: { name: '' } },
    Object.create(null) as unknown,
  ]

  it('a hostile tool.call payload never throws and never clears', () => {
    for (const payload of HOSTILE) {
      const obs = observeRunAgainstPolicy(TOOL_DENIED, [ev('tool.call', payload)], perfectFacts())
      // Either it was undecidable, or it was read and did not match — never an
      // exception, and never a proof invented from a payload nobody could read.
      expect(obs.proofs).toEqual([])
      expect(obs.undecidableCount + obs.relevantEventsSeen).toBeGreaterThan(0)
    }
    // TEETH: a well-formed payload naming the tool still produces the proof.
    const good = observeRunAgainstPolicy(TOOL_DENIED, [VIOLATING_CALL()], perfectFacts())
    expect(good.proofs.length).toBe(1)
  })

  it('an `_externalized` envelope that ALSO carries a name is still refused', () => {
    // A client could spoof `type: "_externalized"` alongside a real name.
    // Refusing is correct: the envelope means the payload is not here.
    const obs = observeRunAgainstPolicy(
      TOOL_DENIED,
      [ev('tool.call', { type: '_externalized', name: FORBIDDEN_TOOL })],
      perfectFacts(),
    )
    expect(obs.proofs).toEqual([])
    expect(obs.undecidableCount).toBe(1)
    expect(obs.undecidableKinds).toContain('evidence_externalized')
  })

  it('THE BACKEND EXPORTS NO HALF OF THE OPERATION — a reader without its matcher', () => {
    // The structural form of the D6 fix. A reader that can be called on its own
    // is a reader that can disagree with the matcher, which is what happened.
    for (const gone of [
      'readToolName',
      'readEgressHost',
      'readDecidingField',
      'ruleForbidsValue',
      'relevantEventTypes',
      'nonMatchIsUndecidable',
      'valueMatchesRule',
    ]) {
      expect(Object.keys(engine), gone).not.toContain(gone)
    }
  })
})

// ===========================================================================
// §D6 RETIRED — EGRESS HOST EXTRACTION WAS SPLIT ACROSS TWO VOCABULARIES
// ===========================================================================

describe('§D6 RETIRED — a recorded egress to a denied host could be reported as an all-clear', () => {
  /**
   * THE DEFECT, AND WHY IT IS WORTH KEEPING THE STORY. `readEgressHost` accepted
   * `host`/`hostname` as well as `url`; the contract's matcher parsed full URLs
   * only. So:
   *
   *   readEgressHost({ url })   -> raw URL       -> matcher: WORKS
   *   readEgressHost({ host })  -> bare hostname -> matcher: FAILS
   *
   * A payload carrying `host: "evil.example.com"` was examined, counted FULLY
   * LEGIBLE, matched against nothing, and — with a complete instrumentation
   * claim — cleared. The worst outcome this feature has: not a crash and not a
   * hedge, but a MISSED VIOLATION RENDERED AS `satisfied`, on evidence that was
   * recorded, legible and inline. Every safeguard above it worked correctly.
   *
   * THE MODULE'S OWN COMMENT HAD PREDICTED IT WITH THE POLARITY REVERSED, after
   * fixing the mirror-image version: "the boundary logic was single-sourced and
   * the EXTRACTION was not, which was enough."
   *
   * FIXED BY DELETION IN BOTH BOUNDARIES. The reader is gone; extraction and
   * matching happen in one contracts primitive. THE INTERIM REPAIR IS ALSO
   * RECORDED, because it was wrong in an instructive way: deleting only the
   * `host` branch traded a false all-clear for a MISSED violation — the safe
   * direction, and still not the answer, since the breach is the row that
   * matters most.
   *
   * These now assert the FIXED behaviour. The `toBe`s are deliberate: a
   * regression turns the block red rather than degrading it quietly.
   */
  const deniedHostEvent = (payload: Record<string, unknown>) =>
    ev('http.request', { type: 'http.request', ...payload })

  const bandFor = (payload: Record<string, unknown>) =>
    bandOf(fold(policy(EGRESS_RULE), [deniedHostEvent(payload)], licensedFacts('egress_denied')))

  it('EVERY host shape that names the denied host is now a violation', () => {
    // Each of these cleared before the fix. The bare-host, port and subdomain
    // spellings are the three the split vocabulary let through.
    for (const payload of [
      { url: 'https://evil.example.com/x' },
      { host: 'evil.example.com' },
      { hostname: 'evil.example.com' },
      { host: 'evil.example.com:443' },
      { host: 'api.evil.example.com' },
      { url: 'https://api.evil.example.com:8443/deep/path?q=1' },
    ]) {
      expect(bandFor(payload), JSON.stringify(payload)).toBe('violated')
    }
  })

  it('the observation counts the event as MATCHED, not merely as examined', () => {
    // The precise shape of the old defect: examined, legible, matched nothing.
    const obs = observeRunAgainstPolicy(
      policy(EGRESS_RULE),
      [deniedHostEvent({ host: 'evil.example.com' })],
      perfectFacts(),
    )
    expect(obs.relevantEventsSeen).toBe(1)
    expect(obs.undecidableCount).toBe(0)
    expect(obs.operationsMatched).toBe(1)
    expect(obs.proofs.length).toBe(1)
  })

  it('TEETH — a permitted host still clears, so the fix did not simply widen matching', () => {
    // Without this, every check above would pass against an engine that reported
    // every egress as a violation, which is a different and equally bad defect.
    expect(bandFor({ url: 'https://good.example/x' })).toBe('satisfied')
    expect(bandFor({ host: 'good.example' })).toBe('satisfied')
    // The label boundary holds: a shared spelling is not a match, because a
    // false accusation is acted on where a false all-clear is merely missed.
    expect(bandFor({ host: 'myevil.example.com' })).toBe('satisfied')
    // Userinfo resolves to the host a request would actually REACH.
    expect(bandFor({ url: 'https://evil.example.com@safe.example/x' })).toBe('satisfied')
    expect(bandFor({ url: 'https://safe.example@evil.example.com/x' })).toBe('violated')
  })

  it('PRESENT AND UNINTERPRETABLE IS NOT PERMITTED — the second half of D6', () => {
    // A malformed payload used to become evidence of compliance. It is now its
    // own not-evaluable kind, so "could not read" cannot be spelled as "does not
    // match" anywhere in the fold.
    for (const payload of [{ url: 'not a url at all' }, { url: '://' }, { host: '   ' }, {}]) {
      expect(bandFor(payload), JSON.stringify(payload)).toBe('deciding_field_unreadable')
    }
  })

  it('the violation cites the NORMALISED host, so the decision is reproducible', () => {
    const out = outcomeOf(
      fold(policy(EGRESS_RULE), [deniedHostEvent({ url: 'https://API.Evil.Example.com:443/x' })], perfectFacts()),
    )
    expect(out.outcome).toBe('violated')
    if (out.outcome !== 'violated') return
    // The value the matcher actually compared — not the raw URL, which a reader
    // would have to re-parse to check the finding.
    expect(out.provenBy[0]?.observedValue).toBe('api.evil.example.com')
  })
})
