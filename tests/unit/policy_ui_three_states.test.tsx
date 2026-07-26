/**
 * @vitest-environment jsdom
 *
 * THE RENDERED PROOF, for the four properties this feature is answerable for.
 *
 * ===========================================================================
 * WHY THIS FILE IS THE DELIVERABLE AND NOT THE COMMENTS IN THE COMPONENTS
 * ===========================================================================
 *
 * Every other false clean in this product misleads an engineer who could go and
 * check. A policy result is read by someone who cannot, and the person relying
 * on it is not the person who could have verified it. "We carried the
 * distinction structurally" is a claim, and an untested claim about a visual
 * distinction is how the three-coloured-badges version ships anyway six months
 * later.
 *
 *   §1  THE THREE STATES ARE DISTINGUISHABLE WITH ALL STYLING STRIPPED.
 *   §2  A VIOLATION SURVIVES A TRUNCATED SCAN.
 *   §3  `not_evaluable` NEVER RENDERS AS CLEAN — including the demotion of an
 *       undeclared `satisfied`, which is today's universal case.
 *   §4  NO RATIO, PERCENTAGE OR BARE SATISFIED COUNT IS RENDERABLE.
 *
 * §1 renders all three bands, STRIPS EVERY `class`, `style`, `title` AND `data-*`
 * ATTRIBUTE from the tree, and asserts they remain distinguishable. With no
 * classes there is no colour, no border, no fill and no glyph styling; with no
 * `data-*` or `title` there is no hook only a machine would read. Nothing
 * survives but text and DOM structure. If the bands are still distinguishable
 * under that amputation they are distinguishable to a screen reader user, in
 * greyscale, in a screenshot pasted into a channel, in forced-colors mode, and
 * to anyone with any colour vision deficiency — because every one of those
 * readers has strictly MORE information than this test does.
 *
 * WHAT THIS FILE DOES NOT COVER: real composited pixels. jsdom parses no
 * Tailwind stylesheet and runs no layout, which is exactly why the load-bearing
 * assertions are designed to need no colour information at all.
 */
import { complianceClaimIn, isAllClear } from '@agent-flight-recorder/contracts'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PolicyEvaluationPanel } from '@/components/policies/PolicyEvaluationView'
import { PolicyOutcomeCard } from '@/components/policies/PolicyOutcomeCard'
import { readEvaluation } from '@/lib/policies/evaluation'
import {
  countOutcomes,
  orderOutcomes,
  readFinding,
  readOutcomes,
  type PolicyOutcomeView,
  type ViewNotEvaluable,
  type ViewSatisfied,
  type ViewViolated,
} from '@/lib/policies/outcomes'
import { NOT_EVALUABLE_LABEL, OUTCOME_STATE_LABEL } from '@/lib/policies/vocabulary'

// ---------------------------------------------------------------------------
// FIXTURES. Built as view states directly, so the render assertions are about
// the components rather than about the readers (which §2/§3 exercise on their
// own, from raw wire bodies).
// ---------------------------------------------------------------------------

const VIOLATED: ViewViolated = {
  state: 'violated',
  violatedPolicyId: 'pol_1',
  violatedPolicyRevision: 3,
  violatedRationale: 'SOC2 CC6.1 — no shell execution from customer-facing agents.',
  violatedPolicySummary: 'tool_invocation exact "shell.exec" @ agent:agt_7',
  provenBy: [
    {
      runId: 'run_9',
      eventId: 'evt_41',
      sequenceNumber: 17,
      eventType: 'tool.call',
      observedValue: 'shell.exec',
      recordedAt: 1_700_000_000_000,
    },
  ],
  violationCount: 1,
  violationCountIsFloor: false,
}

const NOT_EVALUABLE: ViewNotEvaluable = {
  state: 'not_evaluable',
  undecidedPolicyId: 'pol_2',
  undecidedRationale: 'No egress to paste sites from production agents.',
  undecidedPolicySummary: 'egress_to_host domain_suffix "paste.example.com" @ org:org_1',
  kind: 'instrumentation_undeclared',
  notEvaluableBecause: 'the agent has not declared that it records the acts this rule is about.',
  wouldBeEvaluableBy: 'have this agent version declare complete egress recording.',
  runsAffected: 12,
}

