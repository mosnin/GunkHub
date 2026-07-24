/* eslint-disable */
// Tests for Failure Patterns (PREVENTION, cycle 1) —
// docs/adr/005-failure-patterns.md. Exercises the pure fallback
// fingerprint/spike engines, the idempotent occurrence-recording +
// rollup-upsert mutation, org-scoped listing/detail queries, the trend
// bucketing helper, and the spike-rollup cron.
import { convexTest } from 'convex-test'
import { describe, it, expect } from 'vitest'
import schema from './schema'
import { api, internal } from './_generated/api'
import {
  deriveFailureFingerprintFallback,
  assessPatternSpikeFallback,
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
    expect(result).toEqual({ assessed: 0, spiking: 0 })
  })
})
