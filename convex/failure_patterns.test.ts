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

  it('AUDIT FIX (cycle 3): does not advance the cooldown clock when no enabled pattern_spike rule exists, so the first rule added later still catches the ongoing spike', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    // No alert_rules seeded for orgA yet.

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'no-rule-yet', now, todayCount: 40 })

    const first = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(first.spiking).toBe(1)
    expect(first.fired).toBe(0)

    let pattern = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-yet')).first())
    // The cooldown clock must NOT have advanced: no rule existed, so no fire
    // was genuinely attempted, even though the pure transition said fire.
    expect(pattern!.lastPatternSpikeAlertFiredAt).toBeUndefined()

    // An admin adds a pattern_spike rule shortly after (well within what
    // would have been a stale 6h cooldown had it wrongly started above)...
    await createPatternSpikeRule(t, orgA)
    const secondTick = now + 30 * 60 * 1000 // 30 minutes later
    const second = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: secondTick })
    // The pattern is STILL spiking (nothing dropped/re-triggered) — the
    // transition itself is "already_spiking" (not a fresh rising edge), so
    // this correctly does not fire again for THIS reason. Prove the more
    // important thing instead: a genuinely fresh rising edge after the rule
    // exists is not blocked by a stale cooldown that never should have
    // started.
    expect(second.fired).toBe(0)
    pattern = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-yet')).first())
    expect(pattern!.lastPatternSpikeAlertFiredAt).toBeUndefined()

    // Drop back to baseline, then re-spike — a genuine fresh rising edge,
    // immediately after the rule was added. With the fix, nothing suppresses
    // this (no stale cooldown); with the bug, `first`'s attempted-but-ruleless
    // fire would have started a 6h cooldown that still had ~5.5h left here.
    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-yet').eq('day', dayNDaysAgo(secondTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 1 })
    })
    const dropTick = secondTick + 15 * 60 * 1000
    const drop = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: dropTick })
    expect(drop.spiking).toBe(0)

    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-yet').eq('day', dayNDaysAgo(dropTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 40 })
    })
    const respikeTick = dropTick + 15 * 60 * 1000
    const respike = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: respikeTick })
    expect(respike.spiking).toBe(1)
    expect(respike.fired).toBe(1) // not suppressed by a stale, never-should-have-started cooldown

    pattern = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-yet')).first())
    expect(pattern!.lastPatternSpikeAlertFiredAt).toBe(respikeTick)
  })
})

// ---------------------------------------------------------------------------
// Cycle 3 — mutePattern / unmutePattern
// ---------------------------------------------------------------------------

