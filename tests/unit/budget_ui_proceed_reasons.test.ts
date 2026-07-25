/**
 * THE FOUR PROCEED-REASONS ARE DISTINGUISHABLE WITH ALL STYLING STRIPPED.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS DEFENDING
 * ---------------------------------------------------------------------------
 *
 * Contracts gives the six decision bands no shared field, so no renderer can
 * print one under another's heading by forgetting to narrow. THAT BARRIER STOPS
 * AT THE TYPE. It does not stop a renderer from narrowing correctly and then
 * giving four distinct bands the same green tick — which collapses them just as
 * completely, one layer later, where nothing is checking.
 *
 * Four of the six mean "proceed" and they are four different facts:
 *
 *   allowed_breaker_armed        enforcement WORKED
 *   allowed_no_budget_governs    enforcement ABSENT
 *   allowed_within_grace         enforcement DEGRADED
 *   allowed_without_answer       enforcement OFF
 *
 * An organization whose decisions are entirely the fourth has no budget control
 * at all, and on a surface that renders all four alike its graphs are identical
 * to one that has. So the test below removes EVERY presentational signal —
 * colour, icon, weight, case, punctuation — and asserts the bands are still
 * four different sentences.
 *
 * IT ALSO ASSERTS THE COMPLEMENT: that the two "not checked" bands do not read
 * as the "checked" one. Distinctness alone is satisfied by four labels that all
 * begin "Allowed", which is precisely the collapse in question.
 */
