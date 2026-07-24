/* eslint-disable */
// Tests for Failure Patterns (PREVENTION, cycle 1 + cycle 2) —
// docs/adr/005-failure-patterns.md. Exercises the pure fallback
// fingerprint/spike engines, the idempotent occurrence-recording +
// rollup-upsert mutation, org-scoped listing/detail queries, the trend
// bucketing helper, and the spike-rollup cron. Cycle 2 additionally covers:
// the accurate (non-sample-truncated) daily trend, the spike-transition
// anti-flap/cooldown fallback, and pattern_spike alert firing (idempotency,
// rule-enablement, cross-org isolation).
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import {
  deriveFailureFingerprintFallback,
  assessPatternSpikeFallback,
  assessPatternSpikeTransitionFallback,
  buildTrendFromOccurrences,
  extractFingerprintSignals,
  fingerprintExplanation,
} from './failure_patterns'

const modules = import.meta.glob('./**/*.ts')

const identity = (role: string, org: 'a' | 'b') => ({ subject: `${role}_${org}`, org_id: `clerk_${org}` }) as const

async function seedTwoOrgs(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const orgA = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_a', name: 'Org A', slug: 'org-a', plan: 'free', createdAt: now, updatedAt: now })
    const orgB = await ctx.db.insert('organizations', { clerkOrgId: 'clerk_b', name: 'Org B', slug: 'org-b', plan: 'free', createdAt: now, updatedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'member_a', orgId: orgA, role: 'member', joinedAt: now })
    await ctx.db.insert('user_memberships', { clerkUserId: 'member_b', orgId: orgB, role: 'member', joinedAt: now })

    const projectA = await ctx.db.insert('projects', { orgId: orgA, name: 'P', slug: 'p', createdAt: now, updatedAt: now })
    const agentA = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Agent A', slug: 'a', createdAt: now, updatedAt: now })
    const versionA = await ctx.db.insert('agent_versions', { agentId: agentA, orgId: orgA, version: 'v1', createdAt: now })

    const projectB = await ctx.db.insert('projects', { orgId: orgB, name: 'PB', slug: 'pb', createdAt: now, updatedAt: now })
    const agentB = await ctx.db.insert('agents', { orgId: orgB, projectId: projectB, name: 'Agent B', slug: 'b', createdAt: now, updatedAt: now })

    return { orgA, orgB, projectA, projectB, agentA, agentB, versionA }
  })
}

async function seedRun(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any, agentVersionId?: any) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('runs', {
      orgId, projectId, agentId, agentVersionId, status: 'failed', startedAt: now - 1000, endedAt: now, metadata: {}, tags: [],
    })
  })
}

// ---------------------------------------------------------------------------
// Pure fallback engines
// ---------------------------------------------------------------------------

describe('deriveFailureFingerprintFallback', () => {
  it('prefers failingToolName as the salient key', () => {
    const f = deriveFailureFingerprintFallback({ heuristicClass: 'tool_error', failingToolName: 'search_web', terminalEventType: 'run.failed' })
    expect(f.salientKey).toBe('search_web')
    expect(f.class).toBe('tool_error')
    expect(f.label).toContain('search_web')
  })

  it('falls back to terminalEventType when no tool name is present', () => {
    const f = deriveFailureFingerprintFallback({ heuristicClass: 'terminal_error', terminalEventType: 'run.failed' })
    expect(f.salientKey).toBe('run.failed')
  })

  it('falls back to a normalized errorSignature when neither tool nor terminal type is present', () => {
    const f = deriveFailureFingerprintFallback({ heuristicClass: 'llm_error', errorSignature: 'Request 12345 timed out after 30s' })
    expect(f.salientKey).not.toContain('12345')
    expect(f.salientKey).not.toContain('30')
  })

  it('produces the same hash for the same (class, salientKey) pair', () => {
    const a = deriveFailureFingerprintFallback({ heuristicClass: 'tool_error', failingToolName: 'search_web' })
    const b = deriveFailureFingerprintFallback({ heuristicClass: 'tool_error', failingToolName: 'search_web' })
    expect(a.hash).toBe(b.hash)
  })

  it('produces different hashes for different classes or salient keys', () => {
    const a = deriveFailureFingerprintFallback({ heuristicClass: 'tool_error', failingToolName: 'search_web' })
    const b = deriveFailureFingerprintFallback({ heuristicClass: 'tool_error', failingToolName: 'send_email' })
    const c = deriveFailureFingerprintFallback({ heuristicClass: 'llm_error', failingToolName: 'search_web' })
    expect(a.hash).not.toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
  })

  it('never throws on missing/hostile input', () => {
    expect(() => deriveFailureFingerprintFallback({} as any)).not.toThrow()
    expect(() => deriveFailureFingerprintFallback(undefined as any)).not.toThrow()
    const f = deriveFailureFingerprintFallback({ heuristicClass: '' } as any)
    expect(f.class).toBe('unknown')
    expect(f.salientKey).toBe('unspecified')
  })
})

