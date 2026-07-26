/* eslint-disable */
// PURE-ENGINE tests for convex/helpers/policy.ts.
//
// The properties under test are the ones this feature can only get wrong once
// each, and every one is decided in this file rather than in the I/O layer —
// which is the entire reason the engine is pure:
//
//   1. `not_evaluable` NEVER becomes `satisfied`. Swept combinatorially, not over
//      the handful of cases someone thought to enumerate.
//   2. A `violated` outcome CITES the events that prove it, and survives every
//      form of incompleteness — the asymmetry.
//   3. INSTRUMENTATION is a property of the PROOF, not of a table beside it, so
//      `satisfied` is unreachable for BOTH rule kinds today.
//   4. `otel.span.unmapped` and lossy OTel provenance are undecidable, not
//      irrelevant.
//   5. The three outcomes share no field, so a flattening read does not compile.
//   6. Every sentence the module can emit passes both claim guards.
//
// THE VOCABULARY IS THE CONTRACT'S. This file imports it through the engine's
// re-export, so a test that still compiles is itself evidence that the engine did
// not quietly redefine a name.
import { describe, it, expect } from 'vitest'
import * as policyModule from './policy'
import {
  POLICY_NOT_EVALUABLE_KINDS,
  POLICY_RULE_KINDS,
  RULE_DECIDING_EVIDENCE,
  assertNoComplianceClaim,
  buildPolicyScanReport,
  buildPolicySnapshot,
  countPolicyOutcomes,
  executionClaimIn,
  foldPolicyOutcome,
  hostFallsUnder,
  instrumentationCovers,
  isCoverageProof,
  isEstablishedSatisfied,
  isInterpretableRule,
  isPolicyCoverageComplete,
  noRunsInScopeOutcome,
  observeRunAgainstPolicy,
  policyGovernsRun,
  producerComplianceClaimIn,
  ruleIsDecidableFromEventTypeAlone,
  unopenedRunOutcome,
  type CompleteInstrumentationClaim,
  type PolicyDefinition,
  type PolicyEvaluationScan,
  type PolicyObservableEvent,
  type PolicyOutcome,
  type PolicyRule,
  type PolicyRunObservation,
  type PolicyRunReadFacts,
} from './policy'

const AT = 1_750_000_000_000

const NO_SHELL: PolicyRule = { kind: 'tool_denied', deniedTools: ['shell'] }
const NO_EVIL: PolicyRule = { kind: 'egress_denied', deniedHosts: ['evil.example'] }

const policy = (over: Partial<PolicyDefinition> = {}): PolicyDefinition => ({
  policyId: 'pol1',
  orgId: 'org1',
  name: 'no shell',
  revision: 1,
  rule: NO_SHELL,
  subject: { appliesTo: 'org' },
  rationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents.',
  enabled: true,
  createdAt: AT - 1000,
  ...over,
})

const ev = (
  seq: number,
  type: string,
  payload: unknown,
  provenance?: PolicyObservableEvent['provenance'],
): PolicyObservableEvent => ({
  eventId: `e${seq}`,
  runId: 'run1',
  type,
  sequenceNumber: seq,
  timestamp: AT + seq,
  payload,
  ...(provenance ? { provenance } : {}),
})

/** A PERFECT read: closed run, end of log seen, nothing foreign. */
const perfect = (over: Partial<PolicyRunReadFacts> = {}): PolicyRunReadFacts => ({
  runId: 'run1',
  runObserved: true,
  runIsTerminal: true,
  logReadComplete: true,
  crossOrgRowsSkipped: 0,
  observedAt: AT,
  ...over,
})

/** A claim covering BOTH rule kinds — the only thing that can unlock `satisfied`. */
const declaresBoth: CompleteInstrumentationClaim = {
  claims: 'complete',
  coversOperations: ['tool_denied', 'egress_denied'],
  mechanism: 'All tool dispatch and outbound HTTP go through recordedFetch(); node:http is not imported elsewhere.',
  claimedByAgentVersionId: 'ver_3',
  claimedAt: AT - 5,
}

const fold = (p: PolicyDefinition, events: PolicyObservableEvent[], facts = perfect()) =>
  foldPolicyOutcome({ policy: p, observation: observeRunAgainstPolicy(p, events, facts), evaluatedAt: AT })

const scan = (over: Partial<PolicyEvaluationScan> = {}): PolicyEvaluationScan => ({
  subject: { appliesTo: 'org' },
  policiesInScope: 1,
  policiesEvaluated: 1,
  runsInScope: 1,
  runsRead: 1,
  evaluationTruncated: false,
  retentionHorizon: null,
  orderingCaveat: false,
  ...over,
})

// ===========================================================================
describe('THE VOCABULARY IS IMPORTED, NOT MIRRORED', () => {
  it('the engine does not redefine any contract name under a Local… alias', () => {
    // A previous revision of this file carried `LocalPolicyViolated`,
    // `LocalPolicyFinding` and friends — a second definition of a certainty
    // boundary that can silently disagree. They are gone; these must not return.
    for (const name of Object.keys(policyModule)) {
      expect(name.startsWith('Local')).toBe(false)
    }
  })

  it('re-exports the contract vocabulary rather than a copy of it', () => {
    expect([...POLICY_RULE_KINDS]).toEqual(['tool_denied', 'egress_denied'])
    expect(POLICY_NOT_EVALUABLE_KINDS).toContain('instrumentation_undeclared')
    expect(POLICY_NOT_EVALUABLE_KINDS).toContain('no_runs_in_scope')
    expect(POLICY_NOT_EVALUABLE_KINDS).toContain('policy_unreadable')
    expect(RULE_DECIDING_EVIDENCE.tool_denied).toEqual({ eventType: 'tool.call', payloadField: 'name' })
  })
})

