/**
 * THE V1 ROUTE PRESERVES EVERY COMPLETENESS FIELD.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONE V1 SURFACE THAT MUST NOT RESHAPE ITS PAYLOAD
 * ---------------------------------------------------------------------------
 *
 * Every other v1 service maps, projects or normalises what Convex returns. A
 * `BreakerSnapshot` cannot be treated that way, because it is not a document —
 * it is an ANSWER, and the fields that say HOW MUCH OF AN ANSWER IT IS are
 * exactly the ones a reshaping layer drops first, since they look like
 * metadata:
 *
 *   scan.budgetsInScope / budgetsEvaluated   complete evaluation vs. partial one
 *   scan.evaluationTruncated                 every count above is a floor
 *   scan.subject                             proves the answer is about what was asked
 *   evaluatedAt / freshUntil                 the shelf life the client caps and honours
 *   each state's reason strings              why a decline can be explained at all
 *
 * Lose `scan` and an UNEVALUATED subject becomes indistinguishable from an
 * UNBUDGETED one — "no breakers found" reading as "no budget applies", which is
 * the reassuring direction. Lose a bound on a spend figure and an estimate
 * becomes a measurement.
 *
 * The tests below check the pass-through TWICE and the second check is the one
 * that matters: a deep-equal proves nothing was lost, and running the result
 * through contracts' own gate proves the surviving body is still ENFORCEABLE.
 * A projection could pass a shallow field check and still produce a body the
 * SDK refuses.
 */
import {
  breakerSnapshotRefusals,
  isBreakerSnapshotComplete,
  type BreakerSnapshot,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'


import { armed, NOW, snapshot, tripped, undetermined } from './budget_fixtures'

import { budgetSnapshotEnvelope } from '@/lib/services/api_v1_budgets'


/** A snapshot carrying one of every state, so no band's fields go unchecked. */
function richSnapshot(): BreakerSnapshot {
  return snapshot({
    states: [armed(), tripped(), undetermined()],
    scan: {
      subject: { orgId: 'org_1', agentId: 'agent_1', runId: 'run_1' },
      budgetsInScope: 3,
      budgetsEvaluated: 3,
      evaluationTruncated: false,
    },
  })
}

describe('budgetSnapshotEnvelope forwards the snapshot byte for byte', () => {
  it('is deep-equal to what it was given', () => {
    const original = richSnapshot()
    const { snapshot: forwarded } = budgetSnapshotEnvelope(original)
    expect(forwarded).toEqual(original)
  })

  it('is the SAME object, not a reconstruction', () => {
    // A structural equal would still pass against a hand-rebuilt copy that
    // happens to list every field TODAY — and would then silently start
    // dropping the next field somebody adds to `BreakerScan`. Identity is the
    // property that survives the schema growing.
    const original = richSnapshot()
    expect(budgetSnapshotEnvelope(original).snapshot).toBe(original)
  })

  it('preserves every named completeness field', () => {
    // Stated explicitly as well as structurally, so a failure names the field
    // rather than printing two large objects.
    const original = richSnapshot()
    const { snapshot: forwarded } = budgetSnapshotEnvelope(original)
    expect(forwarded.evaluatedAt).toBe(original.evaluatedAt)
    expect(forwarded.freshUntil).toBe(original.freshUntil)
    expect(forwarded.scan.budgetsInScope).toBe(original.scan.budgetsInScope)
    expect(forwarded.scan.budgetsEvaluated).toBe(original.scan.budgetsEvaluated)
    expect(forwarded.scan.evaluationTruncated).toBe(original.scan.evaluationTruncated)
    expect(forwarded.scan.subject).toEqual(original.scan.subject)
    expect(forwarded.states).toHaveLength(original.states.length)
  })

  it('preserves each state band’s own reason strings and evidence', () => {
    const original = richSnapshot()
    const { snapshot: forwarded } = budgetSnapshotEnvelope(original)
    for (const [index, state] of forwarded.states.entries()) {
      const source = original.states[index]
      expect(state).toEqual(source)
      if (state.state === 'tripped') {
        expect(state.trippedBecause.length).toBeGreaterThan(0)
        expect(state.determinedFrom.length).toBeGreaterThan(0)
      }
      if (state.state === 'armed') {
        expect(state.establishedUnderBy.length).toBeGreaterThan(0)
      }
      if (state.state === 'undetermined') {
        expect(state.undeterminedBecause.length).toBeGreaterThan(0)
        expect(state.wouldBeDeterminedBy.length).toBeGreaterThan(0)
      }
    }
  })

  it('the forwarded body is still ENFORCEABLE by the contract’s own gate', () => {
    // The check that a field-by-field comparison cannot make. A body can retain
    // every listed key and still fail `breakerSnapshotRefusals` — for instance
    // if a bound were normalised from `null` to `0`, which is the collapse that
    // manufactures headroom.
    const complete = snapshot({ states: [armed()] })
    const { snapshot: forwarded } = budgetSnapshotEnvelope(complete)
    expect(breakerSnapshotRefusals(forwarded)).toEqual([])
    expect(isBreakerSnapshotComplete(forwarded)).toBe(true)
  })

  it('does not launder a snapshot the gate would refuse', () => {
    // The complement, and it is as important as the preservation itself. This
    // layer must not be a place where a bad body becomes a good one — the SDK's
    // own gate is the one that decides, and it must see what actually arrived.
    const contradictory = snapshot({
      states: [armed()],
      scan: {
        subject: { orgId: 'org_1' },
        budgetsInScope: 4,
        budgetsEvaluated: 1,
        evaluationTruncated: true,
      },
    })
    const { snapshot: forwarded } = budgetSnapshotEnvelope(contradictory)
    expect(isBreakerSnapshotComplete(forwarded)).toBe(false)
    expect(forwarded.scan.evaluationTruncated).toBe(true)
  })

  it('forwards a stale answer as stale rather than refreshing it', () => {
    // `evaluatedAt` and `freshUntil` are the server's own statements and this
    // layer has no business restating them from its own clock — a shelf life
    // rewritten in transit is a bypass with a friendly face.
    const stale = snapshot({ evaluatedAt: NOW - 600_000, freshUntil: NOW - 500_000 })
    const { snapshot: forwarded } = budgetSnapshotEnvelope(stale)
    expect(forwarded.evaluatedAt).toBe(NOW - 600_000)
    expect(forwarded.freshUntil).toBe(NOW - 500_000)
  })
})