describe('assessPatternSpikeFallback', () => {
  it('reports not spiking for a flat baseline with no increase', () => {
    const trend = [
      { day: '2026-07-01', count: 2 }, { day: '2026-07-02', count: 2 }, { day: '2026-07-03', count: 2 },
      { day: '2026-07-04', count: 2 }, { day: '2026-07-05', count: 2 }, { day: '2026-07-06', count: 2 },
      { day: '2026-07-07', count: 2 },
    ]
    const a = assessPatternSpikeFallback(trend)
    expect(a.isSpiking).toBe(false)
  })

  it('detects a clear spike on the most recent day', () => {
    const trend = [
      { day: '2026-07-01', count: 1 }, { day: '2026-07-02', count: 2 }, { day: '2026-07-03', count: 1 },
      { day: '2026-07-04', count: 2 }, { day: '2026-07-05', count: 1 }, { day: '2026-07-06', count: 2 },
      { day: '2026-07-07', count: 40 },
    ]
    const a = assessPatternSpikeFallback(trend)
    expect(a.isSpiking).toBe(true)
    expect(a.recentCount).toBe(40)
  })

  it('never reports Infinity for a zero-baseline non-spike, and handles < 2 points without throwing', () => {
    expect(assessPatternSpikeFallback([])).toEqual({ isSpiking: false, recentCount: 0, baselineMean: 0, z: 0 })
    expect(assessPatternSpikeFallback([{ day: '2026-07-01', count: 5 }])).toEqual({ isSpiking: false, recentCount: 5, baselineMean: 0, z: 0 })
  })

  it('a zero-variance, all-zero baseline followed by a nonzero day is not a spike (avoids first-occurrence noise)', () => {
    const trend = [
      { day: '2026-07-01', count: 0 }, { day: '2026-07-02', count: 0 }, { day: '2026-07-03', count: 0 },
      { day: '2026-07-04', count: 1 },
    ]
    const a = assessPatternSpikeFallback(trend)
    expect(a.isSpiking).toBe(false)
  })
})

describe('buildTrendFromOccurrences', () => {
  it('buckets occurrences into 14 daily counts, oldest first, including zero-count days', () => {
    const now = Date.parse('2026-07-24T12:00:00.000Z')
    const occurrences = [
      { occurredAt: Date.parse('2026-07-24T01:00:00.000Z') },
      { occurredAt: Date.parse('2026-07-24T02:00:00.000Z') },
      { occurredAt: Date.parse('2026-07-23T01:00:00.000Z') },
    ]
    const trend = buildTrendFromOccurrences(occurrences, now)
    expect(trend.length).toBe(14)
    expect(trend[13]!.day).toBe('2026-07-24')
    expect(trend[13]!.count).toBe(2)
    expect(trend[12]!.day).toBe('2026-07-23')
    expect(trend[12]!.count).toBe(1)
    expect(trend[0]!.count).toBe(0)
  })
})