describe('mutePattern / unmutePattern', () => {
  it('admin can mute, which sets muted/mutedAt and records an audit event; member/viewer cannot', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'mute-me', class: 'tool_error', label: 'L', salientKey: 'a',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: Date.now() })
    })

    const asMember = t.withIdentity(identity('member', 'a'))
    await expect(asMember.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'mute-me' })).rejects.toThrow()

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const muted = await asAdmin.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'mute-me' })
    expect(muted.muted).toBe(true)
    expect(typeof muted.mutedAt).toBe('number')

    const auditRows = await t.run((ctx) => ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    const muteRows = auditRows.filter((r) => r.action === 'failure_pattern.muted' && r.targetId === 'mute-me')
    expect(muteRows.length).toBe(1)

    const unmuted = await asAdmin.mutation(api.failure_patterns.unmutePattern, { orgId: orgA, fingerprintHash: 'mute-me' })
    expect(unmuted.muted).toBe(false)
    // mutedAt is a "last muted at" historical marker — not cleared on unmute.
    expect(typeof unmuted.mutedAt).toBe('number')

    const auditRows2 = await t.run((ctx) => ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    const unmuteRows = auditRows2.filter((r) => r.action === 'failure_pattern.unmuted' && r.targetId === 'mute-me')
    expect(unmuteRows.length).toBe(1)
  })

  it('mutating an unknown fingerprint returns null, not a thrown error (same "not found for this org" posture as getFailurePattern)', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: Date.now() })
    })
    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const muteResult = await asAdmin.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })
    expect(muteResult).toBeNull()
    const unmuteResult = await asAdmin.mutation(api.failure_patterns.unmutePattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })
    expect(unmuteResult).toBeNull()
  })

  it('cross-org isolation: an admin in org A cannot mute a pattern that only exists in org B (returns null, not a leak)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    const runB = await seedRun(t, orgB, projectB, agentB)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgB, runId: runB, agentId: agentB, fingerprintHash: 'org-b-only', class: 'tool_error', label: 'L', salientKey: 'a',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: Date.now() })
    })
    const asAdminA = t.withIdentity(identity('admin', 'a'))
    const result = await asAdminA.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'org-b-only' })
    expect(result).toBeNull()

    const orgBPattern = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgB).eq('fingerprintHash', 'org-b-only')).first())
    expect(orgBPattern!.muted).toBeUndefined() // untouched
  })

  it('REAL SUPPRESSION: a muted pattern spiking fires NO alert_event, and unmuting + a fresh rising edge re-enables firing', async () => {
    const t = convexTest(schema, modules)
    const { orgA } = await seedTwoOrgs(t)
    await createPatternSpikeRule(t, orgA)
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: Date.now() })
    })

    const now = Date.parse('2026-07-24T12:00:00.000Z')
    await seedPatternWithSpikeTrend(t, { orgId: orgA, fingerprintHash: 'muted-spike', now, todayCount: 40 })

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    const muted = await asAdmin.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'muted-spike' })
    expect(muted.muted).toBe(true)

    // A fresh rising edge occurs while muted — assessment is computed/stored
    // (observability unaffected), but no alert fires.
    const firstTick = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now })
    expect(firstTick.spiking).toBe(1)
    expect(firstTick.fired).toBe(0)

    let events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)

    const patternAfterMutedSpike = await t.run((ctx) => ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'muted-spike')).first())
    expect(patternAfterMutedSpike!.lastSpikeAssessment!.isSpiking).toBe(true) // still computed/stored
    expect(patternAfterMutedSpike!.lastPatternSpikeAlertFiredAt).toBeUndefined() // no fire was attempted

    // Drop to baseline while still muted...
    const dropTick = now + 15 * 60 * 1000
    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'muted-spike').eq('day', dayNDaysAgo(dropTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 1 })
    })
    await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: dropTick })

    // ...then unmute...
    const unmuted = await asAdmin.mutation(api.failure_patterns.unmutePattern, { orgId: orgA, fingerprintHash: 'muted-spike' })
    expect(unmuted.muted).toBe(false)

    // ...and re-spike: a genuine fresh rising edge after unmuting fires.
    const respikeTick = dropTick + 15 * 60 * 1000
    await t.run(async (ctx) => {
      const todayRow = await ctx.db.query('failure_pattern_daily_counts').withIndex('by_org_fingerprint_day', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'muted-spike').eq('day', dayNDaysAgo(respikeTick, 0))).first()
      await ctx.db.patch(todayRow!._id, { count: 40 })
    })
    const respike = await t.mutation(internal.failure_patterns.assessPatternSpikesCron, { now: respikeTick })
    expect(respike.spiking).toBe(1)
    expect(respike.fired).toBe(1)

    events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Resolution lifecycle (docs/adr/006-failure-resolution.md) — acknowledge /
// resolve / reopen, and the regression guard inside
// recordFailurePatternOccurrence.
// ---------------------------------------------------------------------------

