/**
 * Mapping tests for services/failurePatterns.ts's cycle-2 resolution-evidence
 * surface (ADR-006 cycle 2 — "prove the fix held").
 *
 * These lock down the two things this layer can silently get wrong:
 *
 * 1. THE "ONLY EMIT WHEN PRESENT" DISCIPLINE. mapFailurePattern has always
 *    omitted absent optional keys rather than emitting `key: undefined`. That
 *    matters more in cycle 2 than it ever did: `resolvedAtRunCount: 0` and
 *    "no baseline was captured" are different claims about the evidence, and
 *    an explicit-undefined key also round-trips through JSON as a present-
 *    but-null field the UI would have to special-case.
 *
 * 2. THE STATE COMBINATIONS. `resolution`/`exposure` are null after a MANUAL
 *    reopen but NON-NULL after the regression guard's AUTO-reopen (which
 *    keeps `resolvedAt` so the "it didn't hold" evidence stays computable).
 *    `status === "open"` WITH a non-null exposure is valid and is the entire
 *    point of the feature — a mapper that keyed exposure off `status` would
 *    erase exactly the case the cycle was built for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(() => ({ userId: 'user_1', orgId: 'clerk_org_1' })),
}))

let queryResult: unknown = null
const queryMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => queryResult)
const mutationMock = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => null as unknown)

vi.mock('@/lib/convexServer', () => ({
  getAuthedClient: vi.fn(async () => ({ query: queryMock, mutation: mutationMock })),
  resolveConvexOrgId: vi.fn(async () => 'convex_org_1'),
  withConvexTimeout: vi.fn(async (p: Promise<unknown>) => p),
}))

vi.mock('@/lib/convexFunctions', () => ({
  convex: {
    failure_patterns: {
      resolvePattern: 'failure_patterns:resolvePattern',
      getPatternResolutionEvidence: 'failure_patterns:getPatternResolutionEvidence',
    },
  },
}))

import { getPatternResolutionEvidence } from '@/lib/services/failurePatterns'

/** A minimal rollup doc as Convex returns it (`_id`, no `id`). */
function patternDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'fp_1',
    orgId: 'org_1',
    fingerprintHash: 'abcd1234',
    class: 'tool_error',
    label: 'Tool call failed',
    salientKey: 'search',
    count: 12,
    firstSeenAt: 1_000,
    lastSeenAt: 2_000,
    representativeRunIds: ['run_1'],
    affectedAgentVersionIds: ['ver_1'],
    ...extra,
  }
}

beforeEach(() => {
  queryMock.mockClear()
  queryResult = null
})

describe('getPatternResolutionEvidence — tenancy', () => {
  it('returns null when Convex returns null (absent OR another org, indistinguishably)', async () => {
    queryResult = null
    expect(await getPatternResolutionEvidence('abcd1234')).toBeNull()
  })

  it('returns null when the payload has no pattern, rather than a half-built object', async () => {
    queryResult = { resolution: null, exposure: null, transitions: [] }
    expect(await getPatternResolutionEvidence('abcd1234')).toBeNull()
  })
})

describe('getPatternResolutionEvidence — never-resolved pattern', () => {
  it('maps a null resolution/exposure through as null, with no invented zero evidence', async () => {
    queryResult = { pattern: patternDoc(), resolution: null, exposure: null, transitions: [] }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.resolution).toBeNull()
    expect(result?.exposure).toBeNull()
    expect(result?.transitions).toEqual([])
  })

  it('omits every resolution-evidence key on an unresolved rollup', async () => {
    queryResult = { pattern: patternDoc(), resolution: null, exposure: null, transitions: [] }

    const pattern = (await getPatternResolutionEvidence('abcd1234'))!.pattern
    for (const key of [
      'status',
      'resolvedAt',
      'resolvedInVersionId',
      'resolvedAtRunCount',
      'resolvedAtOccurrenceCount',
      'affectedAgentIds',
    ]) {
      expect(Object.keys(pattern)).not.toContain(key)
    }
  })
})