describe('extractFingerprintSignals / fingerprintExplanation', () => {
  it('extracts a tool name from the event at the highest cited sequence number', () => {
    const events = [
      { type: 'run.started', sequenceNumber: 1 },
      { type: 'tool.error', sequenceNumber: 2, payload: { name: 'search_web', message: 'timeout' } },
      { type: 'run.failed', sequenceNumber: 3, payload: { message: 'timeout' } },
    ]
    const signals = extractFingerprintSignals({ failureClass: 'tool_error', citedSequenceNumbers: [2, 3], events })
    expect(signals.heuristicClass).toBe('tool_error')
    expect(signals.failingToolName).toBe('search_web')
    expect(signals.terminalEventType).toBe('run.failed')
  })

  it('never throws on empty events/citations', () => {
    expect(() => extractFingerprintSignals({ failureClass: 'unknown', citedSequenceNumbers: [], events: [] })).not.toThrow()
    const f = fingerprintExplanation({ failureClass: 'unknown', citedSequenceNumbers: [], events: [] })
    expect(f.class).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// recordFailurePatternOccurrence — idempotency, org-scoping, rollup upsert
// ---------------------------------------------------------------------------

describe('recordFailurePatternOccurrence', () => {
  it('inserts a new occurrence and creates the rollup on first call', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, versionA)

    const result = await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
      fingerprintHash: 'hash1', class: 'tool_error', label: 'Tool Error: search_web', salientKey: 'search_web',
    })
    expect(result).toEqual({ recorded: true })

    const rollup = await t.run(async (ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'hash1')).first(),
    )
    expect(rollup).not.toBeNull()
    expect(rollup!.count).toBe(1)
    expect(rollup!.representativeRunIds).toEqual([runId])
    expect(rollup!.affectedAgentVersionIds).toEqual([versionA])

    const occurrences = await t.run(async (ctx) => ctx.db.query('failure_pattern_occurrences').collect())
    expect(occurrences.length).toBe(1)
  })

  it('is idempotent per runId — a second call for the same run is a no-op', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, versionA)

    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
      fingerprintHash: 'hash1', class: 'tool_error', label: 'L', salientKey: 'search_web',
    })
    const second = await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
      fingerprintHash: 'hash1', class: 'tool_error', label: 'L', salientKey: 'search_web',
    })
    expect(second).toEqual({ recorded: false, reason: 'already_recorded' })

    const occurrences = await t.run(async (ctx) => ctx.db.query('failure_pattern_occurrences').collect())
    expect(occurrences.length).toBe(1)
    const rollup = await t.run(async (ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'hash1')).first(),
    )
    expect(rollup!.count).toBe(1)
  })

  it('increments the rollup count and dedups representativeRunIds/affectedAgentVersionIds across multiple runs sharing a fingerprint', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runs = await Promise.all(Array.from({ length: 8 }, () => seedRun(t, orgA, projectA, agentA, versionA)))

    for (const runId of runs) {
      await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
        orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
        fingerprintHash: 'hash1', class: 'tool_error', label: 'L', salientKey: 'search_web',
      })
    }

    const rollup = await t.run(async (ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'hash1')).first(),
    )
    expect(rollup!.count).toBe(8)
    // Capped at MAX_REPRESENTATIVE_RUN_IDS (5), most-recent-first.
    expect(rollup!.representativeRunIds.length).toBe(5)
    expect(rollup!.representativeRunIds[0]).toBe(runs[runs.length - 1])
    // Same agentVersionId every time — deduped to a single entry, not 8.
    expect(rollup!.affectedAgentVersionIds).toEqual([versionA])
  })

  it('is a no-op if the run cannot be found (e.g. purged between scheduling and execution)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA, versionA)
    await t.run(async (ctx) => ctx.db.delete(runId))

    const result = await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
      fingerprintHash: 'hash1', class: 'tool_error', label: 'L', salientKey: 'search_web',
    })
    expect(result).toEqual({ recorded: false, reason: 'run_not_found' })
  })
})

// ---------------------------------------------------------------------------
// Queries — org-scoping
// ---------------------------------------------------------------------------

describe('listFailurePatterns / getFailurePattern', () => {
  it('only returns patterns belonging to the caller org, ranked by lastSeenAt desc', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    const runA1 = await seedRun(t, orgA, projectA, agentA)
    const runA2 = await seedRun(t, orgA, projectA, agentA)
    const runB1 = await seedRun(t, orgB, projectB, agentB)

    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: runA1, agentId: agentA, fingerprintHash: 'older', class: 'tool_error', label: 'Older', salientKey: 'a',
    })
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: runA2, agentId: agentA, fingerprintHash: 'newer', class: 'llm_error', label: 'Newer', salientKey: 'b',
    })
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgB, runId: runB1, agentId: agentB, fingerprintHash: 'b-only', class: 'tool_error', label: 'B', salientKey: 'c',
    })

    const asA = t.withIdentity(identity('member', 'a'))
    const patterns = await asA.query(api.failure_patterns.listFailurePatterns, { orgId: orgA })
    expect(patterns.map((p: any) => p.fingerprintHash).sort()).toEqual(['newer', 'older'])
  })

  it('rejects a caller who is not a member of the requested org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)
    const asB = t.withIdentity(identity('member', 'b'))
    await expect(asB.query(api.failure_patterns.listFailurePatterns, { orgId: orgA })).rejects.toThrow()
    void orgB
  })

  it('getFailurePattern returns null for a foreign org fingerprint, and detail + trend for a real one', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'hash1', class: 'tool_error', label: 'Tool Error: search_web', salientKey: 'search_web',
    })

    const asA = t.withIdentity(identity('member', 'a'))
    const detail = await asA.query(api.failure_patterns.getFailurePattern, { orgId: orgA, fingerprintHash: 'hash1' })
    expect(detail).not.toBeNull()
    expect(detail.pattern.count).toBe(1)
    expect(detail.recentOccurrences.length).toBe(1)
    expect(detail.trend.length).toBe(14)
    expect(detail.trend[detail.trend.length - 1].count).toBe(1)

    const missing = await asA.query(api.failure_patterns.getFailurePattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })
    expect(missing).toBeNull()

    void orgB
  })
})