import {
  decideBudget,
  type BudgetDecision,
  type BudgetUnavailablePolicy,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


import { armed, NOW, snapshot, tripped, unbudgetedSnapshot, undetermined } from './budget_fixtures'

import { BREAKER_STATE_LABEL, DECISION_LABEL } from '@/lib/budgets/vocabulary'


const ALL_BANDS: BudgetDecision['decision'][] = [
  'allowed_breaker_armed',
  'allowed_no_budget_governs',
  'allowed_within_grace',
  'allowed_without_answer',
  'declined_breaker_tripped',
  'declined_no_answer',
]

const PROCEED_BANDS: BudgetDecision['decision'][] = [
  'allowed_breaker_armed',
  'allowed_no_budget_governs',
  'allowed_within_grace',
  'allowed_without_answer',
]

/**
 * Everything a stylesheet could supply, removed.
 *
 * Case, punctuation, dashes and whitespace all go — so two labels that differ
 * only by an em-dash, or only by capitalisation, are treated as the SAME label.
 * That is the strict reading, and it is the right one: neither difference
 * survives being read aloud or being counted on a dashboard.
 */
function stripped(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('the decision vocabulary is total and distinct', () => {
  it('covers every band the contract defines', () => {
    for (const band of ALL_BANDS) {
      expect(DECISION_LABEL[band], `no label for ${band}`).toBeDefined()
      expect(DECISION_LABEL[band].label.length).toBeGreaterThan(0)
      expect(DECISION_LABEL[band].meaning.length).toBeGreaterThan(0)
    }
    // The record is exactly the union — a seventh key here would mean a band
    // the contract does not have, which is drift in the other direction.
    expect(Object.keys(DECISION_LABEL).sort()).toEqual([...ALL_BANDS].sort())
  })

  it('all six labels are different sentences once every style is stripped', () => {
    const labels = ALL_BANDS.map((band) => stripped(DECISION_LABEL[band].label))
    expect(new Set(labels).size).toBe(ALL_BANDS.length)
  })

  it('the FOUR proceed bands are different sentences once every style is stripped', () => {
    const labels = PROCEED_BANDS.map((band) => stripped(DECISION_LABEL[band].label))
    expect(new Set(labels).size).toBe(PROCEED_BANDS.length)
  })

  it('their explanations are distinct too, so a caption cannot re-merge them', () => {
    const meanings = PROCEED_BANDS.map((band) => stripped(DECISION_LABEL[band].meaning))
    expect(new Set(meanings).size).toBe(PROCEED_BANDS.length)
  })

  it('the not-asked bands SAY they were not checked, rather than merely differing', () => {
    // The told-yes-versus-not-asked line, stated positively. Four distinct
    // strings all beginning "Allowed" would satisfy distinctness and would be
    // exactly the failure this file exists against.
    expect(stripped(DECISION_LABEL.allowed_no_budget_governs.label)).toContain('not checked')
    expect(stripped(DECISION_LABEL.allowed_without_answer.label)).toContain('not checked')
    expect(stripped(DECISION_LABEL.allowed_breaker_armed.label)).toContain('checked')
    expect(stripped(DECISION_LABEL.allowed_breaker_armed.label)).not.toContain('not checked')
    expect(stripped(DECISION_LABEL.allowed_within_grace.label)).toContain('degraded')
  })

  it('only ONE band claims headroom was established', () => {
    const claiming = ALL_BANDS.filter((band) => /headroom established/.test(stripped(DECISION_LABEL[band].label)))
    expect(claiming).toEqual(['allowed_breaker_armed'])
  })

  it('the postures do not flatten the four proceed bands onto one value', () => {
    // `answered` is reserved for the one band that means the check worked.
    expect(DECISION_LABEL.allowed_breaker_armed.posture).toBe('answered')
    for (const band of ['allowed_no_budget_governs', 'allowed_within_grace', 'allowed_without_answer'] as const) {
      expect(DECISION_LABEL[band].posture).not.toBe('answered')
    }
  })
})

describe('the three breaker states are likewise distinct as plain text', () => {
  it('covers exactly the three states', () => {
    expect(Object.keys(BREAKER_STATE_LABEL).sort()).toEqual(['armed', 'tripped', 'undetermined'])
  })

  it('reads as three different things with every style stripped', () => {
    const labels = (['tripped', 'armed', 'undetermined'] as const).map((s) =>
      stripped(BREAKER_STATE_LABEL[s].label),
    )
    expect(new Set(labels).size).toBe(3)
  })

  it('`undetermined` is not phrased as headroom, health, or an all-clear', () => {
    // The state a counter-backed budget sits in whenever it is below its limit
    // — the most common state in this deployment. If it reads as "fine", the
    // majority of the screen is a false reassurance.
    const text = stripped(
      `${BREAKER_STATE_LABEL.undetermined.label} ${BREAKER_STATE_LABEL.undetermined.meaning}`,
    )
    expect(text).not.toMatch(/\bhealthy\b|\bok\b|\ball clear\b|\bwithin budget\b|\bunder budget\b/)
    expect(text).toContain('not headroom')
  })

  it('only `armed` claims headroom', () => {
    expect(stripped(BREAKER_STATE_LABEL.armed.label)).toContain('headroom')
    expect(stripped(BREAKER_STATE_LABEL.tripped.label)).not.toContain('headroom')
  })
})

describe('the labels are reachable — each band is produced by a real snapshot', () => {
  // A vocabulary test that never runs the decision rule would pass against
  // labels for bands nothing can produce. These drive `decideBudget` with the
  // shared fixtures and check the band that comes back has a label.
  const DENY: BudgetUnavailablePolicy = { onUnavailable: 'deny' }
  const ALLOW: BudgetUnavailablePolicy = {
    onUnavailable: 'allow',
    acceptedRisk: 'unbounded spend while unreachable',
  }

  it('an armed snapshot yields the one band that means the check worked', () => {
    const decision = decideBudget({
      snapshot: snapshot({ states: [armed()] }),
      receivedAt: NOW,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('allowed_breaker_armed')
    expect(DECISION_LABEL[decision.decision].posture).toBe('answered')
  })

  it('a zero-budget snapshot yields its OWN band, never the armed one', () => {
    const decision = decideBudget({
      snapshot: unbudgetedSnapshot(),
      receivedAt: NOW,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('allowed_no_budget_governs')
    expect(stripped(DECISION_LABEL[decision.decision].label)).toContain('not checked')
  })

  it('no snapshot at all under `allow` yields the not-asked band, not the armed one', () => {
    const decision = decideBudget({
      snapshot: null,
      unavailableBecause: 'the server was unreachable',
      receivedAt: NOW,
      now: NOW,
      policy: ALLOW,
    })
    expect(decision.decision).toBe('allowed_without_answer')
    expect(stripped(DECISION_LABEL[decision.decision].label)).toContain('not checked')
  })

  it('an undetermined state is NOT rendered as headroom', () => {
    // The ADR-002 case, and the counter-backed case: an estimate that cannot
    // decide is adjudicated by the policy, never read as room.
    const decision = decideBudget({
      snapshot: snapshot({ states: [undetermined()] }),
      receivedAt: NOW,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('declined_no_answer')
    expect(DECISION_LABEL[decision.decision].posture).not.toBe('answered')
  })

  it('a tripped snapshot declines, and its label names the SDK rather than the agent', () => {
    const decision = decideBudget({
      snapshot: snapshot({ states: [tripped()] }),
      receivedAt: NOW,
      now: NOW,
      policy: DENY,
    })
    expect(decision.decision).toBe('declined_breaker_tripped')
    expect(stripped(DECISION_LABEL[decision.decision].label)).toContain('declined by the sdk')
  })
})