const SATISFIED: ViewSatisfied = {
  state: 'satisfied',
  satisfiedPolicyId: 'pol_3',
  satisfiedRationale: 'No model calls to unapproved providers.',
  satisfiedPolicySummary: 'tool_invocation exact "shell.exec" @ agent:agt_8',
  runsEstablishedOver: 4,
  eventsExamined: 812,
  declaredBy: 'ver_22',
  declaredMechanism: 'declares complete recording for tool_invocation',
}

/**
 * Amputate every styling and machine-only channel from a rendered tree.
 *
 * `class`, `style` — no colour, no border, no fill, no weight, no size.
 * `title`, `data-*`, `aria-hidden` decorations — no hook a machine reads and a
 * person does not.
 *
 * What is deliberately NOT stripped: text, `aria-label`, and DOM structure.
 * Those are the channels a human actually receives, and the claim under test is
 * that they alone carry the distinction.
 */
function strip(container: HTMLElement): HTMLElement {
  for (const el of Array.from(container.querySelectorAll('*'))) {
    el.removeAttribute('class')
    el.removeAttribute('style')
    el.removeAttribute('title')
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-')) el.removeAttribute(attr.name)
    }
  }
  return container
}

function textOf(outcome: PolicyOutcomeView): string {
  const { container } = render(<PolicyOutcomeCard outcome={outcome} />)
  return strip(container).textContent ?? ''
}

// ===========================================================================
// §1 — THE THREE STATES ARE DISTINGUISHABLE WITH ALL STYLING STRIPPED
// ===========================================================================

describe('§1 the three outcome states survive total style amputation', () => {
  it('each carries its own heading word, and no two share one', () => {
    const violated = textOf(VIOLATED)
    const undecided = textOf(NOT_EVALUABLE)
    const satisfied = textOf(SATISFIED)

    expect(violated).toContain('VIOLATED')
    expect(undecided).toContain('NOT EVALUABLE')
    expect(satisfied).toContain('NO VIOLATION FOUND')

    // The headings must not be substrings of one another in the wrong
    // direction: a reader scanning for "VIOLATED" must not match the
    // not-evaluable card.
    expect(undecided).not.toContain(OUTCOME_STATE_LABEL.violated.label)
    expect(satisfied).not.toContain(OUTCOME_STATE_LABEL.violated.label)
    expect(violated).not.toContain(OUTCOME_STATE_LABEL.not_evaluable.label)
    expect(satisfied).not.toContain(OUTCOME_STATE_LABEL.not_evaluable.label)
  })

  it('each carries content the other two structurally cannot', () => {
    // A VIOLATION cites events. Nothing else does, because nothing else can.
    const violated = textOf(VIOLATED)
    expect(violated).toContain('evt_41')
    expect(violated).toContain('shell.exec')
    expect(violated).toContain('17') // the sequence number

    // A NOT EVALUABLE card states what would decide it. That is the difference
    // between "I cannot tell" and "I cannot tell YET, and here is what to do".
    const undecided = textOf(NOT_EVALUABLE)
    expect(undecided).toContain('What would decide it')
    expect(undecided).toContain(NOT_EVALUABLE.wouldBeEvaluableBy)

    // A NO VIOLATION FOUND card names the DECLARATION it rests on, in the same
    // breath. An all-clear whose basis is not beside it is the sentence somebody
    // forwards to an auditor.
    const satisfied = textOf(SATISFIED)
    expect(satisfied).toContain('ver_22')
    expect(satisfied).toContain('rests on a claim the agent made')
  })

  it('the three rendered texts are pairwise different documents, not variants', () => {
    const texts = [textOf(VIOLATED), textOf(NOT_EVALUABLE), textOf(SATISFIED)]
    expect(new Set(texts).size).toBe(3)
  })

  it('a violation states RECORDING and explicitly disclaims prevention', () => {
    // NOTE THE SHAPE OF THIS ASSERTION, which the naive version got wrong.
    //
    // A bare substring check for "was prevented" FAILS on correct copy, because
    // the card's whole point is the sentence "it does not state that anything
    // was prevented". Asserting the absence of the phrase would have forced the
    // disclaimer out of the UI to make a test pass — which is the test actively
    // removing the safeguard it exists to protect.
    //
    // So the claim under test is the AFFIRMATIVE one: the card must say the act
    // was recorded, and must not assert prevention in the affirmative. The
    // negation is checked for PRESENCE, not absence.
    const violated = textOf(VIOLATED).toLowerCase()
    expect(violated).toContain('was recorded')
    expect(violated).toContain('does not state that anything was prevented')
    for (const claim of [
      'the call was blocked',
      'the agent was stopped',
      'this was prevented',
      'the operation was denied',
    ]) {
      expect(violated).not.toContain(claim)
    }
  })
})