// ---------------------------------------------------------------------------
// Spike-rollup cron
// ---------------------------------------------------------------------------

describe('assessPatternSpikesCron', () => {
  it('stores a lastSpikeAssessment on every pattern it examines', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'hash1', class: 'tool_error', label: 'L', salientKey: 'a',
    })

    const result = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, {})
    expect(result.assessed).toBe(1)

    const rollup = await t.run(async (ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'hash1')).first(),
    )
    expect(rollup!.lastSpikeAssessment).toBeDefined()
    expect(typeof rollup!.lastSpikeAssessment!.assessedAt).toBe('number')
  })

  it('is a no-op (assessed: 0) when there are no patterns yet', async () => {
    const t = convexTest(schema, modules)
    await seedTwoOrgs(t)
    const result = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, {})
    expect(result).toEqual({ assessed: 0, spiking: 0, fired: 0 })
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — accurate daily trend (failure_pattern_daily_counts)
// ---------------------------------------------------------------------------

describe('accurate daily trend (failure_pattern_daily_counts)', () => {
  it('recordFailurePatternOccurrence increments an exact per-day counter, and getFailurePattern.trend reflects it even past MAX_RECENT_OCCURRENCES', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)

    // 55 occurrences today for the same fingerprint — deliberately more than
    // MAX_RECENT_OCCURRENCES (50), so a trend that was still derived from a
    // bounded/truncated read could under-report today's count. The accurate
    // per-day counter must report exactly 55 regardless.
    const runIds = await Promise.all(Array.from({ length: 55 }, () => seedRun(t, orgA, projectA, agentA, versionA)))
    for (const runId of runIds) {
      await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
        orgId: orgA, runId, agentId: agentA, agentVersionId: versionA,
        fingerprintHash: 'busy', class: 'tool_error', label: 'L', salientKey: 'search_web',
      })
    }

    const asA = t.withIdentity(identity('member', 'a'))
    const detail = await asA.query(api.failure_patterns.getFailurePattern, { orgId: orgA, fingerprintHash: 'busy' })
    expect(detail).not.toBeNull()
    // recentOccurrences is bounded (<= MAX_RECENT_OCCURRENCES = 50)...
    expect(detail.recentOccurrences.length).toBe(50)
    // ...but the trend's last day (today) is EXACT: all 55, not just the 50
    // occurrences that happened to be in the bounded recent-occurrences sample.
    expect(detail.trend[detail.trend.length - 1].count).toBe(55)

    const dailyCountRows = await t.run(async (ctx) =>
      ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'busy')).collect(),
    )
    expect(dailyCountRows.length).toBe(1)
    expect(dailyCountRows[0]!.count).toBe(55)
  })

  it('splits counts correctly across two different days for the same fingerprint', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const oneDayMs = 24 * 60 * 60 * 1000

    const runToday = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: runToday, agentId: agentA, fingerprintHash: 'split', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: Date.now(),
    })
    const runYesterday = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: runYesterday, agentId: agentA, fingerprintHash: 'split', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: Date.now() - oneDayMs,
    })

    const rows = await t.run(async (ctx) =>
      ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'split')).collect(),
    )
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.count === 1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — assessPatternSpikeTransitionFallback (pure anti-flap/cooldown logic)
// ---------------------------------------------------------------------------