describe('acknowledgePattern / resolvePattern / reopenPattern', () => {
  it('member can acknowledge, which sets status + acknowledgedAt/By and records an audit event; viewer cannot', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'ack-me', class: 'tool_error', label: 'L', salientKey: 'a',
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'viewer_a', orgId: orgA, role: 'viewer', joinedAt: Date.now() })
    })

    const asViewer = t.withIdentity(identity('viewer', 'a'))
    await expect(asViewer.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: 'ack-me' })).rejects.toThrow()

    const asMember = t.withIdentity(identity('member', 'a'))
    const acked = await asMember.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: 'ack-me' })
    expect(acked!.status).toBe('acknowledged')
    expect(typeof acked!.acknowledgedAt).toBe('number')
    expect(acked!.acknowledgedByUserId).toBe('member_a')

    const auditRows = await t.run((ctx) => ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    expect(auditRows.some((r) => r.action === 'failure_pattern.acknowledged' && r.targetId === 'ack-me')).toBe(true)
  })

  it('member can resolve with a note/ref, which sets status/resolvedAt/By/resolutionNote/resolutionRef and records an audit event', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'resolve-me', class: 'tool_error', label: 'L', salientKey: 'a',
    })

    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, {
      orgId: orgA, fingerprintHash: 'resolve-me', note: 'fixed in v2', ref: 'https://example.com/pr/1',
    })
    expect(resolved!.status).toBe('resolved')
    expect(typeof resolved!.resolvedAt).toBe('number')
    expect(resolved!.resolvedByUserId).toBe('member_a')
    expect(resolved!.resolutionNote).toBe('fixed in v2')
    expect(resolved!.resolutionRef).toBe('https://example.com/pr/1')

    const auditRows = await t.run((ctx) => ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    expect(auditRows.some((r) => r.action === 'failure_pattern.resolved' && r.targetId === 'resolve-me')).toBe(true)
  })

  it('resolvePattern rejects a note/ref exceeding the bounded length', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'too-long', class: 'tool_error', label: 'L', salientKey: 'a',
    })
    const asMember = t.withIdentity(identity('member', 'a'))
    await expect(
      asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'too-long', note: 'x'.repeat(3000) }),
    ).rejects.toThrow()
    await expect(
      asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'too-long', ref: 'y'.repeat(3000) }),
    ).rejects.toThrow()
  })

  it('reopenPattern resets status to "open" and clears resolvedAt/regressedAt, keeping resolutionNote/Ref/resolvedByUserId as history', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'reopen-me', class: 'tool_error', label: 'L', salientKey: 'a',
    })
    const asMember = t.withIdentity(identity('member', 'a'))
    await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'reopen-me', note: 'thought it was fixed' })

    const reopened = await asMember.mutation(api.failure_patterns.reopenPattern, { orgId: orgA, fingerprintHash: 'reopen-me' })
    expect(reopened!.status).toBe('open')
    expect(reopened!.resolvedAt).toBeUndefined()
    expect(reopened!.regressedAt).toBeUndefined()
    // History kept, not erased:
    expect(reopened!.resolutionNote).toBe('thought it was fixed')
    expect(reopened!.resolvedByUserId).toBe('member_a')

    const auditRows = await t.run((ctx) => ctx.db.query('audit_log').withIndex('by_org', (q) => q.eq('orgId', orgA)).collect())
    expect(auditRows.some((r) => r.action === 'failure_pattern.reopened' && r.targetId === 'reopen-me')).toBe(true)
  })

  it('returns null (not a thrown error) for an unknown fingerprint, and for a fingerprint in a different org', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    const runB = await seedRun(t, orgB, projectB, agentB)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgB, runId: runB, agentId: agentB, fingerprintHash: 'org-b-only', class: 'tool_error', label: 'L', salientKey: 'a',
    })

    const asMemberA = t.withIdentity(identity('member', 'a'))
    expect(await asMemberA.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })).toBeNull()
    expect(await asMemberA.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })).toBeNull()
    expect(await asMemberA.mutation(api.failure_patterns.reopenPattern, { orgId: orgA, fingerprintHash: 'does-not-exist' })).toBeNull()
    // Cross-org: org A member cannot touch org B's fingerprint.
    expect(await asMemberA.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: 'org-b-only' })).toBeNull()

    const orgBPattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgB).eq('fingerprintHash', 'org-b-only')).first(),
    )
    expect(orgBPattern!.status).toBeUndefined() // untouched
  })
})