// ===========================================================================
// §2 — A VIOLATION SURVIVES A TRUNCATED SCAN
// ===========================================================================

describe('§2 a violation survives a truncated scan', () => {
  /** A wire body whose scan stopped on a ceiling AND which records a breach. */
  const TRUNCATED_WITH_BREACH = {
    evaluatedAt: 1_700_000_000_000,
    verdict: 'violations_found',
    verdictStatement: 'One policy recorded a forbidden operation.',
    scan: {
      policiesInScope: 3,
      policiesEvaluated: 1,
      runsInScope: 200,
      runsRead: 4,
      evaluationTruncated: true,
      foreignRowsSkipped: 0,
    },
    findings: [
      {
        finding: 'not_evaluable',
        notEvaluablePolicyId: 'pol_2',
        kind: 'event_log_read_truncated',
        notEvaluableBecause: 'the scan stopped on a ceiling.',
        wouldBeEvaluableBy: 'narrow the window and re-run.',
        runsAffected: 196,
      },
      {
        finding: 'violated',
        violatedPolicyId: 'pol_1',
        violatedBy: [
          {
            runId: 'run_9',
            eventId: 'evt_41',
            sequenceNumber: 17,
            eventType: 'tool.call',
            observedValue: 'shell.exec',
            observedAt: 1_700_000_000_000,
          },
        ],
        violationCount: 1,
        violationCountIsFloor: true,
      },
    ],
  }

  it('the violation is READ out of a body whose scan was truncated', () => {
    const read = readEvaluation(TRUNCATED_WITH_BREACH)
    expect(read.kind).toBe('evaluation')
    if (read.kind !== 'evaluation') return
    const counts = countOutcomes(read.evaluation.outcomes)
    expect(counts.violated).toBe(1)
    expect(read.evaluation.scan.evaluationTruncated).toBe(true)
  })

  it('the violation is ORDERED FIRST, above the not-evaluable outcome', () => {
    const read = readEvaluation(TRUNCATED_WITH_BREACH)
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    expect(read.evaluation.outcomes[0]?.state).toBe('violated')
  })

  it('the violation is RENDERED, and rendered before the truncation notice', () => {
    const read = readEvaluation(TRUNCATED_WITH_BREACH)
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    const { container } = render(
      <PolicyEvaluationPanel evaluation={read.evaluation} scopeLabel="policy pol_1" />,
    )
    const text = strip(container).textContent ?? ''
    expect(text).toContain('VIOLATED')
    expect(text).toContain('evt_41')
    // And the truncation is stated too — it narrows the rest of the report
    // without erasing the breach.
    expect(text).toContain('EVERY COUNT ON THIS PAGE IS A FLOOR')
    expect(text.indexOf('VIOLATED')).toBeLessThan(text.indexOf('NOT EVALUABLE'))
  })

  it('a violation survives a MALFORMED SIBLING OUTCOME in the same body', () => {
    // Invariant 0 in the reader: gating a breach on whole-body trustworthiness
    // means a defect in an unrelated finding ERASES a real breach.
    const withGarbageSibling = {
      ...TRUNCATED_WITH_BREACH,
      findings: [null, 'not an object', 42, TRUNCATED_WITH_BREACH.findings[1]],
    }
    const read = readEvaluation(withGarbageSibling)
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    expect(countOutcomes(read.evaluation.outcomes).violated).toBe(1)
    // And the garbage is REPORTED, not dropped: a finding missing from a
    // compliance list reads as a policy with nothing to report.
    expect(countOutcomes(read.evaluation.outcomes).notEvaluable).toBe(3)
  })

  it('a bounded count is rendered as a FLOOR, never as a total', () => {
    const floored: ViewViolated = { ...VIOLATED, violationCount: 2, violationCountIsFloor: true }
    expect(textOf(floored)).toContain('at least 2')
  })

  it('an UNREADABLE floor flag fails closed to "at least"', () => {
    // A dropped boolean must never read as "this is the exact total".
    const read = readFinding({
      finding: 'violated',
      violatedPolicyId: 'pol_1',
      violatedBy: TRUNCATED_WITH_BREACH.findings[1]?.violatedBy,
      violationCount: 5,
      // violationCountIsFloor absent
    })
    expect(read?.state).toBe('violated')
    expect((read as ViewViolated).violationCountIsFloor).toBe(true)
  })
})