describe('getPatternResolutionEvidence — resolved pattern', () => {
  it('maps every resolution metadata field through', async () => {
    queryResult = {
      pattern: patternDoc({
        status: 'resolved',
        resolvedAt: 5_000,
        resolvedInVersionId: 'ver_9',
        resolvedAtRunCount: 40,
        resolvedAtOccurrenceCount: 12,
        affectedAgentIds: ['agent_1', 'agent_2'],
      }),
      resolution: {
        resolvedAt: 5_000,
        resolvedByUserId: 'user_7',
        resolutionNote: 'Bumped the timeout',
        resolutionRef: 'PR-42',
        resolvedInVersionId: 'ver_9',
        resolvedInVersion: 'v1.4.2',
        resolvedAtOccurrenceCount: 12,
        resolvedAtRunCount: 40,
      },
      exposure: {
        since: 5_000,
        runCount: 220,
        runCountTruncated: false,
        recurrenceCount: 0,
        baselineRunCount: 40,
        agentIds: ['agent_1', 'agent_2'],
        heldSoFar: true,
      },
      transitions: [],
    }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.resolution).toEqual({
      resolvedAt: 5_000,
      resolvedByUserId: 'user_7',
      resolutionNote: 'Bumped the timeout',
      resolutionRef: 'PR-42',
      resolvedInVersionId: 'ver_9',
      resolvedInVersion: 'v1.4.2',
      resolvedAtOccurrenceCount: 12,
      resolvedAtRunCount: 40,
    })
    expect(result?.pattern.resolvedInVersionId).toBe('ver_9')
    expect(result?.pattern.affectedAgentIds).toEqual(['agent_1', 'agent_2'])
  })

  it('omits optional resolution keys that are absent, never emitting undefined', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: null,
      transitions: [],
    }

    const resolution = (await getPatternResolutionEvidence('abcd1234'))!.resolution!
    expect(resolution).toEqual({ resolvedAt: 5_000 })
    expect(Object.keys(resolution)).not.toContain('resolvedInVersionId')
    expect(Object.keys(resolution)).not.toContain('resolvedAtRunCount')
  })

  it('treats a resolution with no resolvedAt as no resolution at all', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: { resolvedByUserId: 'user_7' },
      exposure: null,
      transitions: [],
    }
    expect((await getPatternResolutionEvidence('abcd1234'))?.resolution).toBeNull()
  })
})

describe('exposure — the rulings that must not regress', () => {
  it('ZERO exposure maps through as zero: never smoothed, never dropped', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 0,
        runCountTruncated: false,
        recurrenceCount: 0,
        agentIds: [],
        heldSoFar: true,
      },
      transitions: [],
    }

    const exposure = (await getPatternResolutionEvidence('abcd1234'))!.exposure!
    // heldSoFar true with runCount 0 is "untested", NOT "the fix worked".
    // Both values must survive so the caller can tell those apart.
    expect(exposure.runCount).toBe(0)
    expect(exposure.heldSoFar).toBe(true)
  })

  it('defaults heldSoFar to FALSE when the backend did not say (never flatters an unproven fix)', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: { since: 5_000, runCount: 10, recurrenceCount: 0, agentIds: [] },
      transitions: [],
    }
    expect((await getPatternResolutionEvidence('abcd1234'))!.exposure!.heldSoFar).toBe(false)
  })

  it('preserves runCountTruncated so a floor is never presented as an exact total', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 2000,
        runCountTruncated: true,
        recurrenceCount: 0,
        agentIds: ['agent_1'],
        heldSoFar: true,
      },
      transitions: [],
    }
    const exposure = (await getPatternResolutionEvidence('abcd1234'))!.exposure!
    expect(exposure.runCountTruncated).toBe(true)
    expect(exposure.runCount).toBe(2000)
  })

  it('keeps baselineRunCount as a separate BEFORE window, never folded into runCount', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 220,
        runCountTruncated: false,
        recurrenceCount: 0,
        baselineRunCount: 40,
        agentIds: ['agent_1'],
        heldSoFar: true,
      },
      transitions: [],
    }

    const exposure = (await getPatternResolutionEvidence('abcd1234'))!.exposure!
    // baseline is a 14-day trailing window BEFORE resolution; runCount is
    // everything SINCE. Subtracting one from the other is meaningless, so
    // both must arrive intact and unmodified.
    expect(exposure.baselineRunCount).toBe(40)
    expect(exposure.runCount).toBe(220)
  })

  it('omits baselineRunCount entirely when it was never captured (pre-cycle-2 row)', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 5,
        runCountTruncated: false,
        recurrenceCount: 0,
        agentIds: [],
        heldSoFar: true,
      },
      transitions: [],
    }
    const exposure = (await getPatternResolutionEvidence('abcd1234'))!.exposure!
    expect(Object.keys(exposure)).not.toContain('baselineRunCount')
  })
})

