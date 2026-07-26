/**
 * D6 — THE FALSE ALL-CLEAR THAT CAME FROM SPLITTING EXTRACTION FROM MATCHING.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT, AND WHY THE NARROW FIX WOULD HAVE BEEN THE WRONG ONE
 * ---------------------------------------------------------------------------
 *
 * Host EXTRACTION and host MATCHING lived in different modules with different
 * vocabularies. The reader accepted `url`, `uri`, `endpoint`, `host` and
 * `hostname`; the matcher only understood full URLs. So:
 *
 *   { url:  "https://evil.example/x" }  -> raw URL      -> matcher parses it  -> MATCHES
 *   { host: "evil.example"           }  -> bare host    -> matcher parses it  -> NOTHING
 *
 * The second is a RECORDED, INLINE, FULLY LEGIBLE forbidden egress. It was
 * examined, counted as a present and readable deciding field, matched against
 * nothing, and — with a complete instrumentation claim — returned `satisfied`.
 * Not a crash and not a hedge: THE EXACT OUTCOME THIS FEATURE EXISTS TO
 * PREVENT, reached through two functions that were each individually correct.
 *
 * Teaching the matcher a second spelling would have left two places that must
 * agree about what a host is, and the next spelling reopens it. So the pair is
 * gone: `matchRecordedEventAgainstRule` takes a whole event and does both, the
 * duplicate normaliser was DELETED rather than kept in sync, and there is no
 * exported function that performs half of the operation.
 *
 * This file is the regression, and it sweeps the spellings rather than testing
 * the one that failed — a fix verified only against its own reproduction is a
 * fix that holds until the next field name.
 */