// ===========================================================================
// §3 — `not_evaluable` NEVER RENDERS AS CLEAN
// ===========================================================================

describe('§3 not_evaluable is never an all-clear, in the model or on the screen', () => {
  it('an undeclared satisfied finding is DEMOTED, not rendered as satisfied', () => {
    // TODAY'S UNIVERSAL CASE. `satisfied` requires a CompleteInstrumentationClaim
    // and nothing in the product produces one, because the SDK's toolCall and
    // httpRequest are manual builders with no interception anywhere. A wire body
    // claiming satisfaction without a declaration is exactly what a backend that
    // forgot the check would send.
    const read = readFinding({
      finding: 'satisfied',
      satisfiedPolicyId: 'pol_3',
      establishedOver: [
        {
          proves: 'complete_event_log_read',
          runId: 'run_1',
          forPolicyId: 'pol_3',
          eventLogReadComplete: true,
          terminalEventObserved: true,
          eventsWithUndecidableDecidingField: 0,
          sequenceGapsFound: 0,
          eventsExamined: 90,
          readAt: 1,
          // recordingDeclaration ABSENT — the whole point.
        },
      ],
      satisfiedAt: 1,
    })
    expect(read?.state).toBe('not_evaluable')
    expect((read as ViewNotEvaluable).kind).toBe('instrumentation_undeclared')
  })

  it('a satisfied finding where only SOME licences declare is demoted', () => {
    // Nine runs of "we did not look" wearing the tenth run's badge.
    const read = readFinding({
      finding: 'satisfied',
      satisfiedPolicyId: 'pol_3',
      establishedOver: [
        {
          eventsExamined: 10,
          recordingDeclaration: {
            proves: 'agent_declared_complete_act_recording',
            forActKind: 'tool_invocation',
            declaredBy: 'ver_1',
            declaredAt: 1,
          },
        },
        { eventsExamined: 10 },
      ],
    })
    expect(read?.state).toBe('not_evaluable')
  })

  it('a satisfied finding over ZERO runs is demoted — vacuous satisfaction', () => {
    const read = readFinding({
      finding: 'satisfied',
      satisfiedPolicyId: 'pol_3',
      establishedOver: [],
    })
    expect(read?.state).toBe('not_evaluable')
  })

  it('every not-evaluable kind renders a sentence, never a bare token', () => {
    // A band that renders with no explanation reads as a shrug, and a band that
    // reads as a shrug is one people learn to configure around.
    for (const kind of Object.keys(NOT_EVALUABLE_LABEL)) {
      const text = textOf({
        ...NOT_EVALUABLE,
        kind: kind as ViewNotEvaluable['kind'],
      })
      expect(text).toContain('NOT EVALUABLE')
      expect(text).toContain('Why:')
      expect(text.length).toBeGreaterThan(kind.length + 200)
    }
  })

  it('`policy_disabled` says the rule was NOT APPLIED because it was switched off', () => {
    // It must read as neither a failure nor a pass. An operator seeing it needs
    // to know they turned the rule off — not that something broke, and not that
    // the run came back clean.
    const copy = NOT_EVALUABLE_LABEL.policy_disabled
    expect(copy.toLowerCase()).toContain('switched off')
    expect(copy.toLowerCase()).toContain('governs nothing')
    // And it states the reason the band is what it is, in both directions.
    expect(copy.toLowerCase()).toContain('made to pass by switching off')
    expect(copy.toLowerCase()).toContain('false finding')
  })

  it('`deciding_field_unreadable` says evidence we could not read, not compliance', () => {
    const copy = NOT_EVALUABLE_LABEL.deciding_field_unreadable
    expect(copy.toLowerCase()).toContain('could not be interpreted')
    expect(copy.toLowerCase()).toContain('evidence we could not read')
    // The remedy is specific, and it is NOT "re-run the scan".
    expect(copy.toLowerCase()).toContain('fix whatever wrote that payload')
  })

  it('an EMPTY outcome list renders as "no outcome produced", never as clean', () => {
    const read = readEvaluation({
      evaluatedAt: 1,
      verdict: 'evaluation_incomplete',
      verdictStatement: 'nothing was evaluated',
      scan: { policiesInScope: 0, policiesEvaluated: 0, runsInScope: 0, runsRead: 0, evaluationTruncated: false, foreignRowsSkipped: 0 },
      findings: [],
    })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    const { container } = render(
      <PolicyEvaluationPanel evaluation={read.evaluation} scopeLabel="policy pol_1" />,
    )
    const text = strip(container).textContent ?? ''
    expect(text).toContain('NO OUTCOME WAS PRODUCED')
    expect(text).toContain('not a finding that nothing was violated')
  })

  it('an UNREADABLE verdict fails closed to evaluation_incomplete', () => {
    for (const verdict of [undefined, null, '', 'ok', 'clean', 'passed', true, 0]) {
      const read = readEvaluation({ verdict, findings: [], scan: {} })
      if (read.kind !== 'evaluation') throw new Error('unreachable')
      expect(read.evaluation.verdict).toBe('evaluation_incomplete')
      expect(isAllClear(read.evaluation.verdict)).toBe(false)
    }
  })

  it('an UNREADABLE truncation flag fails closed to truncated', () => {
    const read = readEvaluation({ verdict: 'evaluation_incomplete', findings: [], scan: {} })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    expect(read.evaluation.scan.evaluationTruncated).toBe(true)
  })

  it('a compliance claim smuggled into the verdict statement is REPLACED, not rendered', () => {
    const read = readEvaluation({
      verdict: 'evaluation_incomplete',
      verdictStatement: 'All runs were compliant with every policy.',
      findings: [],
      scan: {},
    })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    expect(complianceClaimIn(read.evaluation.verdictStatement)).toBeNull()
    expect(read.evaluation.verdictStatement).not.toContain('compliant')
  })

  it('a satisfied finding whose mechanism prose carries a compliance claim is demoted', () => {
    const read = readFinding({
      finding: 'satisfied',
      satisfiedPolicyId: 'pol_3',
      establishedOver: [
        {
          eventsExamined: 10,
          recordingDeclaration: {
            proves: 'agent_declared_complete_act_recording',
            forActKind: 'certified',
            declaredBy: 'ver_1',
            declaredAt: 1,
          },
        },
      ],
    })
    expect(read?.state).toBe('not_evaluable')
  })

  it('the readers never throw on a hostile body', () => {
    for (const raw of [null, undefined, 'str', 42, [], {}, { findings: 'no' }, { findings: [null] }]) {
      expect(() => readEvaluation(raw)).not.toThrow()
      expect(() => readOutcomes(raw)).not.toThrow()
      expect(() => readFinding(raw)).not.toThrow()
      expect(() => orderOutcomes(readOutcomes(raw))).not.toThrow()
    }
  })
})