describe('the auto-reopen combination: status "open" WITH live exposure', () => {
  /**
   * The regression guard auto-reopens a resolved pattern (status -> "open",
   * regressedAt set) but deliberately KEEPS resolvedAt, so the evidence that
   * the fix did not hold stays computable. Nothing in the mapper may key
   * resolution/exposure off `status`.
   */
  it('preserves resolution + exposure on an auto-reopened (regressed) pattern', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'open', resolvedAt: 5_000, regressedAt: 9_000, count: 15 }),
      resolution: { resolvedAt: 5_000, resolvedInVersionId: 'ver_9' },
      exposure: {
        since: 5_000,
        runCount: 300,
        runCountTruncated: false,
        recurrenceCount: 3,
        baselineRunCount: 40,
        agentIds: ['agent_1'],
        heldSoFar: false,
      },
      transitions: [],
    }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.pattern.status).toBe('open')
    expect(result?.pattern.regressedAt).toBe(9_000)
    expect(result?.resolution).not.toBeNull()
    expect(result?.exposure).not.toBeNull()
    expect(result?.exposure?.recurrenceCount).toBe(3)
    expect(result?.exposure?.heldSoFar).toBe(false)
  })

  it('maps a MANUAL reopen (resolvedAt cleared) to null resolution and exposure', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'open' }),
      resolution: null,
      exposure: null,
      transitions: [],
    }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.pattern.status).toBe('open')
    expect(result?.resolution).toBeNull()
    expect(result?.exposure).toBeNull()
  })
})

/** A full, well-formed verdict as Team B's engine produces it. */
function confidenceDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    score: 0.42,
    state: 'proving',
    exposureRuns: 21,
    observedRuns: 21,
    versionAttribution: 'matched',
    elapsedMs: 172_800_000,
    recurred: false,
    hasResolution: true,
    exposureMeasured: true,
    exposureCredit: 0.42,
    soakCredit: 0.66,
    limitingFactor: 'accumulating',
    ...extra,
  }
}

describe('fix confidence — the full verdict, not just the score', () => {
  it('maps every driver through unchanged', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: null,
      confidence: confidenceDoc(),
      transitions: [],
    }

    // Every field matters: the meter renders the drivers as inspectable
    // evidence, so a mapper that forwarded only `score` would hand the UI a
    // number nobody can check.
    expect((await getPatternResolutionEvidence('abcd1234'))!.confidence).toEqual({
      score: 0.42,
      state: 'proving',
      exposureRuns: 21,
      observedRuns: 21,
      versionAttribution: 'matched',
      elapsedMs: 172_800_000,
      recurred: false,
      hasResolution: true,
      exposureMeasured: true,
      exposureCredit: 0.42,
      soakCredit: 0.66,
      limitingFactor: 'accumulating',
    })
  })

  it('is null when there is no resolution to grade', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: null,
      exposure: null,
      confidence: null,
      transitions: [],
    }
    expect((await getPatternResolutionEvidence('abcd1234'))!.confidence).toBeNull()
  })

  it('passes the score through untouched — never re-derived or clamped web-side', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: null,
      confidence: confidenceDoc({ score: 0.9499, state: 'confirmed' }),
      transitions: [],
    }
    // The engine owns the math; a web-side "correction" would be a second,
    // silently-diverging implementation of it.
    expect((await getPatternResolutionEvidence('abcd1234'))!.confidence!.score).toBe(0.9499)
  })

  it('zero exposure grades as unproven with a zero score, never as success', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 0,
        runCountTruncated: false,
        recurrenceCount: 0,
        agentIds: [],
        heldSoFar: true,
      },
      confidence: confidenceDoc({
        score: 0,
        state: 'unproven',
        exposureRuns: 0,
        observedRuns: 0,
        exposureCredit: 0,
        limitingFactor: 'no-exposure',
      }),
      transitions: [],
    }

    const confidence = (await getPatternResolutionEvidence('abcd1234'))!.confidence!
    expect(confidence.state).toBe('unproven')
    expect(confidence.score).toBe(0)
    expect(confidence.limitingFactor).toBe('no-exposure')
  })

  it('survives an auto-reopen as a real regressed verdict with numbers behind it', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'open', resolvedAt: 5_000, regressedAt: 9_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 300,
        runCountTruncated: false,
        recurrenceCount: 3,
        agentIds: ['agent_1'],
        heldSoFar: false,
      },
      confidence: confidenceDoc({
        score: 0,
        state: 'regressed',
        recurred: true,
        observedRuns: 300,
        limitingFactor: 'recurrence',
      }),
      transitions: [],
    }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.pattern.status).toBe('open')
    expect(result?.confidence).not.toBeNull()
    expect(result?.confidence?.state).toBe('regressed')
    expect(result?.confidence?.score).toBe(0)
    expect(result?.confidence?.recurred).toBe(true)
    expect(result?.confidence?.observedRuns).toBe(300)
  })

  /**
   * RULING: `exposure.recurrenceCount` (Team A's crude count) and
   * `confidence.recurred` (the engine's verdict) can legitimately disagree
   * for a late-arriving occurrence dated BEFORE `resolvedAt` — that
   * occurrence is the one that prompted the fix, not a recurrence of it.
   * `recurred` is authoritative, so both values must survive the mapping
   * independently; nothing here may reconcile them.
   */
  it('keeps recurred authoritative and independent of recurrenceCount when they disagree', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: {
        since: 5_000,
        runCount: 100,
        runCountTruncated: false,
        // Crude count says "something came back"...
        recurrenceCount: 2,
        agentIds: ['agent_1'],
        heldSoFar: false,
      },
      // ...but the engine adjudicated it as pre-dating the resolution.
      confidence: confidenceDoc({ recurred: false, state: 'proving' }),
      transitions: [],
    }

    const result = await getPatternResolutionEvidence('abcd1234')
    expect(result?.exposure?.recurrenceCount).toBe(2)
    expect(result?.confidence?.recurred).toBe(false)
    expect(result?.confidence?.state).toBe('proving')
  })

  it('falls back pessimistically on an unrecognized state, never to a confident one', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: null,
      confidence: confidenceDoc({ state: 'totally-new-state', versionAttribution: 'weird' }),
      transitions: [],
    }

    const confidence = (await getPatternResolutionEvidence('abcd1234'))!.confidence!
    expect(confidence.state).toBe('unproven')
    expect(confidence.versionAttribution).toBe('unknown')
  })

  it('collapses non-finite numbers rather than leaking NaN into the UI', async () => {
    queryResult = {
      pattern: patternDoc({ status: 'resolved', resolvedAt: 5_000 }),
      resolution: { resolvedAt: 5_000 },
      exposure: null,
      confidence: confidenceDoc({ score: Number.NaN, exposureRuns: 'many', soakCredit: Infinity }),
      transitions: [],
    }

    const confidence = (await getPatternResolutionEvidence('abcd1234'))!.confidence!
    expect(confidence.score).toBe(0)
    expect(confidence.exposureRuns).toBe(0)
    expect(confidence.soakCredit).toBe(0)
  })

  it('treats a non-object confidence as absent', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: null,
      exposure: null,
      confidence: 'confirmed',
      transitions: [],
    }
    expect((await getPatternResolutionEvidence('abcd1234'))!.confidence).toBeNull()
  })
})