import {
  actIsForbiddenBy,
  hostFallsUnder,
  hostForMatching,
  isInterpretableRule,
  matchRecordedEventAgainstPolicy,
  policyGoverns,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import { egressAllPolicy, toolPolicy } from './policy_fixtures.js'

import type { PolicyDefinition, PolicyRule, RuleMatch } from '@agent-flight-recorder/contracts'

/** The rule under attack: deny egress to one named host and its subdomains. */
const DENY_EVIL: PolicyRule = { kind: 'egress_denied', deniedHosts: ['evil.example.com'] }

/** The policy form of the same rule, for the pre-flight half. */
const denyEvilPolicy: PolicyDefinition = {
  ...egressAllPolicy(),
  rule: DENY_EVIL,
}

/** Wrap a rule in an ENABLED policy — the subject both halves now take. */
function policyFor(rule: PolicyRule): PolicyDefinition {
  return { ...egressAllPolicy(), rule }
}

function match(payload: unknown, rule: PolicyRule = DENY_EVIL): RuleMatch {
  return matchRecordedEventAgainstPolicy({ type: 'http.request', payload }, policyFor(rule))
}

describe('D6 — every spelling of the deciding field reaches the SAME matcher', () => {
  /**
   * THE SWEEP IS THE POINT. The reported defect was `host`; the fix must hold
   * for every candidate the reader ever accepted, because the reader's list is
   * what diverged from the matcher in the first place.
   */
  const FORBIDDEN_SPELLINGS: Array<[string, unknown]> = [
    ['url, absolute', { url: 'https://evil.example.com/steal' }],
    ['uri', { uri: 'https://evil.example.com/steal' }],
    ['endpoint', { endpoint: 'https://evil.example.com/steal' }],
    ['host, bare — THE REPORTED DEFECT', { host: 'evil.example.com' }],
    ['hostname, bare', { hostname: 'evil.example.com' }],
    ['host with a port', { host: 'evil.example.com:443' }],
    ['host, a subdomain', { host: 'api.evil.example.com' }],
    ['url, a subdomain', { url: 'https://api.evil.example.com/x' }],
    ['host, trailing root dot', { host: 'evil.example.com.' }],
    ['host, mixed case', { host: 'EVIL.Example.COM' }],
    ['url with a port', { url: 'https://evil.example.com:8443/x' }],
    ['url with credentials in the path-side', { url: 'https://user:pw@evil.example.com/x' }],
    ['bare value carrying a path', { host: 'evil.example.com/x' }],
  ]

  it.each(FORBIDDEN_SPELLINGS)('%s is FORBIDDEN, not cleared', (_label, payload) => {
    const result = match(payload)
    expect(result.match).toBe('forbidden')
    // And it never clears — the band that clears is a different one entirely.
    expect(result.match).not.toBe('permitted_by_this_rule')
  })

  it('the reported defect specifically: `host` no longer returns a clearing band', () => {
    // Before the fix this was `{ availability: 'field_present' }` with no match,
    // which the fold read as "read it, nothing forbidden" and turned into
    // `satisfied`.
    const result = match({ host: 'evil.example.com' })
    expect(result).toEqual({ match: 'forbidden', observedValue: 'evil.example.com', decidedBy: 'inline_payload' })
  })

  /** TEETH — the matcher is not simply returning `forbidden` for everything. */
  const PERMITTED_SPELLINGS: Array<[string, unknown]> = [
    ['a different host entirely', { host: 'safe.example.com' }],
    ['the label-boundary near-miss', { host: 'myevil.example.com' }],
    ['the same near-miss as a URL', { url: 'https://myevil.example.com/x' }],
    ['userinfo naming the denied host — reaches safe.example', { url: 'https://evil.example.com@safe.example/x' }],
    ['a suffix that is not a parent domain', { host: 'evil.example.com.attacker.test' }],
  ]

  it.each(PERMITTED_SPELLINGS)('%s is read and NOT forbidden', (_label, payload) => {
    const result = match(payload)
    expect(result.match).toBe('permitted_by_this_rule')
  })

  it('the userinfo case is right in BOTH directions', () => {
    // `https://evil.example.com@safe.example/` REACHES safe.example. Getting
    // this backwards is a real bypass either way, and the second direction puts
    // a false accusation in a compliance report.
    expect(match({ url: 'https://evil.example.com@safe.example/x' }).match).toBe('permitted_by_this_rule')
    expect(match({ url: 'https://safe.example@evil.example.com/x' }).match).toBe('forbidden')
  })
})

describe('D6 — an UNINTERPRETABLE value is not evidence of compliance', () => {
  /**
   * The second half of the report. An unparseable value read as `field_present`
   * and cleared, which is the same shape as `not_evaluable` rendering as
   * `satisfied` — the thing ADR-009 §5 is about.
   */
  const UNREADABLE: Array<[string, unknown]> = [
    ['an empty-ish URL', { url: 'https://' }],
    ['a scheme with nothing after it', { url: 'https://   ' }],
    ['a host with a space', { host: 'evil example com' }],
    ['a host that is a quoted blob', { host: '"evil.example.com"' }],
    ['an unterminated IPv6 literal', { host: '[::1' }],
    ['a URL whose authority is only credentials', { url: 'https://user@/x' }],
    ['a payload with no deciding field at all', { method: 'GET' }],
    ['a payload that is not an object', 'nope'],
    ['a payload that is null', null],
    ['a deciding field that is not a string', { host: 12345 }],
    ['a deciding field that is an empty string', { host: '   ' }],
  ]

  it.each(UNREADABLE)('%s is UNDECIDABLE, never permitted', (_label, payload) => {
    const result = match(payload)
    expect(result.match).toBe('undecidable')
    // THE ASSERTION THAT MATTERS: it is not the clearing band.
    expect(result.match).not.toBe('permitted_by_this_rule')
    if (result.match === 'undecidable') {
      // And it names a `not_evaluable` kind the run-level outcome can carry, so
      // the honesty survives the fold rather than stopping here.
      expect(['deciding_field_unreadable', 'evidence_externalized']).toContain(result.kind)
      expect(result.because.length).toBeGreaterThan(0)
      expect(result.wouldBeEvaluableBy.length).toBeGreaterThan(0)
    }
  })

  it('an externalized payload is undecidable against a TARGETED rule', () => {
    const result = match({ type: '_externalized', originalType: 'http.request', _artifact: {} })
    expect(result.match).toBe('undecidable')
    expect(result.match === 'undecidable' && result.kind).toBe('evidence_externalized')
  })

  it('but the SAME externalized payload is FORBIDDEN against a deny-all rule', () => {
    // The event TYPE survives Event Log Rule 3, and which host it was cannot
    // change the answer because nothing is permitted.
    const result = match(
      { type: '_externalized', originalType: 'http.request', _artifact: {} },
      { kind: 'egress_denied' }
    )
    expect(result).toEqual({ match: 'forbidden', observedValue: null, decidedBy: 'event_type_alone' })
  })

  it('an externalized payload that ALSO carries a spoofed host is still refused', () => {
    // A client could spoof the envelope alongside a real value. The envelope
    // means the payload is not here; believing the sibling field would be
    // trusting a claim the envelope contradicts.
    const result = match({ type: '_externalized', originalType: 'http.request', host: 'safe.example' })
    expect(result.match).toBe('undecidable')
  })

  it('and NEVER THROWS, on anything', () => {
    const hostile: unknown[] = [
      undefined,
      Symbol('x'),
      [],
      { host: { toString() { throw new Error('hostile') } } },
      new Proxy({}, { get() { throw new Error('hostile') } }),
    ]
    for (const payload of hostile) {
      expect(() => match(payload)).not.toThrow()
      expect(match(payload).match).not.toBe('permitted_by_this_rule')
    }
  })
})

describe('D6 — extraction and matching cannot be performed separately', () => {
  it('`hostForMatching` accepts BOTH a URL and a bare host, from one implementation', () => {
    // The single normaliser. Before the fix these two spellings went to
    // different code with different ideas of what a host is.
    expect(hostForMatching('https://evil.example.com/x')).toBe('evil.example.com')
    expect(hostForMatching('evil.example.com')).toBe('evil.example.com')
    expect(hostForMatching('evil.example.com:443')).toBe('evil.example.com')
    expect(hostForMatching('https://user@evil.example.com:8443/x')).toBe('evil.example.com')
    expect(hostForMatching('EVIL.Example.COM.')).toBe('evil.example.com')
  })

  it('and returns `null` — not a host that matches nothing — for what it cannot read', () => {
    for (const bad of ['', '   ', 'https://', 'evil example', '"evil.example"', '[::1']) {
      expect(hostForMatching(bad), `${bad} must not normalise`).toBeNull()
    }
  })

  it('everything `hostForMatching` produces is something `hostFallsUnder` can judge', () => {
    // The property that the split violated: extraction must produce exactly what
    // matching consumes. Asserted over both spellings of every case.
    for (const raw of [
      'https://api.evil.example.com/x',
      'api.evil.example.com',
      'api.evil.example.com:443',
      'https://EVIL.example.com',
    ]) {
      const host = hostForMatching(raw)
      expect(host).not.toBeNull()
      expect(hostFallsUnder(host as string, 'evil.example.com'), `${raw} falls under evil.example.com`).toBe(true)
    }
  })

  it('the PRE-FLIGHT and the EVALUATOR agree on every spelling', () => {
    // The two halves that must never diverge: the pre-flight decides a caller's
    // description, the evaluator decides a recorded payload, and an act one
    // permitted must not be a violation to the other.
    for (const value of [
      'https://evil.example.com/x',
      'evil.example.com',
      'evil.example.com:443',
      'api.evil.example.com',
      'EVIL.Example.COM',
    ]) {
      const preflight = actIsForbiddenBy(denyEvilPolicy, { kind: 'egress_denied', value })
      const evaluator = match({ url: value }).match === 'forbidden'
      expect(preflight, `pre-flight must forbid ${value}`).toBe(true)
      expect(evaluator, `evaluator must forbid ${value}`).toBe(true)
    }
    for (const value of ['https://safe.example/x', 'myevil.example.com', 'safe.example']) {
      expect(actIsForbiddenBy(denyEvilPolicy, { kind: 'egress_denied', value })).toBe(false)
      expect(match({ url: value }).match).toBe('permitted_by_this_rule')
    }
  })
})

describe('an empty denied list is a misconfiguration, not a deny-all and not a pass', () => {
  it('`isInterpretableRule` rejects it at EVALUATION time', () => {
    expect(isInterpretableRule({ kind: 'egress_denied', deniedHosts: [] })).toBe(false)
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: [] })).toBe(false)
    // `undefined` is the deny-the-operation form and IS interpretable.
    expect(isInterpretableRule({ kind: 'egress_denied' })).toBe(true)
    expect(isInterpretableRule({ kind: 'tool_denied', deniedTools: ['shell.exec'] })).toBe(true)
    expect(isInterpretableRule({ kind: 'vibes' } as unknown as PolicyRule)).toBe(false)
  })

  it('a vacuous rule is UNDECIDABLE, so it can never clear a run', () => {
    const result = match({ host: 'evil.example.com' }, { kind: 'egress_denied', deniedHosts: [] })
    expect(result.match).toBe('undecidable')
    expect(result.match === 'undecidable' && result.kind).toBe('policy_unreadable')
  })

  it('and the pre-flight declines to claim a match on one, in both halves', () => {
    const vacuous: PolicyDefinition = { ...egressAllPolicy(), rule: { kind: 'egress_denied', deniedHosts: [] } }
    expect(actIsForbiddenBy(vacuous, { kind: 'egress_denied', value: 'https://evil.example.com' })).toBe(false)
    const vacuousTool: PolicyDefinition = { ...toolPolicy(), rule: { kind: 'tool_denied', deniedTools: [] } }
    expect(actIsForbiddenBy(vacuousTool, { kind: 'tool_denied', value: 'shell.exec' })).toBe(false)
  })
})