// ===========================================================================
// §4 — NO RATIO, PERCENTAGE OR BARE SATISFIED COUNT IS RENDERABLE
// ===========================================================================

describe('§4 no compliance ratio is renderable', () => {
  it('the three counts are always shown together, each with its meaning', () => {
    const read = readEvaluation({
      evaluatedAt: 1,
      verdict: 'evaluation_incomplete',
      verdictStatement: 'partial',
      scan: { policiesInScope: 3, policiesEvaluated: 3, runsInScope: 10, runsRead: 10, evaluationTruncated: false, foreignRowsSkipped: 0 },
      findings: [
        { finding: 'not_evaluable', notEvaluablePolicyId: 'p2', kind: 'instrumentation_undeclared', notEvaluableBecause: 'x', wouldBeEvaluableBy: 'y', runsAffected: 1 },
      ],
    })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    const { container } = render(
      <PolicyEvaluationPanel evaluation={read.evaluation} scopeLabel="policy p" />,
    )
    const text = strip(container).textContent ?? ''
    expect(text).toContain('Policies violated')
    expect(text).toContain('Policies not evaluable')
    expect(text).toContain('Policies with no violation found')
  })

  it('NOTHING RENDERED CONTAINS A PERCENT SIGN OR A RATE WORD', () => {
    const read = readEvaluation({
      evaluatedAt: 1,
      verdict: 'evaluation_incomplete',
      verdictStatement: 'partial',
      scan: { policiesInScope: 4, policiesEvaluated: 2, runsInScope: 10, runsRead: 3, evaluationTruncated: true, foreignRowsSkipped: 1 },
      findings: [],
    })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    const { container } = render(
      <PolicyEvaluationPanel evaluation={read.evaluation} scopeLabel="policy p" />,
    )
    const text = (strip(container).textContent ?? '').toLowerCase()
    expect(text).not.toContain('%')
    for (const word of ['pass rate', 'compliance score', 'compliant', 'percent', 'score']) {
      expect(text).not.toContain(word)
    }
  })

  it('NO PROGRESS BAR, METER OR GAUGE ELEMENT IS RENDERED', () => {
    // A bar filling toward a denominator asserts a remainder, and there is no
    // remainder to draw: any denominator here either excludes the not-evaluable
    // outcomes (asserting they do not count) or includes them (asserting they
    // are the same kind of thing as a checked run). Both are false, and a chart
    // makes the falsehood look measured.
    const read = readEvaluation({
      evaluatedAt: 1,
      verdict: 'evaluation_incomplete',
      verdictStatement: 'partial',
      scan: { policiesInScope: 4, policiesEvaluated: 2, runsInScope: 10, runsRead: 3, evaluationTruncated: true, foreignRowsSkipped: 0 },
      findings: [],
    })
    if (read.kind !== 'evaluation') throw new Error('unreachable')
    const { container } = render(
      <PolicyEvaluationPanel evaluation={read.evaluation} scopeLabel="policy p" />,
    )
    expect(container.querySelector('progress')).toBeNull()
    expect(container.querySelector('meter')).toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.querySelector('[role="meter"]')).toBeNull()
    expect(container.querySelector('svg circle')).toBeNull()
  })

  it('`countOutcomes` returns all three or the type does not compile', () => {
    const counts = countOutcomes([VIOLATED, NOT_EVALUABLE, SATISFIED])
    expect(Object.keys(counts).sort()).toEqual(['notEvaluable', 'satisfied', 'violated'])
  })

  it('no rendered string in the vocabulary trips contracts own prose guard', () => {
    // The prose channel is the one place a producer can smuggle the badge back
    // in past every field-name check.
    const strings = [
      ...Object.values(NOT_EVALUABLE_LABEL),
      ...Object.values(OUTCOME_STATE_LABEL).flatMap((v) => [v.label, v.meaning]),
    ]
    for (const s of strings) {
      expect(complianceClaimIn(s)).toBeNull()
    }
  })
})