// ===========================================================================
describe('D6 — extraction and matching are ONE primitive, and every host shape is decided', () => {
  // THE DEFECT, AND BOTH OF MY WRONG REPAIRS, PINNED AS BEHAVIOUR.
  //
  // The engine had a reader (`readEgressHost`) feeding a matcher. The reader
  // accepted `host`/`hostname`; the matcher understood only full URLs. A payload
  // carrying `host: "evil.example.com"` was examined, counted FULLY LEGIBLE,
  // matched against nothing, and — with a complete instrumentation claim —
  // returned `satisfied`: a recorded, inline, legible forbidden call reported as
  // compliant.
  //
  // My first repair deleted the `host` branch, which traded a false all-clear for
  // a MISSED VIOLATION. Safe direction, still wrong: the breach is the row that
  // matters most. The real fix is the contract's single primitive, and these
  // cases prove all four shapes now land on `violated`.
  const EGRESS = policy({ rule: { kind: 'egress_denied', deniedHosts: ['evil.example.com'] } })

  const bandFor = (payload: unknown, p = EGRESS) =>
    foldPolicyOutcome({
      policy: p,
      // The strongest possible read PLUS a complete claim — the only
      // configuration in which `satisfied` is reachable at all, so a false
      // all-clear has nowhere to hide.
      observation: observeRunAgainstPolicy(p, [ev(1, 'http.request', payload), ev(2, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    }).outcome

  it('EVERY host shape a payload can carry is decided as a violation', () => {
    for (const payload of [
      { url: 'https://evil.example.com/x' },
      { host: 'evil.example.com' },
      { hostname: 'evil.example.com' },
      { host: 'evil.example.com:443' },
      { host: 'api.evil.example.com' },
      { url: 'https://api.evil.example.com:8443/deep/path?q=1' },
      { endpoint: 'evil.example.com' },
    ]) {
      expect(bandFor(payload), JSON.stringify(payload)).toBe('violated')
    }
  })

  it('a permitted host still clears, so the fix did not simply widen matching', () => {
    expect(bandFor({ url: 'https://good.example/x' })).toBe('satisfied')
    expect(bandFor({ host: 'good.example' })).toBe('satisfied')
    // The label boundary holds: a shared spelling is not a match, because a false
    // accusation is as corrosive as a false all-clear.
    expect(bandFor({ host: 'myevil.example.com' })).toBe('satisfied')
    // ...and userinfo resolves to the host a request would actually REACH.
    expect(bandFor({ url: 'https://evil.example.com@safe.example/x' })).toBe('satisfied')
    expect(bandFor({ url: 'https://safe.example@evil.example.com/x' })).toBe('violated')
  })

  it('PRESENT AND UNINTERPRETABLE IS NOT PERMITTED — the second half of D6', () => {
    // `permitted_by_this_rule` and `undecidable` are different bands of the
    // contract's return type, so this boundary cannot collapse "could not read"
    // into "does not match".
    for (const payload of [{ url: 'not a url at all' }, { url: '://' }, { host: '   ' }, {}]) {
      expect(bandFor(payload), JSON.stringify(payload)).toBe('not_evaluable')
    }
  })

  it('and the undecidable outcome carries the CONTRACT\'s own kind and remedy', () => {
    const o = foldPolicyOutcome({
      policy: EGRESS,
      observation: observeRunAgainstPolicy(EGRESS, [ev(1, 'http.request', { url: 'not a url' })], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('deciding_field_unreadable')
    expect(o.notEvaluableBecause).toContain('could not be interpreted as a host')
    expect(o.wouldBeEvaluableBy).toContain('http.request')
  })

  it('THIS BOUNDARY EXPORTS NO HALF OF THE OPERATION', () => {
    // A reader without its matcher is how D6 happened. None of these may return.
    for (const gone of [
      'readToolName',
      'readEgressHost',
      'readDecidingField',
      'ruleForbidsValue',
      'relevantEventTypes',
      'nonMatchIsUndecidable',
    ]) {
      expect(Object.keys(policyModule), gone).not.toContain(gone)
    }
    // The field-candidate list lives in contracts, not here: a spelling the
    // emitter uses and the evaluator does not is a forbidden call nobody sees.
    const src = (
      import.meta.glob('./policy.ts', { as: 'raw', eager: true }) as Record<string, string>
    )['./policy.ts']
    expect(src).not.toMatch(/"hostname"/)
    expect(src).not.toMatch(/"tool_name"/)
  })

  it('tool names are still identifiers: exact, case-sensitive', () => {
    const p = policy()
    const band = (payload: unknown) =>
      foldPolicyOutcome({
        policy: p,
        observation: observeRunAgainstPolicy(p, [ev(1, 'tool.call', payload), ev(2, 'run.completed', {})], {
          ...perfect(),
          instrumentation: declaresBoth,
        }),
        evaluatedAt: AT,
      }).outcome
    expect(band({ name: 'shell' })).toBe('violated')
    expect(band({ tool: 'shell' })).toBe('violated')
    expect(band({ name: 'SHELL' })).toBe('satisfied')
    expect(band({ name: 'read_file' })).toBe('satisfied')
    expect(band({})).toBe('not_evaluable')
  })

  it('an event of the wrong type is SILENT, not clean', () => {
    // `not_relevant` neither clears nor implicates, and is not counted as a
    // relevant event — an llm.request says nothing about a tool policy.
    const o = observeRunAgainstPolicy(policy(), [ev(1, 'llm.request', { model: 'x' })], perfect())
    expect(o.relevantEventsSeen).toBe(0)
    expect(o.undecidableCount).toBe(0)
    expect(o.proofs).toHaveLength(0)
  })
})

describe('an empty target list is a misconfiguration, not a widened rule', () => {
  it('`[]` is uninterpretable while `undefined` denies everything', () => {
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
    expect(isInterpretableRule({ kind: 'egress_denied', deniedHosts: [] })).toBe(false)
    expect(isInterpretableRule({ kind: 'tool_denied' })).toBe(true)
    expect(isInterpretableRule(NO_SHELL)).toBe(true)
  })

  it('a blank entry is INTERPRETABLE and simply never matches — a narrower gap, and contracts\' call', () => {
    // The contract's predicate gates on the list being non-empty, not on each
    // entry being non-blank. A `['  ']` rule is therefore a live rule that
    // matches no tool — weaker than `[]` (which forbids nothing at all and IS
    // rejected) but still a control that grades nothing.
    //
    // NOT PATCHED LOCALLY. A second, stricter interpretability predicate in this
    // boundary is the reader/matcher split that produced D6, in a new costume:
    // two places deciding what a valid rule is. The write path refuses a blank
    // entry (convex/policies.ts `normaliseTargets`), so it cannot arrive through
    // the product; a row that arrives another way is a gap for contracts to
    // close in its own predicate.
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: ['  '] })).toBe(true)
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
  })

  it('an unknown rule kind is uninterpretable', () => {
    expect(isInterpretableRule({ kind: 'nonsense' } as never)).toBe(false)
    expect(isInterpretableRule(null as never)).toBe(false)
  })

  it('A RULE ARRIVING THROUGH ANY OTHER PATH IS policy_unreadable, NEVER satisfied', () => {
    // The row a backup restore, or a write predating the guard, would produce.
    const p = policy({ rule: { kind: 'tool_denied', deniedTools: [] } })
    const o = fold(p, [ev(1, 'tool.call', { name: 'shell' }), ev(2, 'run.completed', {})])
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('policy_unreadable')
    // ...and it does NOT report the run that called the banned tool as clear.
    expect(o).not.toHaveProperty('satisfiedPolicyId')
  })

  it('even WITH a complete instrumentation claim, a `[]` rule is still policy_unreadable', () => {
    const p = policy({ rule: { kind: 'tool_denied', deniedTools: [] } })
    const o = foldPolicyOutcome({
      policy: p,
      observation: observeRunAgainstPolicy(p, [ev(1, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('policy_unreadable')
  })
})

// ===========================================================================
describe('violated — evidence is proof, and it cites the events', () => {
  it('cites the exact event, records HOW it was decided, and carries the rationale', () => {
    const o = fold(policy(), [
      ev(1, 'run.started', {}),
      ev(2, 'tool.call', { name: 'shell' }),
      ev(3, 'run.completed', {}),
    ])
    expect(o.outcome).toBe('violated')
    if (o.outcome !== 'violated') throw new Error('unreachable')
    expect(o.provenBy).toHaveLength(1)
    expect(o.provenBy[0].citedEvent).toEqual({
      runId: 'run1',
      eventId: 'e2',
      sequenceNumber: 2,
      eventType: 'tool.call',
      recordedAt: AT + 2,
    })
    expect(o.provenBy[0].observedValue).toBe('shell')
    expect(o.provenBy[0].decidedBy).toBe('inline_payload')
    expect(o.violatedPolicyRevision).toBe(1)
    expect(o.violatedBecause).toContain('SOC2')
  })

  it('THE ASYMMETRY: a proven violation survives a truncated read, an in-flight run, an unreadable neighbour, and a contaminated scan', () => {
    const o = fold(
      policy(),
      [ev(1, 'tool.call', { name: 'shell' }), ev(3, 'tool.call', { type: '_externalized' })],
      perfect({ runIsTerminal: false, logReadComplete: false, crossOrgRowsSkipped: 3 }),
    )
    expect(o.outcome).toBe('violated')
    if (o.outcome !== 'violated') throw new Error('unreachable')
    expect(o.violationCountIsFloor).toBe(true)
  })

  it('the count is exact when the read reached the end, a floor when it did not', () => {
    const complete = fold(policy(), [ev(1, 'tool.call', { name: 'shell' }), ev(2, 'run.completed', {})])
    expect(complete.outcome === 'violated' && complete.violationCountIsFloor).toBe(false)
  })

  it('egress: a denied host is proven with the value it observed', () => {
    const o = fold(policy({ rule: NO_EVIL }), [ev(1, 'http.request', { url: 'https://api.evil.example/v1' })])
    expect(o.outcome).toBe('violated')
    if (o.outcome !== 'violated') throw new Error('unreachable')
    // THE NORMALISED HOST, not the raw URL: the value the matcher actually
    // compared, so a reader can reproduce the decision from the finding alone.
    expect(o.provenBy[0].observedValue).toBe('api.evil.example')
  })

  it('a permitted operation is not a violation', () => {
    const o = fold(policy(), [ev(1, 'tool.call', { name: 'read_file' }), ev(2, 'run.completed', {})])
    expect(o.outcome).not.toBe('violated')
  })
})

// ===========================================================================
describe('the type-alone route, and its boundary', () => {
  it('the contract predicate is true ONLY for an absent target list', () => {
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied' })).toBe(true)
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'egress_denied' })).toBe(true)
    expect(ruleIsDecidableFromEventTypeAlone(NO_SHELL)).toBe(false)
    // A SHORT LIST IS NOT A DENY-ALL. Widening this manufactures proofs.
    expect(ruleIsDecidableFromEventTypeAlone({ kind: 'tool_denied', deniedTools: ['a'] })).toBe(false)
  })

  it('an EXTERNALIZED tool.call PROVES a violation when NO tool is permitted', () => {
    const o = fold(policy({ rule: { kind: 'tool_denied' } }), [
      ev(4, 'tool.call', { type: '_externalized', _artifact: { artifactId: 'a' } }),
    ])
    expect(o.outcome).toBe('violated')
    if (o.outcome !== 'violated') throw new Error('unreachable')
    expect(o.provenBy[0].decidedBy).toBe('event_type_alone')
    // NULL, not a placeholder string: nothing may read a sentinel as a tool name.
    expect(o.provenBy[0].observedValue).toBeNull()
  })

  it('THE BOUNDARY: the same event only WITHHOLDS against a rule naming a target', () => {
    const o = fold(policy(), [ev(4, 'tool.call', { type: '_externalized' })])
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('evidence_externalized')
  })

  it('the type-alone route is NEVER used against a targeted rule — the contradiction contracts audits', () => {
    for (const rule of [NO_SHELL, NO_EVIL, { kind: 'tool_denied', deniedTools: ['a', 'b'] } as PolicyRule]) {
      const o = fold(policy({ rule }), [
        ev(1, 'tool.call', { name: 'shell' }),
        ev(2, 'http.request', { url: 'https://evil.example/' }),
      ])
      if (o.outcome !== 'violated') continue
      for (const proof of o.provenBy) expect(proof.decidedBy).not.toBe('event_type_alone')
    }
  })

  it('deny-all egress proves on an externalized http.request too', () => {
    const o = fold(policy({ rule: { kind: 'egress_denied' } }), [ev(2, 'http.request', { type: '_externalized' })])
    expect(o.outcome).toBe('violated')
  })
})

// ===========================================================================
describe('INSTRUMENTATION — satisfied is unreachable for BOTH rule kinds', () => {
  it('THE REPRO: a closed run of nothing but run.started is NOT satisfied, for EVERY rule kind', () => {
    for (const rule of [NO_SHELL, NO_EVIL]) {
      const o = fold(policy({ rule }), [ev(1, 'run.started', {}), ev(2, 'run.completed', {})])
      expect(o.outcome, `rule ${rule.kind}`).toBe('not_evaluable')
      if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
      expect(o.kind).toBe('instrumentation_undeclared')
      expect(o).not.toHaveProperty('satisfiedPolicyId')
      expect(o).not.toHaveProperty('establishedBy')
    }
  })

  it('and a clean, closed, fully-legible run is likewise not satisfied for EVERY rule kind', () => {
    const cases: Array<[PolicyRule, PolicyObservableEvent]> = [
      [NO_SHELL, ev(2, 'tool.call', { name: 'read_file' })],
      [NO_EVIL, ev(2, 'http.request', { url: 'https://good.example/x' })],
    ]
    for (const [rule, event] of cases) {
      const o = fold(policy({ rule }), [ev(1, 'run.started', {}), event, ev(3, 'run.completed', {})])
      expect(o.outcome, `rule ${rule.kind}`).toBe('not_evaluable')
    }
  })

  it('the reason names the manual builder, not a data problem re-reading could fix', () => {
    const o = fold(policy(), [ev(1, 'run.started', {}), ev(2, 'run.completed', {})])
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.notEvaluableBecause).toContain('Events.toolCall')
    expect(o.notEvaluableBecause).toContain('READING of the log')
    expect(o.wouldBeEvaluableBy).toContain('declare')
    // The egress arm names its own builder.
    const e = fold(policy({ rule: NO_EVIL }), [ev(1, 'run.completed', {})])
    if (e.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(e.notEvaluableBecause).toContain('Events.httpRequest')
  })

  it('ONLY a claim covering THIS rule kind lifts it, and the licence then carries it', () => {
    const o = foldPolicyOutcome({
      policy: policy(),
      observation: observeRunAgainstPolicy(policy(), [ev(1, 'run.started', {}), ev(2, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('satisfied')
    if (o.outcome !== 'satisfied') throw new Error('unreachable')
    expect(o.establishedBy.instrumentation).toEqual(declaresBoth)
    // The five read literals are all there and they are literals.
    expect(o.establishedBy.logReadComplete).toBe(true)
    expect(o.establishedBy.payloadsAllReadable).toBe(true)
    expect(o.establishedBy.runIsTerminal).toBe(true)
    expect(o.establishedBy.crossOrgRowsSkipped).toBe(0)
    expect(o.establishedBy.forbiddenOperationsFound).toBe(0)
    expect(o.establishedBy.forPolicyId).toBe('pol1')
    // The CONTRACT's own validator agrees this licence is sound for this rule.
    expect(isCoverageProof(o.establishedBy, NO_SHELL)).toBe(true)
    // ...and it states the claim it rests on, so a reader is not left to supply it.
    expect(o.satisfiedBecause).toContain('ver_3')
    expect(o.satisfiedBecause).toContain('if that declaration is wrong')
  })

  it('A TOOL-CALL CLAIM CANNOT LICENSE AN EGRESS ALL-CLEAR', () => {
    const toolOnly: CompleteInstrumentationClaim = {
      ...declaresBoth,
      coversOperations: ['tool_denied'],
    }
    expect(instrumentationCovers(toolOnly, NO_SHELL)).toBe(true)
    expect(instrumentationCovers(toolOnly, NO_EVIL)).toBe(false)

    const o = foldPolicyOutcome({
      policy: policy({ rule: NO_EVIL }),
      observation: observeRunAgainstPolicy(policy({ rule: NO_EVIL }), [ev(1, 'run.completed', {})], {
        ...perfect(),
        instrumentation: toolOnly,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('instrumentation_undeclared')
    expect(o.notEvaluableBecause).toContain('not for this operation class')
  })

  it('an "undeclared" claim and an absent one are treated identically', () => {
    expect(instrumentationCovers({ claims: 'undeclared' }, NO_SHELL)).toBe(false)
    const explicit = foldPolicyOutcome({
      policy: policy(),
      observation: observeRunAgainstPolicy(policy(), [ev(1, 'run.completed', {})], {
        ...perfect(),
        instrumentation: { claims: 'undeclared' },
      }),
      evaluatedAt: AT,
    })
    const absent = fold(policy(), [ev(1, 'run.completed', {})])
    expect(explicit.outcome).toBe('not_evaluable')
    expect(absent.outcome).toBe('not_evaluable')
  })

  it('VIOLATED IS UNAFFECTED: an unrecorded operation cannot un-record a recorded one', () => {
    expect(fold(policy(), [ev(1, 'tool.call', { name: 'shell' })]).outcome).toBe('violated')
  })
})

// ===========================================================================
describe('unmapped spans and lossy provenance are undecidable, not irrelevant', () => {
  it('a run whose operation was an unmapped OTel span is NOT covered', () => {
    const o = observeRunAgainstPolicy(
      policy(),
      [ev(1, 'run.started', {}), ev(2, 'otel.span.unmapped', { spanName: 'mystery' }), ev(3, 'run.completed', {})],
      perfect(),
    )
    expect(o.undecidableCount).toBe(1)
    expect(isPolicyCoverageComplete(o)).toBe(false)
    const f = foldPolicyOutcome({ policy: policy(), observation: o, evaluatedAt: AT })
    expect(f.outcome).toBe('not_evaluable')
    if (f.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(f.kind).toBe('deciding_field_unreadable')
    expect(f.notEvaluableBecause).toContain('unmapped OpenTelemetry span')
  })

  it('an unmapped span is undecidable for EVERY rule kind, not just the deciding one', () => {
    for (const rule of [NO_SHELL, NO_EVIL, { kind: 'tool_denied' } as PolicyRule]) {
      const o = observeRunAgainstPolicy(policy({ rule }), [ev(2, 'otel.span.unmapped', {})], perfect())
      expect(o.undecidableCount, `rule ${rule.kind}`).toBe(1)
    }
  })

  it('even WITH a complete claim, an unmapped span still withholds', () => {
    const o = foldPolicyOutcome({
      policy: policy(),
      observation: observeRunAgainstPolicy(policy(), [ev(2, 'otel.span.unmapped', {}), ev(3, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
  })

  it('a LOSSY OTel-derived tool.call does not grade like a first-party one', () => {
    const lossy = observeRunAgainstPolicy(
      policy(),
      [ev(2, 'tool.call', { name: 'read_file' }, { source: 'otel', lossy: true })],
      perfect(),
    )
    const firstParty = observeRunAgainstPolicy(policy(), [ev(2, 'tool.call', { name: 'read_file' })], perfect())
    expect(lossy.undecidableCount).toBe(1)
    expect(firstParty.undecidableCount).toBe(0)
    expect(isPolicyCoverageComplete(lossy)).toBe(false)
  })

  it('a lossy event does NOT take the type-alone route either — an unreliable type is not a reliable one', () => {
    const o = observeRunAgainstPolicy(
      policy({ rule: { kind: 'tool_denied' } }),
      [ev(2, 'tool.call', { type: '_externalized' }, { source: 'otel', lossy: true })],
      perfect(),
    )
    expect(o.proofs).toHaveLength(0)
    expect(o.undecidableCount).toBe(1)
  })

  it('a NON-lossy OTel-derived event is decidable — the flag is what matters, not the source', () => {
    const o = observeRunAgainstPolicy(
      policy(),
      [ev(2, 'tool.call', { name: 'shell' }, { source: 'otel', lossy: false })],
      perfect(),
    )
    expect(o.undecidableCount).toBe(0)
    expect(o.proofs).toHaveLength(1)
    // ...and the ordering caveat is raised, because sequence is ARRIVAL order.
    expect(o.orderingCaveat).toBe(true)
  })
})

// ===========================================================================
describe('every not-evaluable kind the fold emits is a NAMED one', () => {
  it('the fallthrough kind is never used for a condition the fold identified', () => {
    const p = policy({ rule: { kind: 'egress_denied', deniedHosts: ['evil.example'] } })
    const cases: Array<[string, PolicyOutcome]> = [
      ['externalized', fold(policy(), [ev(1, 'tool.call', { type: '_externalized' })])],
      ['absent field', fold(policy(), [ev(1, 'tool.call', {})])],
      ['unmapped span', fold(policy(), [ev(1, 'otel.span.unmapped', {})])],
      ['lossy', fold(policy(), [ev(1, 'tool.call', { name: 'x' }, { source: 'otel', lossy: true })])],
      ['uninterpretable egress', fold(p, [ev(1, 'http.request', { url: 'nope' })])],
      ['in flight', fold(policy(), [], perfect({ runIsTerminal: false }))],
      ['truncated', fold(policy(), [], perfect({ logReadComplete: false }))],
      ['contaminated', fold(policy(), [], perfect({ crossOrgRowsSkipped: 1 }))],
      ['unreadable run', fold(policy(), [], perfect({ runObserved: false }))],
      ['undeclared', fold(policy(), [ev(1, 'run.completed', {})])],
    ]
    for (const [label, o] of cases) {
      expect(o.outcome, label).toBe('not_evaluable')
      if (o.outcome !== 'not_evaluable') continue
      expect(POLICY_NOT_EVALUABLE_KINDS).toContain(o.kind)
      expect(o.kind, label).not.toBe('coverage_unestablished')
    }
  })
})

describe('a disabled policy manufactures neither a violation nor an all-clear', () => {
  const off = policy({ enabled: false })

  it('produces NO violation on a run that plainly breaches it', () => {
    const o = observeRunAgainstPolicy(off, [ev(1, 'tool.call', { name: 'shell' })], perfect())
    expect(o.proofs).toEqual([])
    expect(o.operationsMatched).toBe(0)
    expect(o.relevantEventsSeen).toBe(0)
  })

  it('and is never reported as an all-clear either, even with a complete claim', () => {
    const o = foldPolicyOutcome({
      policy: off,
      observation: observeRunAgainstPolicy(off, [ev(1, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    // ITS OWN KIND, not the nearest neighbour: "switched off" and "malformed"
    // send an operator to two different places.
    // ITS OWN KIND, and the CONTRACT'S OWN SENTENCE — not one this boundary
    // composed. Enablement is read before the rule, so a disabled policy with a
    // vacuous rule says `policy_disabled` rather than sending an operator to fix
    // a rule on a policy nobody switched on.
    expect(o.kind).toBe('policy_disabled')
    expect(o.notEvaluableBecause).toContain('disabled')
    expect(o.notEvaluableBecause).toContain('neither be violated nor')
  })

  it('enablement is read through the CONTRACT, never spelled locally', () => {
    // A second spelling of "does this policy count" is how the pre-flight and
    // the evaluator came to disagree. `policyGoverns` is what
    // `matchRecordedEventAgainstPolicy` and `actIsForbiddenBy` both read.
    const src = (
      import.meta.glob('./policy.ts', { as: 'raw', eager: true }) as Record<string, string>
    )['./policy.ts']
    expect(src).toMatch(/policyGoverns\(policy\)/)
    // No local re-derivation of enablement anywhere in the module body.
    const body = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    expect(body.join('\n')).not.toMatch(/enabled\s*(!==|===)\s*true/)
  })

  it('a policy that is BOTH disabled and vacuous reports the disablement', () => {
    // Order matters and it is the contract's: fix the switch, not the rule.
    const both = policy({ enabled: false, rule: { kind: 'tool_denied', deniedTools: [] } })
    const o = foldPolicyOutcome({
      policy: both,
      observation: observeRunAgainstPolicy(both, [ev(1, 'run.completed', {})], perfect()),
      evaluatedAt: AT,
    })
    expect(o.outcome).toBe('not_evaluable')
    if (o.outcome !== 'not_evaluable') throw new Error('unreachable')
    expect(o.kind).toBe('policy_disabled')
  })
})

describe('the coverage predicate is positive in every clause', () => {
  const base: PolicyRunObservation = {
    ...perfect(),
    eventsExamined: 3,
    relevantEventsSeen: 1,
    undecidableCount: 0,
    undecidableSequenceNumbers: [],
    undecidableReasons: [],
    proofs: [],
    operationsMatched: 0,
    orderingCaveat: false,
  }

  it('accepts only the fully-positive observation', () => {
    expect(isPolicyCoverageComplete(base)).toBe(true)
  })

  it('every single degradation flips it to false', () => {
    expect(isPolicyCoverageComplete({ ...base, runObserved: false })).toBe(false)
    expect(isPolicyCoverageComplete({ ...base, runIsTerminal: false })).toBe(false)
    expect(isPolicyCoverageComplete({ ...base, logReadComplete: false })).toBe(false)
    expect(isPolicyCoverageComplete({ ...base, undecidableCount: 1 })).toBe(false)
    expect(isPolicyCoverageComplete({ ...base, crossOrgRowsSkipped: 1 })).toBe(false)
  })

  it('zero events examined does NOT make it false — that clause is deliberately absent', () => {
    expect(isPolicyCoverageComplete({ ...base, eventsExamined: 0, relevantEventsSeen: 0 })).toBe(true)
  })

  it('EXHAUSTIVE SWEEP over 64 combinations: satisfied is unreachable without a claim, and reachable from exactly one with it', () => {
    for (const withClaim of [false, true]) {
      let satisfied = 0
      let total = 0
      for (const runObserved of [true, false]) {
        for (const runIsTerminal of [true, false]) {
          for (const logReadComplete of [true, false]) {
            for (const crossOrgRowsSkipped of [0, 1]) {
              for (const undecidable of [false, true]) {
                for (const rule of [NO_SHELL, NO_EVIL]) {
                  total += 1
                  const decidingType = RULE_DECIDING_EVIDENCE[rule.kind].eventType
                  const events = undecidable
                    ? [ev(1, decidingType, { type: '_externalized' })]
                    : [ev(1, decidingType, { name: 'read_file', url: 'https://good.example/' })]
                  const o = foldPolicyOutcome({
                    policy: policy({ rule }),
                    observation: observeRunAgainstPolicy(policy({ rule }), events, {
                      runId: 'run1',
                      runObserved,
                      runIsTerminal,
                      logReadComplete,
                      crossOrgRowsSkipped,
                      observedAt: AT,
                      ...(withClaim ? { instrumentation: declaresBoth } : {}),
                    }),
                    evaluatedAt: AT,
                  })
                  // NO COMBINATION PRODUCES A VIOLATION (nothing forbidden here).
                  expect(o.outcome).not.toBe('violated')
                  if (o.outcome === 'satisfied') satisfied += 1
                }
              }
            }
          }
        }
      }
      expect(total).toBe(64)
      // ZERO without a claim; with one, exactly the perfect read for each of the
      // two rule kinds.
      //
      // BOTH ARMS REACH IT AGAIN, and that is D6's fix landing rather than
      // loosening. My interim repair made the egress arm permanently
      // unreachable, because a non-match could not be told from a value nobody
      // could interpret. The contract's primitive returns those as different
      // BANDS, so a genuinely permitted host clears and an uninterpretable one
      // withholds — which is what the sweep now shows.
      expect(satisfied, `withClaim=${withClaim}`).toBe(withClaim ? 2 : 0)
    }
  })
})

// ===========================================================================
describe('the report', () => {
  it('counts three states, never one, and never a ratio', () => {
    const report = buildPolicyScanReport({
      outcomes: [
        fold(policy(), [ev(1, 'tool.call', { name: 'shell' })]),
        unopenedRunOutcome(policy(), 'runZ', 'event_budget_exhausted'),
        noRunsInScopeOutcome(policy()),
      ],
      scan: scan({ runsInScope: 3, runsRead: 1, evaluationTruncated: true }),
      evaluatedAt: AT,
    })
    expect(report.counts).toEqual({ violated: 1, satisfied: 0, notEvaluable: 2 })
    expect(report).not.toHaveProperty('satisfiedCount')
    expect(report).not.toHaveProperty('complianceRate')
    expect(report.coverageStatement).toContain('floor')
    expect(producerComplianceClaimIn(report.coverageStatement)).toBeNull()
  })

  it('the retention horizon is NAMED — a report must not go clear by elapsed time in silence', () => {
    const report = buildPolicyScanReport({
      outcomes: [],
      scan: scan({ retentionHorizon: AT - 86_400_000 }),
      evaluatedAt: AT,
    })
    expect(report.coverageStatement).toContain('aged out')
    expect(report.coverageStatement).toContain('ADR-001')
  })

  it('the ordering caveat is forwarded rather than swallowed', () => {
    const report = buildPolicyScanReport({ outcomes: [], scan: scan({ orderingCaveat: true }), evaluatedAt: AT })
    expect(report.coverageStatement).toContain('ARRIVAL order')
  })

  it('an environment subject says it is a SELF-REPORT, not a trust boundary', () => {
    const report = buildPolicyScanReport({
      outcomes: [],
      scan: scan({ subject: { appliesTo: 'environment', environment: 'production' } }),
      evaluatedAt: AT,
    })
    expect(report.coverageStatement).toContain('SAID they were')
  })

  it('countPolicyOutcomes is the contract\'s and returns all three', () => {
    expect(countPolicyOutcomes([])).toEqual({ violated: 0, satisfied: 0, notEvaluable: 0 })
  })

  it('no_runs_in_scope is an OUTCOME, not an absence, and not an all-clear', () => {
    const o = noRunsInScopeOutcome(policy())
    expect(o.outcome).toBe('not_evaluable')
    expect(o.kind).toBe('no_runs_in_scope')
    expect(isEstablishedSatisfied(o)).toBe(false)
  })

  it('isEstablishedSatisfied fails closed on garbage', () => {
    expect(isEstablishedSatisfied({ outcome: 'nonsense' } as never)).toBe(false)
    expect(isEstablishedSatisfied(null as never)).toBe(false)
  })
})

// ===========================================================================
describe('policyGovernsRun decides positively in every branch', () => {
  const run = { projectId: 'p1', agentId: 'a1', environment: 'production' }
  it('matches on the named dimension only', () => {
    expect(policyGovernsRun({ appliesTo: 'org' }, run)).toBe(true)
    expect(policyGovernsRun({ appliesTo: 'project', projectId: 'p1' }, run)).toBe(true)
    expect(policyGovernsRun({ appliesTo: 'project', projectId: 'p2' }, run)).toBe(false)
    expect(policyGovernsRun({ appliesTo: 'agent', agentId: 'a1' }, run)).toBe(true)
    expect(policyGovernsRun({ appliesTo: 'environment', environment: 'production' }, run)).toBe(true)
  })

  it('an UNSET environment is not governed by an environment rule', () => {
    expect(
      policyGovernsRun({ appliesTo: 'environment', environment: 'production' }, {
        projectId: 'p1',
        agentId: 'a1',
      }),
    ).toBe(false)
  })
})

// ===========================================================================
describe('the pre-flight snapshot carries no verdict', () => {
  it('has no allow/deny field and takes its shelf life from the contract', () => {
    const s = buildPolicySnapshot({
      policies: [policy()],
      listingTruncated: false,
      subject: { appliesTo: 'org' },
      answeredAt: AT,
    })
    for (const forbidden of ['allowed', 'decision', 'deny', 'blocked', 'permitted', 'verdict']) {
      expect(s).not.toHaveProperty(forbidden)
    }
    expect(s.shelfLifeMs).toBe(600_000)
    expect(s.policiesInScope).toBe(1)
  })

  it('a truncated listing says so in its own field', () => {
    const s = buildPolicySnapshot({
      policies: [],
      listingTruncated: true,
      subject: { appliesTo: 'org' },
      answeredAt: AT,
    })
    expect(s.listingTruncated).toBe(true)
  })
})

// ===========================================================================
describe('the three outcomes share no field — a flattening read cannot compile', () => {
  it('ids are spelled differently per variant', () => {
    const v = fold(policy(), [ev(1, 'tool.call', { name: 'shell' })])
    const s = foldPolicyOutcome({
      policy: policy(),
      observation: observeRunAgainstPolicy(policy(), [ev(1, 'run.completed', {})], {
        ...perfect(),
        instrumentation: declaresBoth,
      }),
      evaluatedAt: AT,
    })
    const n = fold(policy(), [], perfect({ logReadComplete: false }))
    expect([v.outcome, s.outcome, n.outcome]).toEqual(['violated', 'satisfied', 'not_evaluable'])
    const keys = [v, s, n].map((o) => new Set(Object.keys(o)))
    const shared = [...keys[0]].filter((k) => keys[1].has(k) && keys[2].has(k))
    expect(shared).toEqual(['outcome'])
  })
})

// ===========================================================================
describe('BOTH CLAIM GUARDS sweep every sentence this module can emit', () => {
  // The generalised form of the two sentences that fired during development
  // ("terminated", "stopped"). A sweep, not a regression pair.
  const everyOutcome = (): PolicyOutcome[] => {
    const out: PolicyOutcome[] = []
    const rules: PolicyRule[] = [
      NO_SHELL,
      NO_EVIL,
      { kind: 'tool_denied' },
      { kind: 'egress_denied' },
      { kind: 'tool_denied', deniedTools: [] },
    ]
    for (const rule of rules) {
      const p = policy({ rule })
      const decidingType = RULE_DECIDING_EVIDENCE[rule.kind].eventType
      const payloads: unknown[] = [
        { name: 'shell', url: 'https://evil.example/' },
        { name: 'ok', url: 'https://good.example/' },
        { type: '_externalized' },
        {},
      ]
      for (const payload of payloads) {
        for (const facts of [
          perfect(),
          perfect({ runObserved: false }),
          perfect({ logReadComplete: false }),
          perfect({ runIsTerminal: false }),
          perfect({ crossOrgRowsSkipped: 1 }),
          { ...perfect(), instrumentation: declaresBoth } as PolicyRunReadFacts,
          { ...perfect(), instrumentation: { claims: 'undeclared' } } as PolicyRunReadFacts,
        ]) {
          out.push(
            foldPolicyOutcome({
              policy: p,
              observation: observeRunAgainstPolicy(
                p,
                [ev(1, decidingType, payload), ev(2, 'otel.span.unmapped', {})],
                facts,
              ),
              evaluatedAt: AT,
            }),
          )
        }
      }
      out.push(noRunsInScopeOutcome(p))
      out.push(unopenedRunOutcome(p, 'runQ', 'event_budget_exhausted'))
      out.push(unopenedRunOutcome(p, 'runQ', 'run_budget_exhausted'))
    }
    return out
  }

  it('composes without throwing, across the full cross-product', () => {
    expect(() => everyOutcome()).not.toThrow()
    expect(everyOutcome().length).toBeGreaterThan(140)
  })

  it('no emitted sentence claims anything about agent execution', () => {
    for (const o of everyOutcome()) {
      const sentences =
        o.outcome === 'not_evaluable'
          ? [o.notEvaluableBecause, o.wouldBeEvaluableBy]
          : o.outcome === 'violated'
            ? [o.violatedBecause]
            : [o.satisfiedBecause]
      for (const s of sentences) expect(executionClaimIn(s), s).toBeNull()
    }
  })

  it('no not_evaluable sentence reads as an all-clear', () => {
    for (const o of everyOutcome()) {
      if (o.outcome !== 'not_evaluable') continue
      expect(producerComplianceClaimIn(o.notEvaluableBecause), o.notEvaluableBecause).toBeNull()
      expect(producerComplianceClaimIn(o.wouldBeEvaluableBy), o.wouldBeEvaluableBy).toBeNull()
    }
  })

  it('the compliance guard catches the sentence a contributor would actually write', () => {
    for (const bad of [
      'No violations were found for this run.',
      'This run is compliant.',
      'Scan passed.',
      'Nothing found.',
      'All clear.',
      'The log is clean.',
    ]) {
      expect(() => assertNoComplianceClaim(bad, 'test')).toThrow(/vocabulary violation/)
    }
    expect(() => assertNoComplianceClaim('The log could not be read to its end.', 'test')).not.toThrow()
  })

  it('and the imported execution guard still catches the two that fired in development', () => {
    expect(() => assertNoComplianceClaim('this terminated run was read', 'test')).toThrow(/terminated/)
    expect(() => assertNoComplianceClaim('the scan stopped after 5 events', 'test')).toThrow(/stopped/)
  })
})