describe('the tool half of the same primitive', () => {
  const DENY_SHELL: PolicyRule = { kind: 'tool_denied', deniedTools: ['shell.exec'] }

  function toolMatch(payload: unknown, rule: PolicyRule = DENY_SHELL): RuleMatch {
    return matchRecordedEventAgainstPolicy({ type: 'tool.call', payload }, { ...toolPolicy(), rule })
  }

  it('every spelling an emitter uses reaches the matcher', () => {
    for (const payload of [
      { name: 'shell.exec' },
      { tool: 'shell.exec' },
      { tool_name: 'shell.exec' },
      { toolName: 'shell.exec' },
      { function: { name: 'shell.exec' } },
    ]) {
      expect(toolMatch(payload).match, JSON.stringify(payload)).toBe('forbidden')
    }
  })

  it('a tool name is matched EXACTLY — it is an identifier, not a domain', () => {
    // `hostFallsUnder`'s suffix semantics must not leak across rule kinds.
    expect(toolMatch({ name: 'shell.exec' }).match).toBe('forbidden')
    expect(toolMatch({ name: 'safe.shell.exec' }).match).toBe('permitted_by_this_rule')
    expect(toolMatch({ name: 'shell.exec.safe' }).match).toBe('permitted_by_this_rule')
  })

  it('an unreadable name is undecidable, not permitted', () => {
    expect(toolMatch({ input: {} }).match).toBe('undecidable')
    expect(toolMatch({ name: 42 }).match).toBe('undecidable')
  })
})