describe('regression guard — recordFailurePatternOccurrence auto-reopens a RESOLVED pattern and fires pattern_regressed', () => {
  /** Seeds a pattern_regressed alert_rule directly (bypassing createAlertRule's admin-auth — irrelevant to these firing tests). */
  async function createPatternRegressedRule(t: ReturnType<typeof convexTest>, orgId: any, enabled = true) {
    return await t.run(async (ctx) => {
      const now = Date.now()
      return await ctx.db.insert('alert_rules', {
        orgId, name: 'regressions', kind: 'pattern_regressed', channels: [{ type: 'webhook', target: 'https://example.com/hook' }],
        enabled, createdAt: now, updatedAt: now,
      })
    })
  }

  it('a new occurrence dated AFTER resolvedAt on a RESOLVED pattern auto-reopens it, stamps regressedAt, and fires exactly one pattern_regressed alert', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await createPatternRegressedRule(t, orgA)

    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: 'regress-me', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 1_000_000,
    })

    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'regress-me' })
    // Backdate resolvedAt directly so a later `occurredAt` unambiguously postdates it (the mutation itself stamps Date.now()).
    await t.run((ctx) => ctx.db.patch(resolved!._id, { resolvedAt: 2_000_000 }))

    const run2 = await seedRun(t, orgA, projectA, agentA)
    const result = await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: agentA, fingerprintHash: 'regress-me', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 3_000_000,
    })
    expect(result).toEqual({ recorded: true })

    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'regress-me')).first(),
    )
    expect(pattern!.status).toBe('open')
    expect(pattern!.regressedAt).toBe(3_000_000)

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(1)
    expect(events[0]!.patternFingerprintHash).toBe('regress-me')
    expect(events[0]!.metadata).toMatchObject({ fingerprintHash: 'regress-me', resolvedAt: 2_000_000, regressedAt: 3_000_000 })

    // IDEMPOTENCY: a THIRD occurrence, now that status is "open" again, must
    // NOT re-fire — the resolved -> open transition already happened.
    const run3 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run3, agentId: agentA, fingerprintHash: 'regress-me', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 4_000_000,
    })
    const eventsAfter = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(eventsAfter.length).toBe(1)
  })

  it('a new occurrence dated BEFORE/AT resolvedAt does NOT reopen the pattern (e.g. a late-arriving occurrence for an already-fixed failure)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: 'no-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 1_000_000,
    })
    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'no-regress' })
    await t.run((ctx) => ctx.db.patch(resolved!._id, { resolvedAt: 5_000_000 }))

    const run2 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: agentA, fingerprintHash: 'no-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 5_000_000, // exactly equal, not strictly after — not a regression
    })

    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-regress')).first(),
    )
    expect(pattern!.status).toBe('resolved')
    expect(pattern!.regressedAt).toBeUndefined()

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)
  })

  it('MUTE SUPPRESSION: a muted, resolved pattern still auto-reopens on regression, but fires NO alert', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await createPatternRegressedRule(t, orgA)
    await t.run(async (ctx) => {
      await ctx.db.insert('user_memberships', { clerkUserId: 'admin_a', orgId: orgA, role: 'admin', joinedAt: Date.now() })
    })

    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: 'muted-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 1_000_000,
    })
    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'muted-regress' })
    await t.run((ctx) => ctx.db.patch(resolved!._id, { resolvedAt: 2_000_000 }))

    const asAdmin = t.withIdentity(identity('admin', 'a'))
    await asAdmin.mutation(api.failure_patterns.mutePattern, { orgId: orgA, fingerprintHash: 'muted-regress' })

    const run2 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: agentA, fingerprintHash: 'muted-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 3_000_000,
    })

    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'muted-regress')).first(),
    )
    // Lifecycle unaffected by mute: still reopens + stamps regressedAt.
    expect(pattern!.status).toBe('open')
    expect(pattern!.regressedAt).toBe(3_000_000)

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)
  })

  it('fires no alert (but still reopens) when the org has no enabled pattern_regressed rule', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    // No pattern_regressed rule seeded.

    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: 'no-rule-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 1_000_000,
    })
    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'no-rule-regress' })
    await t.run((ctx) => ctx.db.patch(resolved!._id, { resolvedAt: 2_000_000 }))

    const run2 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: agentA, fingerprintHash: 'no-rule-regress', class: 'tool_error', label: 'L', salientKey: 'a',
      occurredAt: 3_000_000,
    })

    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'no-rule-regress')).first(),
    )
    expect(pattern!.status).toBe('open')
    expect(pattern!.regressedAt).toBe(3_000_000)

    const events = await t.run((ctx) => ctx.db.query('alert_events').withIndex('by_org_fired', (q) => q.eq('orgId', orgA)).collect())
    expect(events.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ADR-006 cycle 2 — resolution evidence ("prove the fix held").
// ---------------------------------------------------------------------------

describe('resolvePattern versionId validation', () => {
  /** Records one occurrence so a rollup (with an agent set) exists to resolve. */
  async function seedPattern(t: ReturnType<typeof convexTest>, orgId: any, projectId: any, agentId: any, hash: string, occurredAt = 1_000_000) {
    const runId = await seedRun(t, orgId, projectId, agentId)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId, runId, agentId, fingerprintHash: hash, class: 'tool_error', label: 'L', salientKey: 'a', occurredAt,
    })
    return runId
  }

  it('accepts a versionId that exists in the caller org AND belongs to an agent the pattern was observed on', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    await seedPattern(t, orgA, projectA, agentA, 'ok-version')

    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, {
      orgId: orgA, fingerprintHash: 'ok-version', versionId: versionA, note: 'bumped the retry budget',
    })
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolvedInVersionId).toBe(versionA)
    // Evidence snapshot is stamped alongside the resolution.
    expect(resolved!.resolvedAtOccurrenceCount).toBe(1)
    expect(typeof resolved!.resolvedAtRunCount).toBe('number')
  })

  it('REJECTS a cross-org versionId with INVALID_ARGUMENT and does not resolve the pattern', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, projectB, agentA, agentB } = await seedTwoOrgs(t)
    await seedPattern(t, orgA, projectA, agentA, 'cross-org-version')
    // A real agent_version, but in org B.
    const versionB = await t.run((ctx) => ctx.db.insert('agent_versions', { agentId: agentB, orgId: orgB, version: 'v1', createdAt: Date.now() }))

    const asMember = t.withIdentity(identity('member', 'a'))
    await expect(
      asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'cross-org-version', versionId: versionB }),
    ).rejects.toThrow(/INVALID_ARGUMENT/)

    // Never silently ignored: the pattern must remain UNRESOLVED.
    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'cross-org-version')).first(),
    )
    expect(pattern!.status).toBeUndefined()
    expect(pattern!.resolvedAt).toBeUndefined()
    expect(pattern!.resolvedInVersionId).toBeUndefined()
    void projectB
  })

  it('REJECTS a same-org versionId belonging to a DIFFERENT agent than the pattern was observed on', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedPattern(t, orgA, projectA, agentA, 'cross-agent-version')
    // A second agent in the SAME org, which this pattern has never been seen on.
    const otherVersion = await t.run(async (ctx) => {
      const otherAgent = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Other', slug: 'other', createdAt: Date.now(), updatedAt: Date.now() })
      return await ctx.db.insert('agent_versions', { agentId: otherAgent, orgId: orgA, version: 'v9', createdAt: Date.now() })
    })

    const asMember = t.withIdentity(identity('member', 'a'))
    await expect(
      asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'cross-agent-version', versionId: otherVersion }),
    ).rejects.toThrow(/INVALID_ARGUMENT/)

    const pattern = await t.run((ctx) =>
      ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'cross-agent-version')).first(),
    )
    expect(pattern!.status).toBeUndefined()
  })

  it('gives the SAME error message for cross-org and cross-agent — no existence oracle for another org\'s version ids', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectA, agentA, agentB } = await seedTwoOrgs(t)
    await seedPattern(t, orgA, projectA, agentA, 'same-message')
    const versionB = await t.run((ctx) => ctx.db.insert('agent_versions', { agentId: agentB, orgId: orgB, version: 'v1', createdAt: Date.now() }))
    const otherVersion = await t.run(async (ctx) => {
      const otherAgent = await ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Other', slug: 'other', createdAt: Date.now(), updatedAt: Date.now() })
      return await ctx.db.insert('agent_versions', { agentId: otherAgent, orgId: orgA, version: 'v9', createdAt: Date.now() })
    })

    const asMember = t.withIdentity(identity('member', 'a'))
    const messageOf = async (versionId: any) => {
      try {
        await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'same-message', versionId })
        return 'NO THROW'
      } catch (e: any) {
        return String(e.message).replace(/^.*(INVALID_ARGUMENT)/s, '$1').split('\n')[0]
      }
    }
    expect(await messageOf(versionB)).toBe(await messageOf(otherVersion))
  })

  it('resolves normally when versionId is omitted (the arg is optional, not required)', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    await seedPattern(t, orgA, projectA, agentA, 'no-version')
    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'no-version' })
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolvedInVersionId).toBeUndefined()
  })

  it('returns null (not an INVALID_ARGUMENT throw) for an unknown fingerprint, even with a bad versionId', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, agentB } = await seedTwoOrgs(t)
    const versionB = await t.run((ctx) => ctx.db.insert('agent_versions', { agentId: agentB, orgId: orgB, version: 'v1', createdAt: Date.now() }))
    const asMember = t.withIdentity(identity('member', 'a'))
    // The rollup lookup happens FIRST, so a bad versionId cannot be used to
    // probe whether a fingerprint exists in this org.
    expect(
      await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'nope', versionId: versionB }),
    ).toBeNull()
  })
})