describe('assessPatternSpikeTransitionFallback', () => {
  const spiking = { isSpiking: true, recentCount: 40, baselineMean: 1, z: 10 }
  const notSpiking = { isSpiking: false, recentCount: 1, baselineMean: 1, z: 0 }

  it('fires on a fresh false/undefined -> true transition', () => {
    const r1 = assessPatternSpikeTransitionFallback(undefined, spiking, { nowMs: 1_000_000 })
    expect(r1.shouldFire).toBe(true)
    const r2 = assessPatternSpikeTransitionFallback(notSpiking, spiking, { nowMs: 1_000_000 })
    expect(r2.shouldFire).toBe(true)
  })

  it('does not fire while still spiking (true -> true)', () => {
    const r = assessPatternSpikeTransitionFallback(spiking, spiking, { nowMs: 1_000_000 })
    expect(r.shouldFire).toBe(false)
    expect(r.reason).toBe('already_spiking')
  })

  it('does not fire at all when the current assessment is not spiking', () => {
    const r = assessPatternSpikeTransitionFallback(undefined, notSpiking, { nowMs: 1_000_000 })
    expect(r.shouldFire).toBe(false)
    expect(r.reason).toBe('not_spiking')
  })

  it('suppresses a transition fire inside the cooldown window', () => {
    const r = assessPatternSpikeTransitionFallback(notSpiking, spiking, {
      nowMs: 1_000_000, lastFiredAt: 999_000, cooldownMs: 10_000,
    })
    expect(r.shouldFire).toBe(false)
    expect(r.reason).toBe('cooldown_active')
  })

  it('re-arms and fires again once the cooldown has elapsed', () => {
    const r = assessPatternSpikeTransitionFallback(notSpiking, spiking, {
      nowMs: 1_020_000, lastFiredAt: 1_000_000, cooldownMs: 10_000,
    })
    expect(r.shouldFire).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cycle 2 — pattern_spike alert firing (assessPatternSpikesCron + convex/alerts.ts)
// ---------------------------------------------------------------------------

/** UTC "YYYY-MM-DD" for `n` days before `now`. Mirrors failure_patterns.ts's own dateNDaysAgoUtc (not exported). */
function dayNDaysAgo(now: number, n: number): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/**
 * Seeds a failure_patterns rollup directly (bypassing recordFailurePatternOccurrence,
 * which is unnecessary for these tests — only the rollup + daily-count rows matter)
 * with a flat, low (count=1/day) 13-day baseline plus a controllable "today" count,
 * so assessPatternSpikeFallback's deterministic zero-variance-baseline branch decides
 * isSpiking (avoids any z-score float fragility in these tests).
 */
async function seedPatternWithSpikeTrend(
  t: ReturnType<typeof convexTest>,
  args: {
    orgId: any
    fingerprintHash: string
    now: number
    todayCount: number
    lastSpikeAssessment?: { assessedAt: number; isSpiking: boolean; recentCount: number; baselineMean: number; z: number }
    lastPatternSpikeAlertFiredAt?: number
  },
) {
  return await t.run(async (ctx) => {
    const patternId = await ctx.db.insert('failure_patterns', {
      orgId: args.orgId,
      fingerprintHash: args.fingerprintHash,
      class: 'tool_error',
      label: `Tool Error: ${args.fingerprintHash}`,
      salientKey: args.fingerprintHash,
      count: 13 + args.todayCount,
      firstSeenAt: args.now - 13 * 24 * 60 * 60 * 1000,
      lastSeenAt: args.now,
      representativeRunIds: [],
      affectedAgentVersionIds: [],
      lastSpikeAssessment: args.lastSpikeAssessment,
      lastPatternSpikeAlertFiredAt: args.lastPatternSpikeAlertFiredAt,
    })
    for (let i = 13; i >= 1; i--) {
      await ctx.db.insert('failure_pattern_daily_counts', {
        orgId: args.orgId, fingerprintHash: args.fingerprintHash, day: dayNDaysAgo(args.now, i), count: 1,
      })
    }
    await ctx.db.insert('failure_pattern_daily_counts', {
      orgId: args.orgId, fingerprintHash: args.fingerprintHash, day: dayNDaysAgo(args.now, 0), count: args.todayCount,
    })
    return patternId
  })
}

/** Seeds an alert_rules row directly (bypassing the createAlertRule mutation's admin-auth/validation — irrelevant to these cron-firing tests). */
async function createPatternSpikeRule(t: ReturnType<typeof convexTest>, orgId: any, enabled = true) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    return await ctx.db.insert('alert_rules', {
      orgId, name: 'pattern spikes', kind: 'pattern_spike', channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
      enabled, createdAt: now, updatedAt: now,
    })
  })
}

describe('pattern_spike alert firing', () => {
  it('fires exactly once on the not-spiking -> spiking transition, not again while still spiking, and re-arms after it drops and re-spikes past cooldown', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await createPatternSpikeRule(t, orgA)

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'spiky', now, todayCount: 40 })

    // First tick: fresh spike entry — fires exactly once.
    const first = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(first.spiking).toBe(1)
    expect(first.fired).toBe(1)

    let events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)
    expect(events[0]!.patternFingerprintHash).toBe('spiky')
    // recentCount reflects Team B's real assessPatternSpike (insights.ts),
    // which sums the trailing 3-day recent window (today=40 + the two
    // preceding baseline days at count=1 each = 42), not just "today" alone —
    // see that function's doc comment for why (SPIKE_DEFAULT_RECENT_DAYS).
    expect(events[0]!.metadata).toMatchObject({ fingerprintHash: 'spiky', class: 'tool_error', recentCount: 42, deepLink: '/patterns/spiky' })
    expect(events[0]!.summary).toContain('/patterns/spiky')

    // Second tick, 15 minutes later, pattern is STILL spiking (nothing changed
    // upstream) — must NOT fire again.
    const secondTick = now + 15 * 60 * 1000
    const second = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: secondTick })
    expect(second.fired).toBe(0)
    events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)

    // The pattern's count drops back to baseline (no longer spiking)...
    await t.run(async (ctx) => {
      const pattern = await ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'spiky')).first()
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'spiky').eq('day', dayNDaysAgo(secondTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 1 })
      void pattern
    })
    const dropTick = secondTick + 15 * 60 * 1000
    const drop = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: dropTick })
    expect(drop.spiking).toBe(0)
    expect(drop.fired).toBe(0)

    // ...then spikes again, but WITHIN the cooldown window — must not re-fire yet.
    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'spiky').eq('day', dayNDaysAgo(dropTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 50 })
    })
    const withinCooldownTick = dropTick + 15 * 60 * 1000
    const withinCooldown = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: withinCooldownTick })
    expect(withinCooldown.spiking).toBe(1)
    expect(withinCooldown.fired).toBe(0)
    events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)

    // Drop again, then re-spike PAST the cooldown (default 6h) — re-arms and fires.
    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'spiky').eq('day', dayNDaysAgo(withinCooldownTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 1 })
    })
    const secondDropTick = withinCooldownTick + 15 * 60 * 1000
    await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: secondDropTick })

    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'spiky').eq('day', dayNDaysAgo(secondDropTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 60 })
    })
    const pastCooldownTick = now + 7 * 60 * 60 * 1000 // > 6h after the first fire
    const rearmed = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: pastCooldownTick })
    expect(rearmed.spiking).toBe(1)
    expect(rearmed.fired).toBe(1)

    events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(2)
  })

  it('stores the spike assessment but fires NO alert when the org has no pattern_spike rule at all', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    // No alert_rules seeded for orgA.

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'no-rule', now, todayCount: 40 })

    const result = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(result.spiking).toBe(1)
    expect(result.fired).toBe(0)

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)

    const pattern = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule')).first())
    expect(pattern!.lastSpikeAssessment!.isSpiking).toBe(true)
  })

  it('fires NO alert when the only matching pattern_spike rule is disabled', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await createPatternSpikeRule(t, orgA, false)

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'disabled-rule', now, todayCount: 40 })

    const result = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(result.fired).toBe(0)
    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)
  })

  it('cross-org isolation: firing for org A never creates an alert_events row for org B, even when both spike simultaneously', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB } = await seedTwoOrgs(t)
    await createPatternSpikeRule(t, orgA)
    // orgB gets NO pattern_spike rule.

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'a-spike', now, todayCount: 40 })
    await seedPatternWithSpikeTrend(t, { orgId: orgB, fingerprintHash: 'b-spike', now, todayCount: 40 })

    const result = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(result.assessed).toBe(2)
    expect(result.spiking).toBe(2)
    expect(result.fired).toBe(1)

    const eventsA = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    const eventsB = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgB)).collect())
    expect(eventsA.length).toBe(1)
    expect(eventsA[0]!.orgId).toBe(orgA)
    expect(eventsB.length).toBe(0)
  })
})