describe('a wrong-typed event is SILENT, not clean', () => {
  it('an llm.request says nothing about a tool policy', () => {
    // `not_relevant` is its own band. Folding it into "permitted" would mean a
    // run made only of irrelevant events reads as one shown to comply.
    const result = matchRecordedEventAgainstPolicy(
      { type: 'llm.request', payload: { model: 'claude-opus-5' } },
      { ...toolPolicy(), rule: { kind: 'tool_denied', deniedTools: ['shell.exec'] } }
    )
    expect(result.match).toBe('not_relevant')
    expect(result.match).not.toBe('permitted_by_this_rule')
  })

  it('and a deny-all rule does NOT fire on the wrong event type', () => {
    // The type-alone shortcut is reached only after the event type matches. A
    // deny-all-egress rule must not be tripped by a tool.call.
    const result = matchRecordedEventAgainstPolicy(
      { type: 'tool.call', payload: { name: 'fs.read' } },
      { ...egressAllPolicy(), rule: { kind: 'egress_denied' } }
    )
    expect(result.match).toBe('not_relevant')
  })
})

describe('a DISABLED policy governs nothing — and that is neither a violation nor a pass', () => {
  /**
   * The same shape as D6, one level up, and worse in one direction. The
   * evaluator used to take a `PolicyRule` and so STRUCTURALLY COULD NOT see
   * `enabled`, while `actIsForbiddenBy` took the whole policy and did check it.
   * Two halves of one predicate asking different questions about the same
   * subject.
   *
   * A false all-clear is believed; A FALSE VIOLATION IS ACTED ON — somebody
   * rolls back, or blocks a deploy, on a rule that was explicitly turned off.
   * It survived only because the backend's loader happened to filter disabled
   * rows first, which is exactly the defence-in-depth that hid D6 for a cycle.
   */
  const disabled: PolicyDefinition = { ...egressAllPolicy(), rule: DENY_EVIL, enabled: false }

  it('a plainly breaching payload produces NO violation', () => {
    const result = matchRecordedEventAgainstPolicy(
      { type: 'http.request', payload: { host: 'evil.example.com' } },
      disabled
    )
    expect(result.match).toBe('undecidable')
    expect(result.match).not.toBe('forbidden')
  })

  it('and it is NOT an all-clear either — `not_evaluable`, so a failing scan cannot be switched off to pass', () => {
    const result = matchRecordedEventAgainstPolicy(
      { type: 'http.request', payload: { host: 'safe.example' } },
      disabled
    )
    expect(result.match).toBe('undecidable')
    expect(result.match).not.toBe('permitted_by_this_rule')
    expect(result.match === 'undecidable' && result.kind).toBe('policy_disabled')
  })

  it('enablement is read BEFORE the rule, so an operator is not sent to fix the wrong thing', () => {
    const disabledAndVacuous: PolicyDefinition = {
      ...egressAllPolicy(),
      rule: { kind: 'egress_denied', deniedHosts: [] },
      enabled: false,
    }
    const result = matchRecordedEventAgainstPolicy({ type: 'http.request', payload: {} }, disabledAndVacuous)
    expect(result.match === 'undecidable' && result.kind).toBe('policy_disabled')
  })

  it('BOTH halves read the same governance predicate', () => {
    // The property the split violated. `policyGoverns` is the single reading,
    // and the pre-flight and the evaluator must agree on every input.
    const cases: Array<[string, PolicyDefinition]> = [
      ['enabled and interpretable', policyFor(DENY_EVIL)],
      ['disabled', disabled],
      ['vacuous rule', policyFor({ kind: 'egress_denied', deniedHosts: [] })],
      ['not an object', null as unknown as PolicyDefinition],
    ]
    for (const [label, policy] of cases) {
      const governs = policyGoverns(policy)
      const preflight = actIsForbiddenBy(policy, { kind: 'egress_denied', value: 'https://evil.example.com' })
      const evaluator = matchRecordedEventAgainstPolicy(
        { type: 'http.request', payload: { host: 'evil.example.com' } },
        policy
      )
      // A policy that does not govern forbids nothing in the pre-flight and
      // decides nothing in the evaluator. A policy that governs does both.
      expect(preflight, `${label}: pre-flight`).toBe(governs)
      expect(evaluator.match === 'forbidden', `${label}: evaluator`).toBe(governs)
    }
  })

  it('teeth — the SAME policy enabled does produce the violation', () => {
    const result = matchRecordedEventAgainstPolicy(
      { type: 'http.request', payload: { host: 'evil.example.com' } },
      { ...disabled, enabled: true }
    )
    expect(result.match).toBe('forbidden')
  })

  it('`policyGoverns` never throws and fails closed on junk', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}, { enabled: 'yes' }]) {
      expect(() => policyGoverns(junk as unknown as PolicyDefinition)).not.toThrow()
      expect(policyGoverns(junk as unknown as PolicyDefinition)).toBe(false)
    }
  })
})