describe('lifecycle transitions', () => {
  it('preserves backend order (oldest-first) and does not re-sort', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: null,
      exposure: null,
      transitions: [
        { action: 'failure_pattern.acknowledged', actorClerkUserId: 'user_1', timestamp: 1 },
        { action: 'failure_pattern.resolved', actorClerkUserId: 'user_2', timestamp: 2 },
        { action: 'failure_pattern.regressed', actorClerkUserId: 'system', timestamp: 3 },
      ],
    }

    const transitions = (await getPatternResolutionEvidence('abcd1234'))!.transitions
    expect(transitions.map((t) => t.action)).toEqual([
      'failure_pattern.acknowledged',
      'failure_pattern.resolved',
      'failure_pattern.regressed',
    ])
    expect(transitions.map((t) => t.timestamp)).toEqual([1, 2, 3])
  })

  it('attributes an actor-less transition to "system", never to a human', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: null,
      exposure: null,
      transitions: [{ action: 'failure_pattern.regressed', timestamp: 3 }],
    }
    expect((await getPatternResolutionEvidence('abcd1234'))!.transitions[0]!.actorClerkUserId).toBe(
      'system'
    )
  })

  it('passes metadata through when present and omits the key when absent', async () => {
    queryResult = {
      pattern: patternDoc(),
      resolution: null,
      exposure: null,
      transitions: [
        { action: 'failure_pattern.resolved', actorClerkUserId: 'u1', timestamp: 2, metadata: { hasNote: true } },
        { action: 'failure_pattern.reopened', actorClerkUserId: 'u1', timestamp: 3 },
      ],
    }

    const transitions = (await getPatternResolutionEvidence('abcd1234'))!.transitions
    expect(transitions[0]!.metadata).toEqual({ hasNote: true })
    expect(Object.keys(transitions[1]!)).not.toContain('metadata')
  })

  it('tolerates a missing transitions array rather than throwing', async () => {
    queryResult = { pattern: patternDoc(), resolution: null, exposure: null }
    expect((await getPatternResolutionEvidence('abcd1234'))!.transitions).toEqual([])
  })
})
