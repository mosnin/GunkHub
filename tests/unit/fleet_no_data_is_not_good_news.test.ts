/**
 * "NO DATA" MUST NOT RENDER AS GOOD NEWS.
 *
 * ---------------------------------------------------------------------------
 * ONE RULE, THREE PLACES IT HAS NOW BEEN NEEDED
 * ---------------------------------------------------------------------------
 *
 *   AN UNMEASURED QUANTITY IS NOT A MEASURED EXTREME.
 *
 * It first appeared as `FleetShareMeasurement.unaffectedSharing: number | null`
 * — `null` ("we did not measure the healthy agents") is a different fact from
 * `0` ("we measured, and none of them share it"), and `0` is the strongest
 * support a hypothesis can have while `null` is none at all.
 *
 * It generalises, and the generalisation is worth stating because the same
 * shape keeps producing defects in unrelated code:
 *
 *   1. `summarizeResolutionHealth([])` scored **100 — perfect health**. An org
 *      whose pattern ingestion is silently BROKEN presents identically to an
 *      org with nothing wrong, and the broken one is the case you would most
 *      want the number to shout about.
 *
 *   2. `affectedAgentIds` saturating at its cap read as an exact count. A
 *      capped "20" is indistinguishable from a real 20 — and it undercounts
 *      PRECISELY ON THE WIDEST-SPREADING FAILURES, so the more agents a
 *      failure reaches the more confidently the blast radius understates it.
 *
 *   3. The fleet scan's `agentsAssessed > 0` clause, for the same reason a
 *      level up: a sweep that examined nothing is not a healthy fleet.
 *
 * THE COMMON FAILURE IS AN EMPTY INPUT, and empty inputs are the ones nobody
 * writes a test for while being what ordinary operation produces most often —
 * a new org, a quiet weekend, a retention window that just aged out, a broken
 * ingest. So they get tested here, explicitly, as the primary case.
 */
import {
  MAX_AFFECTED_AGENT_IDS,
  affectedAgentCountLabel,
  discriminationOf,
  healthScoreLabel,
  isFleetHealthScanComplete,
} from '@agent-flight-recorder/contracts'
import { describe, expect, it } from 'vitest'

import type {
  FailurePattern,
  FleetHealthScan,
  ResolutionHealthSummary,
} from '@agent-flight-recorder/contracts'

function pattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: 'fp_1',
    orgId: 'org_1',
    fingerprintHash: '9f3c',
    class: 'tool_error',
    label: 'search_web timed out',
    salientKey: 'search_web',
    count: 340,
    firstSeenAt: 1_721_000_000_000,
    lastSeenAt: 1_721_909_400_000,
    representativeRunIds: ['run_a'],
    affectedAgentVersionIds: ['ver_1'],
    ...overrides,
  }
}

describe('an org with no patterns has NO health score, not a perfect one', () => {
  it('the type admits `null`, so "no data" cannot be formatted as a percentage by accident', () => {
    // The point is not that `null` is a nicer value — it is that a consumer
    // CANNOT render it as a number without deciding what to do about it.
    // Every numeric candidate fails in a direction: 0 reads as catastrophe and
    // would page someone over an empty org, 100 reads as perfect (the bug),
    // and a sentinel like -1 is the same failure with an extra step.
    const empty: ResolutionHealthSummary = {
      total: 0,
      open: 0,
      acknowledged: 0,
      resolved: 0,
      regressed: 0,
      regressionRate: 0,
      avgTimeToResolutionMs: null,
      medianTimeToResolutionMs: null,
      healthScore: null,
      confirmedResolutions: 0,
      provingResolutions: 0,
      unprovenResolutions: 0,
      resolutionsWithoutEvidence: 0,
      confirmationRate: 0,
      provenHealthScore: null,
    }
    expect(empty.healthScore).toBeNull()
    expect(empty.provenHealthScore).toBeNull()
    expect(healthScoreLabel(empty.healthScore)).toBe('no data')
  })

  it('renders a real score as a number, so the null case is not achieved by making everything vague', () => {
    expect(healthScoreLabel(87)).toBe('87')
    expect(healthScoreLabel(0)).toBe('0')
    // The pair that matters: a genuine 0 (everything is broken) and no data
    // must not render alike.
    expect(healthScoreLabel(0)).not.toBe(healthScoreLabel(null))
  })

  it('a genuinely perfect org still scores 100 — `null` is for ABSENT data, not for caution', () => {
    // A guard that reports "no data" whenever it is unsure is a guard people
    // learn to ignore.
    expect(healthScoreLabel(100)).toBe('100')
  })
})

describe('a saturated blast radius says so', () => {
  it('renders a capped set as "20+", never as an exact 20', () => {
    const saturated = pattern({
      affectedAgentIds: Array.from({ length: MAX_AFFECTED_AGENT_IDS }, (_, i) => `ag_${i}`),
      affectedAgentIdsTruncated: true,
    })
    expect(affectedAgentCountLabel(saturated)).toBe('20+')
  })

  it('treats a set AT the cap as truncated even with the flag ABSENT', () => {
    // Deliberate conservatism: the flag is optional and missing on every row
    // written before it existed, so trusting its absence would render exactly
    // the pre-existing rows — the ones most likely to be wrong — as exact.
    const legacy = pattern({
      affectedAgentIds: Array.from({ length: MAX_AFFECTED_AGENT_IDS }, (_, i) => `ag_${i}`),
    })
    expect(legacy.affectedAgentIdsTruncated).toBeUndefined()
    expect(affectedAgentCountLabel(legacy)).toBe('20+')
  })

  it('renders an unsaturated set exactly — the marker does not make every number vague', () => {
    expect(affectedAgentCountLabel(pattern({ affectedAgentIds: ['ag_1', 'ag_2', 'ag_3'] }))).toBe('3')
    expect(affectedAgentCountLabel(pattern({ affectedAgentIds: [] }))).toBe('0')
    expect(affectedAgentCountLabel(pattern())).toBe('0')
  })

  it('honours an explicit truncation flag even below the cap', () => {
    // The producer knows things the length does not: a set can be short and
    // still be a floor if the write path dropped members for another reason.
    expect(
      affectedAgentCountLabel(pattern({ affectedAgentIds: ['ag_1'], affectedAgentIdsTruncated: true }))
    ).toBe('1+')
  })
})

describe('the same rule, already load-bearing in two other places', () => {
  const scan: FleetHealthScan = {
    since: 0,
    until: 1,
    burstWindowMs: 1,
    correlationBasis: 'whole_roster',
    agentsInRoster: 0,
    agentsAssessed: 0,
    agentsUnassessable: 0,
    agentsSkippedForBudget: 0,
    occurrencesScanned: 0,
    scanTruncated: false,
    baseRatesMeasured: true,
  }

  it('a fleet sweep that assessed nothing is not a healthy fleet', () => {
    expect(isFleetHealthScanComplete(scan)).toBe(false)
    expect(isFleetHealthScanComplete({ ...scan, agentsInRoster: 1, agentsAssessed: 1 })).toBe(true)
  })

  it('an unmeasured base rate is not a measured zero', () => {
    const measuredZero = {
      affectedSharing: 12,
      affectedTotal: 12,
      unaffectedSharing: 0,
      unaffectedTotal: 140,
      measurementTruncated: false,
    }
    expect(discriminationOf(measuredZero)).toBe('discriminating')
    expect(discriminationOf({ ...measuredZero, unaffectedSharing: null, unaffectedTotal: null })).toBe(
      'base_rate_unmeasured'
    )
  })
})