describe('getPatternResolutionEvidence', () => {
  it('tracks exposure and recurrence counters across a resolve -> recur -> reopen -> resolve sequence', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))
    const hash = 'lifecycle'

    const record = async (occurredAt: number) => {
      const runId = await seedRun(t, orgA, projectA, agentA)
      await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
        orgId: orgA, runId, agentId: agentA, fingerprintHash: hash, class: 'tool_error', label: 'L', salientKey: 'a', occurredAt,
      })
    }

    // Two failures before anyone looks at it.
    await record(1_000_000)
    await record(1_100_000)

    // RESOLVE #1 — snapshot must capture count == 2.
    const r1 = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: hash, versionId: versionA })
    expect(r1!.resolvedAtOccurrenceCount).toBe(2)
    await t.run((ctx) => ctx.db.patch(r1!._id, { resolvedAt: 2_000_000 }))

    let evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    // Nothing has recurred yet -> the fix has held SO FAR.
    expect(evidence!.exposure!.recurrenceCount).toBe(0)
    expect(evidence!.exposure!.heldSoFar).toBe(true)
    expect(evidence!.exposure!.since).toBe(2_000_000)
    expect(evidence!.resolution!.resolvedInVersionId).toBe(versionA)
    expect(evidence!.resolution!.resolvedInVersion).toBe('v1')

    // RECUR — a new occurrence after resolvedAt auto-reopens (regression guard).
    await record(3_000_000)
    evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    expect(evidence!.pattern.status).toBe('open')
    expect(evidence!.pattern.regressedAt).toBe(3_000_000)
    // resolvedAt SURVIVES the auto-reopen, so the "it didn't hold" evidence stays computable.
    expect(evidence!.exposure!.recurrenceCount).toBe(1)
    expect(evidence!.exposure!.heldSoFar).toBe(false)

    // MANUAL REOPEN — clears resolvedAt, so there is no live resolution to evidence.
    await asMember.mutation(api.failure_patterns.reopenPattern, { orgId: orgA, fingerprintHash: hash })
    evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    expect(evidence!.resolution).toBeNull()
    expect(evidence!.exposure).toBeNull()

    // RESOLVE #2 — a NEW baseline snapshot at count == 3, so the recurrence
    // counter restarts from this resolution rather than double-counting the
    // failures the first resolution already accounted for.
    const r2 = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: hash })
    expect(r2!.resolvedAtOccurrenceCount).toBe(3)
    await t.run((ctx) => ctx.db.patch(r2!._id, { resolvedAt: 4_000_000 }))

    evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    expect(evidence!.exposure!.recurrenceCount).toBe(0)
    expect(evidence!.exposure!.heldSoFar).toBe(true)

    // And one more recurrence is counted against the SECOND resolution only.
    await record(5_000_000)
    evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    expect(evidence!.exposure!.recurrenceCount).toBe(1)
  })

  it('counts post-resolution run exposure across the pattern\'s affected agents only', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))

    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'exposure', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'exposure' })
    const resolvedAt = resolved!.resolvedAt!

    // Three runs on the affected agent AFTER resolution...
    const otherAgent = await t.run((ctx) =>
      ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Other', slug: 'other', createdAt: Date.now(), updatedAt: Date.now() }),
    )
    await t.run(async (ctx) => {
      for (let i = 1; i <= 3; i++) {
        await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: agentA, status: 'completed', startedAt: resolvedAt + i * 1000, metadata: {}, tags: [] })
      }
      // ...and two on an UNRELATED agent, which must NOT count as exposure.
      for (let i = 1; i <= 2; i++) {
        await ctx.db.insert('runs', { orgId: orgA, projectId: projectA, agentId: otherAgent, status: 'completed', startedAt: resolvedAt + i * 1000, metadata: {}, tags: [] })
      }
    })

    const evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: 'exposure' })
    expect(evidence!.exposure!.runCount).toBe(3)
    expect(evidence!.exposure!.runCountTruncated).toBe(false)
    expect(evidence!.exposure!.agentIds).toEqual([agentA])
    // heldSoFar is true, and runCount is what makes that meaningful evidence.
    expect(evidence!.exposure!.heldSoFar).toBe(true)
  })

  it('returns the lifecycle transition history from the append-only audit log, oldest-first, including the automatic regression', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))
    const hash = 'transitions'

    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: hash, class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })

    await asMember.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: hash })
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: hash })
    await t.run((ctx) => ctx.db.patch(resolved!._id, { resolvedAt: 2_000_000 }))

    const run2 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: agentA, fingerprintHash: hash, class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 3_000_000,
    })

    const evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: hash })
    expect(evidence!.transitions.map((tr: any) => tr.action)).toEqual([
      'failure_pattern.acknowledged',
      'failure_pattern.resolved',
      'failure_pattern.regressed',
    ])
    // The automatic reopen is attributed to the system, not to a human.
    const regressed = evidence!.transitions[2]!
    expect(regressed.actorClerkUserId).toBe('system')
    expect(regressed.metadata).toMatchObject({ resolvedAt: 2_000_000, regressedAt: 3_000_000 })
  })

  it('is org-scoped: a member of org A gets null for org B\'s fingerprint, never an error or a leak', async () => {
    const t = convexTest(schema, modules)
    const { orgA, orgB, projectB, agentB } = await seedTwoOrgs(t)
    const runB = await seedRun(t, orgB, projectB, agentB)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgB, runId: runB, agentId: agentB, fingerprintHash: 'org-b-secret', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })

    const asMemberA = t.withIdentity(identity('member', 'a'))
    expect(await asMemberA.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: 'org-b-secret' })).toBeNull()
    // And org A cannot pass org B's orgId either.
    await expect(
      asMemberA.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgB, fingerprintHash: 'org-b-secret' }),
    ).rejects.toThrow()
  })

  it('reports no resolution/exposure for a pattern that has never been resolved, but still returns its transitions', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const asMember = t.withIdentity(identity('member', 'a'))
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'never-resolved', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })
    await asMember.mutation(api.failure_patterns.acknowledgePattern, { orgId: orgA, fingerprintHash: 'never-resolved' })

    const evidence = await asMember.query(api.failure_patterns.getPatternResolutionEvidence, { orgId: orgA, fingerprintHash: 'never-resolved' })
    expect(evidence!.resolution).toBeNull()
    expect(evidence!.exposure).toBeNull()
    expect(evidence!.transitions.map((tr: any) => tr.action)).toEqual(['failure_pattern.acknowledged'])
  })
})

describe('affectedAgentIds maintenance (ADR-006 cycle 2)', () => {
  it('accumulates the deduped agent set across occurrences, and self-heals a pre-cycle rollup that lacks the field', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA } = await seedTwoOrgs(t)
    const secondAgent = await t.run((ctx) =>
      ctx.db.insert('agents', { orgId: orgA, projectId: projectA, name: 'Second', slug: 'second', createdAt: Date.now(), updatedAt: Date.now() }),
    )

    const run1 = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run1, agentId: agentA, fingerprintHash: 'agents', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })

    const find = async () =>
      await t.run((ctx) =>
        ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'agents')).first(),
      )
    expect((await find())!.affectedAgentIds).toEqual([agentA])

    // Simulate a PRE-CYCLE row by stripping the field, then record another
    // occurrence: the upsert must repopulate it without any backfill.
    const rollupId = (await find())!._id
    await t.run((ctx) => ctx.db.patch(rollupId, { affectedAgentIds: undefined }))
    const run2 = await seedRun(t, orgA, projectA, secondAgent)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run2, agentId: secondAgent, fingerprintHash: 'agents', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 2_000_000,
    })
    expect((await find())!.affectedAgentIds).toEqual([secondAgent])

    // A repeat of an already-known agent dedupes rather than appending.
    const run3 = await seedRun(t, orgA, projectA, secondAgent)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId: run3, agentId: secondAgent, fingerprintHash: 'agents', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 3_000_000,
    })
    expect((await find())!.affectedAgentIds).toEqual([secondAgent])
  })

  it('falls back to deriving the agent set from occurrences when the rollup predates affectedAgentIds', async () => {
    const t = convexTest(schema, modules)
    const { orgA, projectA, agentA, versionA } = await seedTwoOrgs(t)
    const runId = await seedRun(t, orgA, projectA, agentA)
    await t.mutation(internal.failure_patterns.recordFailurePatternOccurrence, {
      orgId: orgA, runId, agentId: agentA, fingerprintHash: 'legacy', class: 'tool_error', label: 'L', salientKey: 'a', occurredAt: 1_000_000,
    })
    // Strip the field to emulate a rollup written before this cycle.
    await t.run(async (ctx) => {
      const p = await ctx.db.query('failure_patterns').withIndex('by_org_fingerprint', (q) => q.eq('orgId', orgA).eq('fingerprintHash', 'legacy')).first()
      await ctx.db.patch(p!._id, { affectedAgentIds: undefined })
    })

    // Cross-agent validation must still ACCEPT the legitimate version, proving
    // the occurrence-derived fallback ran rather than rejecting everything.
    const asMember = t.withIdentity(identity('member', 'a'))
    const resolved = await asMember.mutation(api.failure_patterns.resolvePattern, { orgId: orgA, fingerprintHash: 'legacy', versionId: versionA })
    expect(resolved!.resolvedInVersionId).toBe(versionA)
  })
})
